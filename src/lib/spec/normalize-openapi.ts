// Normalize OpenAPI specs exported by AWS to satisfy validator requirements
// that the AWS export pipeline does not enforce.
//
// It handles two independent concerns:
//
//   "Every operation must have a unique operationId" -- OpenAPI 3.x spec
//
// AWS API Gateway populates `operationId` from the integration request's
// `OperationName`, which is often the bare HTTP method (`get`, `update`,
// `post`) or omitted entirely. Multiple operations across paths therefore
// collide, and downstream validators (including the Postman bootstrap
// action's OpenAPI loader) reject the document with:
//
//   CONTRACT_SPEC_VALIDATION_FAILED: The operationId `update` is
//   duplicated and must be made unique.
//
// We rewrite the duplicate (and synthesize ones that were missing) so the
// committed spec is a valid OpenAPI document with no behaviour change for
// runtime callers.
//
// Algorithm:
//   1. Walk paths in insertion order, then methods in OpenAPI canonical
//      order. The FIRST occurrence of an operationId wins -- we never
//      rename it. This keeps existing references stable.
//   2. Subsequent collisions are renamed to `<originalId>_<slugifiedPath>`.
//      If that suffix itself collides we append `_2`, `_3`, ... until unique.
//   3. Missing operationIds are synthesized as `<method><PascalPath>` so
//      generated collections still get human-readable request names.
//
// We use `yaml`'s document-level API so quoting, ordering, and the bits of
// formatting AWS emits are preserved -- the only diff is the operationId
// values themselves. It also records whether the exported document contains
// enough request/response schema detail for downstream body-contract checks.

import { isMap, isScalar, parseDocument, type Document, type Scalar, type YAMLMap } from 'yaml';

export interface OpenApiContractAudit {
  schemaVersion: 1;
  status: 'schema-complete' | 'schema-incomplete';
  operationCount: number;
  responseCount: number;
  responsesWithoutContent: number;
  responseMediaTypesWithoutSchema: number;
  requestMediaTypesWithoutSchema: number;
  defaultOnlyOperationCount: number;
}

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

export interface OperationIdRename {
  path: string;
  method: string;
  original: string | null;
  renamed: string;
}

