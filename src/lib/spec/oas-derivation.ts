import { parse } from 'yaml';

import type { ContractClass, SpecFormat } from '../../contracts.js';

export interface OpenApiDerivationInput {
  content: string;
  format: SpecFormat;
  title?: string;
}

export interface OpenApiDerivationResult {
  content: string;
  format: 'openapi-json';
  version: '3.0.3' | '3.1.0';
  completeness: 'full' | 'partial';
  evidence: string[];
}

/**
 * Declared fidelity from a provider or earlier resolution step. Derivation may
 * downgrade completeness but must never upgrade `partial` or `reconstructed`
 * inputs to `full`.
 */
export interface DeclaredFidelity {
  completeness?: 'full' | 'partial';
  contractClass?: ContractClass;
}

/**
 * Clamp derived OpenAPI completeness so provider-declared `partial` or
 * `reconstructed` fidelity is never upgraded to `full`. Pure helper for later
 * runtime wiring; does not mutate the input object.
 */
export function applyDeclaredFidelity(
  result: OpenApiDerivationResult,
  declared?: DeclaredFidelity
): OpenApiDerivationResult {
  if (!declared) return result;

  const mustStayPartial =
    declared.completeness === 'partial'
    || declared.contractClass === 'partial'
    || declared.contractClass === 'reconstructed'
    || declared.contractClass === 'association-only'
    || declared.contractClass === 'unsupported';

  if (!mustStayPartial || result.completeness === 'partial') {
    return result;
  }

  const reason =
    declared.completeness === 'partial'
      ? 'Provider declared this export partial (synthesized from a non-spec surface)'
      : `Contract class ${declared.contractClass} forbids upgrading derived OpenAPI completeness to full`;

  return {
    ...result,
    completeness: 'partial',
    evidence: [...result.evidence, reason]
  };
}

interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string; description?: string };
  paths: Record<string, unknown>;
  components?: Record<string, unknown>;
}

interface ParsedDocument {
  openapi?: unknown;
  swagger?: unknown;
  info?: { title?: unknown; version?: unknown; description?: unknown };
  paths?: Record<string, unknown>;
  basePath?: unknown;
  definitions?: Record<string, unknown>;
  components?: Record<string, unknown>;
}

function parseDocument(content: string): ParsedDocument | undefined {
  try {
    const parsed = content.trim().startsWith('{') ? JSON.parse(content) : parse(content);
    return parsed && typeof parsed === 'object' ? (parsed as ParsedDocument) : undefined;
  } catch {
    return undefined;
  }
}

function openApiVersion(document: ParsedDocument): '3.0.3' | '3.1.0' | undefined {
  const raw = typeof document.openapi === 'string' ? document.openapi : '';
  if (raw.startsWith('3.1')) return '3.1.0';
  if (raw.startsWith('3.')) return '3.0.3';
  return undefined;
}

/**
 * Derive an OpenAPI 3.x JSON document from a discovered specification.
 *
 * Azure v1 sources are already OpenAPI/Swagger:
 *  - OpenAPI 3.x passes through untouched (completeness full).
 *  - Swagger 2.0 is upconverted structurally to OpenAPI 3.0 (completeness partial:
 *    parameter/response media conversion is intentionally shallow).
 *  - Anything unparseable yields undefined; the caller then omits derived outputs.
 */
export function deriveOpenApiDocument(input: OpenApiDerivationInput): OpenApiDerivationResult | undefined {
  if (input.format === 'graphql-sdl') {
    const title = input.title?.trim() || 'Discovered GraphQL API';
    const document: OpenApiDocument = {
      openapi: '3.0.3',
      info: { title, version: '1.0.0' },
      paths: {
        '/graphql': {
          post: {
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['query'],
                    properties: {
                      query: { type: 'string' },
                      operationName: { type: 'string', nullable: true },
                      variables: { type: 'object', additionalProperties: true }
                    }
                  }
                }
              }
            },
            responses: { '200': { description: 'GraphQL response' } }
          }
        }
      }
    };
    return {
      content: `${JSON.stringify(document, null, 2)}\n`,
      format: 'openapi-json',
      version: '3.0.3',
      completeness: 'partial',
      evidence: ['Synthesized partial OpenAPI 3.0 GraphQL POST shell from GraphQL SDL']
    };
  }
  const parsed = parseDocument(input.content);
  if (!parsed) {
    return undefined;
  }

  const version = openApiVersion(parsed);
  if (version) {
    const isJson = input.content.trim().startsWith('{');
    return {
      content: isJson ? input.content : `${JSON.stringify(parsed, null, 2)}\n`,
      format: 'openapi-json',
      version,
      completeness: 'full',
      evidence: isJson
        ? ['Source artifact is already OpenAPI 3.x JSON']
        : ['Re-serialized OpenAPI 3.x YAML source as JSON']
    };
  }

  if (typeof parsed.swagger === 'string' && parsed.swagger.startsWith('2')) {
    const title = input.title?.trim() || (typeof parsed.info?.title === 'string' ? parsed.info.title : '') || 'Discovered API';
    return {
      content: `${JSON.stringify(swaggerToOpenApi(parsed, title), null, 2)}\n`,
      format: 'openapi-json',
      version: '3.0.3',
      completeness: 'partial',
      evidence: ['Converted Swagger 2.0 document to OpenAPI 3.0 structurally']
    };
  }

  return undefined;
}

function swaggerToOpenApi(parsed: ParsedDocument, title: string): OpenApiDocument {
  const version = typeof parsed.info?.version === 'string' ? parsed.info.version : '1.0.0';
  const description = typeof parsed.info?.description === 'string' ? parsed.info.description : undefined;
  const document: OpenApiDocument = {
    openapi: '3.0.3',
    info: {
      title,
      version,
      ...(description ? { description } : {})
    },
    paths: parsed.paths ?? {}
  };
  if (parsed.definitions && typeof parsed.definitions === 'object') {
    document.components = { schemas: parsed.definitions };
  }
  return document;
}