export interface NormalizeOpenApiResult {
  content: string;
  renamed: OperationIdRename[];
  /** True if the document was recognized as an OpenAPI spec and walked. */
  normalized: boolean;
  openapiContractAudit?: OpenApiContractAudit;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function resolveLocalObject(root: JsonRecord, value: unknown): JsonRecord | undefined {
  let current = asRecord(value);
  const seen = new Set<JsonRecord>();
  while (current && typeof current.$ref === 'string') {
    if (seen.has(current) || !current.$ref.startsWith('#/')) return undefined;
    seen.add(current);
    let resolved: unknown = root;
    for (const rawSegment of current.$ref.slice(2).split('/')) {
      const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
      resolved = asRecord(resolved)?.[segment];
    }
    current = asRecord(resolved);
  }
  return current;
}

function responseIsStaticallyBodyless(method: string, status: string): boolean {
  const normalized = status.toUpperCase();
  return method === 'head'
    || normalized === '1XX'
    || /^1[0-9][0-9]$/.test(normalized)
    || normalized === '204'
    || normalized === '205'
    || normalized === '304';
}

function isResponseDeclarationKey(value: string): boolean {
  return value.toLowerCase() === 'default' || /^[1-5](?:[0-9]{2}|xx)$/i.test(value);
}

export function auditOpenApiContractCoverage(value: unknown): OpenApiContractAudit | undefined {
  const root = asRecord(value);
  const paths = asRecord(root?.paths);
  if (!root || typeof root.openapi !== 'string' || !/^3\./.test(root.openapi) || !paths) return undefined;

  const audit: OpenApiContractAudit = {
    schemaVersion: 1,
    status: 'schema-complete',
    operationCount: 0,
    responseCount: 0,
    responsesWithoutContent: 0,
    responseMediaTypesWithoutSchema: 0,
    requestMediaTypesWithoutSchema: 0,
    defaultOnlyOperationCount: 0
  };

  for (const rawPathItem of Object.values(paths)) {
    const pathItem = resolveLocalObject(root, rawPathItem);
    if (!pathItem) return undefined;
    for (const [rawMethod, rawOperation] of Object.entries(pathItem)) {
      const method = rawMethod.toLowerCase();
      if (!HTTP_METHODS.has(method)) continue;
      const operation = resolveLocalObject(root, rawOperation);
      if (!operation) return undefined;
      audit.operationCount += 1;

      const requestBody = operation.requestBody === undefined
        ? undefined
        : resolveLocalObject(root, operation.requestBody);
      if (operation.requestBody !== undefined && !requestBody) return undefined;
      const requestContent = asRecord(requestBody?.content);
      for (const rawMedia of Object.values(requestContent ?? {})) {
        const media = asRecord(rawMedia);
        if (!media) return undefined;
        if (media.schema === undefined) audit.requestMediaTypesWithoutSchema += 1;
      }

      const responses = asRecord(operation.responses);
      if (!responses) return undefined;
      const responseKeys = Object.keys(responses).filter(isResponseDeclarationKey);
      if (responseKeys.length === 0) return undefined;
      if (responseKeys.some((status) => status.toLowerCase() === 'default') && responseKeys.length === 1) {
        audit.defaultOnlyOperationCount += 1;
      }
      for (const status of responseKeys) {
        const rawResponse = responses[status];
        audit.responseCount += 1;
        const response = resolveLocalObject(root, rawResponse);
        if (!response) return undefined;
        const content = asRecord(response?.content);
        if ((!content || Object.keys(content).length === 0) && !responseIsStaticallyBodyless(method, status)) {
          audit.responsesWithoutContent += 1;
        }
        for (const rawMedia of Object.values(content ?? {})) {
          const media = asRecord(rawMedia);
          if (!media) return undefined;
          if (media.schema === undefined) audit.responseMediaTypesWithoutSchema += 1;
        }
      }
    }
  }

  if (
    audit.responsesWithoutContent > 0
    || audit.responseMediaTypesWithoutSchema > 0
    || audit.requestMediaTypesWithoutSchema > 0
  ) {
    audit.status = 'schema-incomplete';
  }
  return audit;
}

export function formatOpenApiContractAuditWarning(audit: OpenApiContractAudit): string | undefined {
  if (audit.status !== 'schema-incomplete') return undefined;
  return 'AWS_OPENAPI_CONTRACT_INCOMPLETE: API Gateway export has '
    + `${audit.responsesWithoutContent} response declaration(s) without content, `
    + `${audit.responseMediaTypesWithoutSchema} response media declaration(s) without schema, and `
    + `${audit.requestMediaTypesWithoutSchema} request media declaration(s) without schema. `
    + 'Bootstrap keeps route and status checks but skips undocumented body assertions; define API Gateway models or enrich the OpenAPI before treating body-schema tests as strict CI gates.';
}

/**
 * Normalize an OpenAPI document by deduplicating and synthesizing
 * `operationId` values. Returns the (possibly-rewritten) YAML content
 * along with a list of rewrites for logging.
 *
 * If the input is not a recognizable OpenAPI YAML document the original
 * content is returned unchanged with `normalized: false`. Failures parsing
 * the document are treated the same way -- we never throw, because this
 * runs in the export hot path and a broken spec is the bootstrap action's
 * problem to surface, not ours.
 */
export function normalizeOpenApiYaml(content: string): NormalizeOpenApiResult {
  const passthrough: NormalizeOpenApiResult = { content, renamed: [], normalized: false };

  let doc: Document;
  try {
    doc = parseDocument(content, { prettyErrors: false });
  } catch {
    return passthrough;
  }
  if (doc.errors.length > 0) return passthrough;
  if (!isMap(doc.contents)) return passthrough;

  const paths = doc.get('paths', true);
  if (!isMap(paths)) return passthrough;

  const seen = new Set<string>();
  const renamed: OperationIdRename[] = [];

  for (const pathPair of paths.items) {
    const pathKey = scalarString(pathPair.key);
    if (pathKey === undefined) continue;
    const pathItem = pathPair.value;
    if (!isMap(pathItem)) continue;

    for (const methodPair of pathItem.items) {
      const method = scalarString(methodPair.key);
      if (method === undefined) continue;
      const methodLower = method.toLowerCase();
      if (!HTTP_METHODS.has(methodLower)) continue;
      const operation = methodPair.value;
      if (!isMap(operation)) continue;

      const opIdNode = operation.get('operationId', true);
      const originalId = isScalar(opIdNode) && typeof opIdNode.value === 'string' ? opIdNode.value : null;
      const base = originalId && originalId.trim().length > 0
        ? originalId
        : synthesizeOperationId(methodLower, pathKey);

      let finalId = base;
      if (seen.has(base)) {
        const suffix = slugifyPath(pathKey);
        let candidate = suffix.length > 0 ? `${base}_${suffix}` : `${base}_${methodLower}`;
        let counter = 2;
        while (seen.has(candidate)) {
          candidate = suffix.length > 0
            ? `${base}_${suffix}_${counter}`
            : `${base}_${methodLower}_${counter}`;
          counter += 1;
        }
        finalId = candidate;
      }

      seen.add(finalId);
      if (finalId !== originalId) {
        renamed.push({ path: pathKey, method: methodLower, original: originalId, renamed: finalId });
        setOperationId(operation, finalId);
      }
    }
  }

  const openapiContractAudit = auditOpenApiContractCoverage(doc.toJS());
  if (renamed.length === 0) {
    return { content, renamed: [], normalized: true, openapiContractAudit };
  }

  return { content: String(doc), renamed, normalized: true, openapiContractAudit };
}

function scalarString(node: unknown): string | undefined {
  if (isScalar(node) && typeof node.value === 'string') return node.value;
  if (typeof node === 'string') return node;
  return undefined;
}

function setOperationId(operation: YAMLMap, value: string): void {
  const existing = operation.get('operationId', true);
  if (isScalar(existing)) {
    (existing as Scalar).value = value;
    return;
  }
  operation.set('operationId', value);
}

function synthesizeOperationId(method: string, pathKey: string): string {
  const pascal = pathKey
    .split('/')
    .filter((segment) => segment.length > 0)
    .map(stripTemplate)
    .map(toPascalCase)
    .join('');
  return pascal.length > 0 ? `${method}${pascal}` : method;
}

function stripTemplate(segment: string): string {
  // `{orderId}` -> `OrderId`. Keep the identifier, drop the braces so
  // synthesized ids stay readable.
  if (segment.startsWith('{') && segment.endsWith('}')) {
    return segment.slice(1, -1);
  }
  return segment;
}

function toPascalCase(segment: string): string {
  const cleaned = segment.replace(/[^A-Za-z0-9]+/g, ' ').trim();
  if (cleaned.length === 0) return '';
  return cleaned
    .split(/\s+/)
    .map((word) => (word.length === 0 ? '' : word[0].toUpperCase() + word.slice(1)))
    .join('');
}

function slugifyPath(pathKey: string): string {
  return pathKey
    .split('/')
    .filter((segment) => segment.length > 0)
    .map(stripTemplate)
    .map((segment) => segment.replace(/[^A-Za-z0-9]+/g, '_'))
    .filter((segment) => segment.length > 0)
    .join('_');
}
