import { parse } from 'yaml';

import type { SpecFormat } from '../../contracts.js';
import { parseAndValidateOpenApi, type ValidatedOpenApi } from './validate-openapi.js';

/** Bound content inspection to avoid unbounded YAML/XML walks on huge files. */
const MAX_INSPECT_CHARS = 256_000;

export type NativeSpecKind =
  | 'openapi'
  | 'asyncapi'
  | 'wsdl'
  | 'wadl'
  | 'xsd'
  | 'protobuf'
  | 'graphql-sdl'
  | 'mcp-json';

export type NativeSerialization = 'json' | 'yaml' | 'xml' | 'text';

export interface NativeFormatDetection {
  kind: NativeSpecKind;
  format: SpecFormat;
  serialization: NativeSerialization;
  version?: ValidatedOpenApi['version'] | string;
}

export interface NativeValidationResult extends NativeFormatDetection {
  /** Relative XSD schemaLocation/include references found in WSDL/XSD (not fetched). */
  xsdReferences?: string[];
  document?: Record<string, unknown>;
}

function bound(content: string): string {
  return content.length > MAX_INSPECT_CHARS ? content.slice(0, MAX_INSPECT_CHARS) : content;
}

function trimContent(content: string): string {
  return bound(content).trim();
}

function looksLikeJson(trimmed: string): boolean {
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

function looksLikeXml(trimmed: string): boolean {
  return trimmed.startsWith('<');
}

function parseObjectDocument(content: string): { document: Record<string, unknown>; isJson: boolean } | undefined {
  const trimmed = trimContent(content);
  if (!trimmed) return undefined;
  const isJson = looksLikeJson(trimmed);
  try {
    const parsed = isJson ? JSON.parse(trimmed) : parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return { document: parsed as Record<string, unknown>, isJson };
  } catch {
    return undefined;
  }
}

function openApiVersionOf(document: Record<string, unknown>): ValidatedOpenApi['version'] | undefined {
  const swagger = typeof document.swagger === 'string' ? document.swagger : '';
  const openapi = typeof document.openapi === 'string' ? document.openapi : '';
  if (swagger.startsWith('2')) return 'swagger-2.0';
  if (openapi.startsWith('3.1')) return 'openapi-3.1';
  if (openapi.startsWith('3.')) return 'openapi-3.0';
  return undefined;
}

function isXmlWhitespace(char: string | undefined): boolean {
  return char === ' ' || char === '\t' || char === '\r' || char === '\n';
}

function skipXmlWhitespace(xml: string, start: number): number {
  let index = start;
  while (index < xml.length && isXmlWhitespace(xml[index])) index += 1;
  return index;
}

function startsWithIgnoreCase(value: string, search: string, position: number): boolean {
  if (position + search.length > value.length) return false;
  return value.slice(position, position + search.length).toLowerCase() === search.toLowerCase();
}

function skipDoctype(xml: string, start: number): number {
  let quote: '"' | "'" | undefined;
  let subsetDepth = 0;
  for (let index = start + '<!DOCTYPE'.length; index < xml.length; index += 1) {
    const char = xml[index];
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '[') {
      subsetDepth += 1;
    } else if (char === ']' && subsetDepth > 0) {
      subsetDepth -= 1;
    } else if (char === '>' && subsetDepth === 0) {
      return index + 1;
    }
  }
  return xml.length;
}

function skipXmlPreamble(xml: string): number {
  let index = skipXmlWhitespace(xml, 0);
  while (index < xml.length) {
    let next = index;
    if (xml.startsWith('<?', index)) {
      const close = xml.indexOf('?>', index + 2);
      next = close === -1 ? xml.length : close + 2;
    } else if (xml.startsWith('<!--', index)) {
      const close = xml.indexOf('-->', index + 4);
      next = close === -1 ? xml.length : close + 3;
    } else if (startsWithIgnoreCase(xml, '<!DOCTYPE', index)) {
      next = skipDoctype(xml, index);
    }
    if (next === index) break;
    index = skipXmlWhitespace(xml, next);
  }
  return index;
}

function isXmlNameStart(char: string | undefined): boolean {
  if (!char) return false;
  const code = char.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || char === '_';
}

function isXmlNameChar(char: string | undefined): boolean {
  if (isXmlNameStart(char)) return true;
  if (!char) return false;
  const code = char.charCodeAt(0);
  return (code >= 48 && code <= 57) || char === '.' || char === '-';
}

function scanXmlNameSegment(xml: string, start: number): number {
  if (!isXmlNameStart(xml[start])) return start;
  let index = start + 1;
  while (index < xml.length && isXmlNameChar(xml[index])) index += 1;
  return index;
}

function xmlRootInfo(xml: string): { localName: string; qualified: string; head: string } | undefined {
  const body = trimContent(xml);
  let index = skipXmlPreamble(body);
  if (body[index] !== '<') return undefined;
  index = skipXmlWhitespace(body, index + 1);
  const nameStart = index;
  index = scanXmlNameSegment(body, index);
  if (index === nameStart) return undefined;
  if (body[index] === ':') {
    const localStart = index + 1;
    index = scanXmlNameSegment(body, localStart);
    if (index === localStart) return undefined;
  }
  if (body[index] && !isXmlWhitespace(body[index]) && body[index] !== '/' && body[index] !== '>') {
    return undefined;
  }
  const qualified = body.slice(nameStart, index);
  let quote: '"' | "'" | undefined;
  let close = index;
  for (; close < body.length; close += 1) {
    const char = body[close];
    if (quote) {
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      break;
    }
  }
  if (close === body.length) return undefined;
  const localName = (qualified.includes(':') ? qualified.split(':').pop()! : qualified).toLowerCase();
  const head = body.slice(nameStart, close).toLowerCase();
  return { localName, qualified, head };
}

function isWsdlXml(xml: string): boolean {
  const root = xmlRootInfo(xml);
  if (!root) return false;
  if (root.localName !== 'definitions' && root.localName !== 'description') return false;
  return /wsdl/i.test(root.head) || /schemas\.xmlsoap\.org\/wsdl|www\.w3\.org\/ns\/wsdl/i.test(trimContent(xml));
}

function isWadlXml(xml: string): boolean {
  const root = xmlRootInfo(xml);
  if (!root || root.localName !== 'application') return false;
  return /wadl/i.test(root.head) || /wadl\.dev\.java\.net|www\.w3\.org\/ns\/wadl/i.test(trimContent(xml));
}

function isXsdXml(xml: string): boolean {
  const root = xmlRootInfo(xml);
  if (!root || root.localName !== 'schema') return false;
  return /xmlschema/i.test(root.head) || /www\.w3\.org\/2001\/xmlschema/i.test(trimContent(xml));
}

function skipTextWhitespace(value: string, start: number): number {
  let index = start;
  while (index < value.length) {
    const char = value[index];
    if (char !== ' ' && char !== '\t' && char !== '\r' && char !== '\n' && char !== '\f' && char !== '\v') {
      break;
    }
    index += 1;
  }
  return index;
}

function keywordEnd(value: string, keyword: string, start: number): number | undefined {
  if (!value.startsWith(keyword, start)) return undefined;
  const end = start + keyword.length;
  const next = value[end];
  if (next && (/[A-Za-z0-9_]/).test(next)) return undefined;
  return end;
}

function graphqlDefinitionAt(value: string, start: number): boolean {
  let index = start;
  const extendEnd = keywordEnd(value, 'extend', index);
  if (extendEnd !== undefined && isXmlWhitespace(value[extendEnd])) {
    index = skipTextWhitespace(value, extendEnd);
  }

  for (const keyword of ['type', 'interface', 'enum', 'union', 'scalar', 'input']) {
    const end = keywordEnd(value, keyword, index);
    if (end === undefined || !isXmlWhitespace(value[end])) continue;
    const nameStart = skipTextWhitespace(value, end);
    return isXmlNameStart(value[nameStart]);
  }

  const schemaEnd = keywordEnd(value, 'schema', index);
  if (schemaEnd !== undefined && value[skipTextWhitespace(value, schemaEnd)] === '{') return true;
  const directiveEnd = keywordEnd(value, 'directive', index);
  return directiveEnd !== undefined &&
    isXmlWhitespace(value[directiveEnd]) &&
    value[skipTextWhitespace(value, directiveEnd)] === '@';
}

function hasGraphqlDefinition(value: string): boolean {
  let lineStart = 0;
  while (lineStart < value.length) {
    let start = skipTextWhitespace(value, lineStart);
    if (value.startsWith('"""', start)) {
      const descriptionEnd = value.indexOf('"""', start + 3);
      if (descriptionEnd === -1) return false;
      start = skipTextWhitespace(value, descriptionEnd + 3);
    }
    if (graphqlDefinitionAt(value, start)) return true;
    const nextLine = value.indexOf('\n', Math.max(start, lineStart));
    if (nextLine === -1) return false;
    lineStart = nextLine + 1;
  }
  return false;
}

function hasApiDocumentMarker(value: string): boolean {
  let lineStart = 0;
  while (lineStart < value.length) {
    const start = skipTextWhitespace(value, lineStart);
    for (const keyword of ['openapi', 'swagger', 'asyncapi']) {
      const end = keywordEnd(value, keyword, start);
      if (end !== undefined && value[skipTextWhitespace(value, end)] === ':') return true;
    }
    const nextLine = value.indexOf('\n', Math.max(start, lineStart));
    if (nextLine === -1) return false;
    lineStart = nextLine + 1;
  }
  return false;
}

function someTrimmedLine(value: string, predicate: (line: string) => boolean): boolean {
  let lineStart = 0;
  while (lineStart <= value.length) {
    const lineEnd = value.indexOf('\n', lineStart);
    const end = lineEnd === -1 ? value.length : lineEnd;
    if (predicate(value.slice(lineStart, end).trim())) return true;
    if (lineEnd === -1) return false;
    lineStart = lineEnd + 1;
  }
  return false;
}

function isGraphqlSdl(content: string): boolean {
  const trimmed = trimContent(content);
  if (!trimmed || looksLikeJson(trimmed) || looksLikeXml(trimmed)) return false;
  // Reject YAML mapping keys (`type:`, `enum:`) that would otherwise match bare keywords.
  if (hasApiDocumentMarker(trimmed)) return false;
  return hasGraphqlDefinition(trimmed);
}

/**
 * Bootstrap-aligned protobuf identity (content path):
 * `syntax = "proto[23]";` or a `service ... { rpc ... }` block.
 * Bare `message` definitions alone are not enough — bootstrap would not classify
 * them as grpc without a `.proto` filename hint.
 */
function isProtobufSource(content: string): boolean {
  const trimmed = trimContent(content);
  if (!trimmed || looksLikeJson(trimmed) || looksLikeXml(trimmed)) return false;
  if (hasApiDocumentMarker(trimmed)) return false;
  if (someTrimmedLine(trimmed, (line) => /^syntax\s*=\s*["']proto[23]["']\s*;/.test(line))) return true;
  if (/\bservice\s+[A-Za-z_]\w*\s*\{[\s\S]*\brpc\b/.test(trimmed)) return true;
  return false;
}

/** Bootstrap treats an unambiguous `.proto` extension as grpc even for message-only IDL. */
function isProtobufByFileNameHint(content: string, fileName?: string): boolean {
  if (!fileName || !fileName.toLowerCase().endsWith('.proto')) return false;
  const trimmed = trimContent(content);
  if (!trimmed || looksLikeJson(trimmed) || looksLikeXml(trimmed)) return false;
  return (
    isProtobufSource(trimmed) ||
    /\bmessage\s+[A-Za-z_]\w*\s*\{/.test(trimmed) ||
    someTrimmedLine(trimmed, (line) => /^package\s+[\w.]+/.test(line))
  );
}

function extractXsdReferences(xml: string): string[] {
  const refs: string[] = [];
  const pattern = /\b(?:schemaLocation|itemSchemaLocation)\s*=\s*["']([^"']+)["']/gi;
  const text = trimContent(xml);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const value = match[1]?.trim();
    if (value) refs.push(value);
  }
  return [...new Set(refs)];
}

function asyncApiVersionOf(document: Record<string, unknown>): string | undefined {
  return typeof document.asyncapi === 'string' && document.asyncapi.trim() ? document.asyncapi.trim() : undefined;
}

/**
 * Bootstrap-aligned MCP identity. Arbitrary JSON must stay on other paths.
 * Detection is JSON-only (`mcp-json`); YAML near-matches are rejected.
 */
function looksLikeMcp(document: Record<string, unknown>): boolean {
  if (document.mcpServers && typeof document.mcpServers === 'object' && !Array.isArray(document.mcpServers)) {
    return true;
  }
  if (typeof document.$schema === 'string' && /modelcontextprotocol/i.test(document.$schema)) {
    return true;
  }
  return typeof document.name === 'string' && (Array.isArray(document.remotes) || Array.isArray(document.packages));
}

function mcpServersHasObjectEntry(mcpServers: Record<string, unknown>): boolean {
  for (const value of Object.values(mcpServers)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return true;
  }
  return false;
}

function arrayHasUsableObjectEntries(entries: unknown[]): boolean {
  return entries.some((entry) => entry !== null && typeof entry === 'object' && !Array.isArray(entry));
}

function isSubstantiveMcpDocument(document: Record<string, unknown>): boolean {
  const mcpServers = document.mcpServers;
  if (mcpServers && typeof mcpServers === 'object' && !Array.isArray(mcpServers)) {
    return mcpServersHasObjectEntry(mcpServers as Record<string, unknown>);
  }
  const remotes = Array.isArray(document.remotes) ? document.remotes : [];
  const packages = Array.isArray(document.packages) ? document.packages : [];
  if (
    typeof document.name === 'string' &&
    document.name.trim() &&
    (arrayHasUsableObjectEntries(remotes) || arrayHasUsableObjectEntries(packages))
  ) {
    return true;
  }
  // `$schema` alone (or with empty/non-object remotes/packages) is a near-match.
  return false;
}

function hasAsyncApiChannels(document: Record<string, unknown>): boolean {
  const channels = document.channels;
  if (channels && typeof channels === 'object' && !Array.isArray(channels)) {
    return Object.keys(channels as Record<string, unknown>).length > 0;
  }
  // AsyncAPI 3 may use operations as the primary surface.
  const operations = document.operations;
  if (operations && typeof operations === 'object' && !Array.isArray(operations)) {
    return Object.keys(operations as Record<string, unknown>).length > 0;
  }
  return false;
}

/**
 * Content-based native format detection with bounded text assumptions.
 * Optional `fileName` applies bootstrap's unambiguous extension hints (e.g. `.proto`).
 * Returns undefined when the document does not match a supported family.
 */
export function detectNativeFormat(content: string, fileName?: string): NativeFormatDetection | undefined {
  const trimmed = trimContent(content);
  if (!trimmed) return undefined;

  if (looksLikeXml(trimmed)) {
    if (isWsdlXml(trimmed)) {
      return { kind: 'wsdl', format: 'wsdl', serialization: 'xml' };
    }
    if (isWadlXml(trimmed)) {
      return { kind: 'wadl', format: 'wadl', serialization: 'xml' };
    }
    if (isXsdXml(trimmed)) {
      return { kind: 'xsd', format: 'xsd', serialization: 'xml' };
    }
    return undefined;
  }

  const parsed = parseObjectDocument(trimmed);
  if (parsed) {
    // MCP is JSON-only and checked before OpenAPI/AsyncAPI so registry/client
    // configs never fall through to an unrelated JSON family.
    if (parsed.isJson && looksLikeMcp(parsed.document) && isSubstantiveMcpDocument(parsed.document)) {
      return { kind: 'mcp-json', format: 'mcp-json', serialization: 'json' };
    }
    const asyncVersion = asyncApiVersionOf(parsed.document);
    if (asyncVersion) {
      return {
        kind: 'asyncapi',
        format: parsed.isJson ? 'asyncapi-json' : 'asyncapi-yaml',
        serialization: parsed.isJson ? 'json' : 'yaml',
        version: asyncVersion
      };
    }
    const openapiVersion = openApiVersionOf(parsed.document);
    if (openapiVersion) {
      return {
        kind: 'openapi',
        format: parsed.isJson ? 'openapi-json' : 'openapi-yaml',
        serialization: parsed.isJson ? 'json' : 'yaml',
        version: openapiVersion
      };
    }
  }

  if (isProtobufSource(trimmed) || isProtobufByFileNameHint(trimmed, fileName)) {
    return { kind: 'protobuf', format: 'protobuf', serialization: 'text' };
  }
  if (isGraphqlSdl(trimmed)) {
    return { kind: 'graphql-sdl', format: 'graphql-sdl', serialization: 'text' };
  }
  return undefined;
}

function assertExpectedFormat(actual: SpecFormat, expected?: SpecFormat): void {
  if (expected && actual !== expected) {
    throw new Error(`Specification is wrong kind: expected ${expected}, detected ${actual}`);
  }
}

function validateAsyncApi(content: string, expected?: SpecFormat): NativeValidationResult {
  const trimmed = trimContent(content);
  if (!trimmed) throw new Error('Specification content is empty');
  const isJson = looksLikeJson(trimmed);
  let parsed: unknown;
  try {
    parsed = isJson ? JSON.parse(trimmed) : parse(trimmed);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Specification is not parseable JSON or YAML: ${detail}`, { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Specification did not parse to an object document');
  }
  const document = parsed as Record<string, unknown>;
  const version = asyncApiVersionOf(document);
  if (!version) {
    throw new Error('Specification is not an AsyncAPI document');
  }
  if (!hasAsyncApiChannels(document)) {
    throw new Error('AsyncAPI document has no channels or operations');
  }
  const format: SpecFormat = isJson ? 'asyncapi-json' : 'asyncapi-yaml';
  assertExpectedFormat(format, expected);
  return {
    kind: 'asyncapi',
    format,
    serialization: isJson ? 'json' : 'yaml',
    version,
    document
  };
}

function validateXmlFamily(content: string, expected?: SpecFormat): NativeValidationResult {
  const trimmed = trimContent(content);
  if (!trimmed) throw new Error('Specification content is empty');
  if (!looksLikeXml(trimmed) || !xmlRootInfo(trimmed)) {
    throw new Error('Specification is not parseable XML');
  }
  if (isWsdlXml(trimmed)) {
    assertExpectedFormat('wsdl', expected);
    const xsdReferences = extractXsdReferences(trimmed);
    return { kind: 'wsdl', format: 'wsdl', serialization: 'xml', xsdReferences };
  }
  if (isWadlXml(trimmed)) {
    const root = trimContent(trimmed);
    if (!/<resources\b/i.test(root) && !/<resource\b/i.test(root)) {
      throw new Error('WADL document has no resources');
    }
    assertExpectedFormat('wadl', expected);
    return { kind: 'wadl', format: 'wadl', serialization: 'xml' };
  }
  if (isXsdXml(trimmed)) {
    assertExpectedFormat('xsd', expected);
    return {
      kind: 'xsd',
      format: 'xsd',
      serialization: 'xml',
      xsdReferences: extractXsdReferences(trimmed)
    };
  }
  throw new Error('XML document is not a WSDL, WADL, or XSD root');
}

function validateProtobuf(content: string, expected?: SpecFormat, fileName?: string): NativeValidationResult {
  const trimmed = trimContent(content);
  if (!trimmed) throw new Error('Specification content is empty');
  if (!isProtobufSource(trimmed) && !isProtobufByFileNameHint(trimmed, fileName)) {
    throw new Error('Specification is not protobuf source (syntax = "proto[23]" or service with rpc required)');
  }
  assertExpectedFormat('protobuf', expected);
  return { kind: 'protobuf', format: 'protobuf', serialization: 'text' };
}

function validateGraphql(content: string, expected?: SpecFormat): NativeValidationResult {
  const trimmed = trimContent(content);
  if (!trimmed) throw new Error('Specification content is empty');
  if (!isGraphqlSdl(trimmed)) {
    throw new Error('Specification is not GraphQL SDL (type or schema definition required)');
  }
  assertExpectedFormat('graphql-sdl', expected);
  return { kind: 'graphql-sdl', format: 'graphql-sdl', serialization: 'text' };
}

function validateOpenApi(content: string, expected?: SpecFormat): NativeValidationResult {
  const validated = parseAndValidateOpenApi(content);
  const format: SpecFormat = validated.isJson ? 'openapi-json' : 'openapi-yaml';
  assertExpectedFormat(format, expected);
  return {
    kind: 'openapi',
    format,
    serialization: validated.isJson ? 'json' : 'yaml',
    version: validated.version,
    document: validated.document
  };
}

function validateMcpJson(content: string, expected?: SpecFormat): NativeValidationResult {
  const trimmed = trimContent(content);
  if (!trimmed) throw new Error('Specification content is empty');
  if (!looksLikeJson(trimmed)) {
    throw new Error('Specification is not MCP JSON (JSON object required)');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Specification is not parseable JSON or YAML: ${detail}`, { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Specification did not parse to an object document');
  }
  const document = parsed as Record<string, unknown>;
  if (!looksLikeMcp(document) || !isSubstantiveMcpDocument(document)) {
    throw new Error(
      'Specification is not MCP JSON (mcpServers object, modelcontextprotocol $schema with servers, or registry name plus remotes/packages required)'
    );
  }
  assertExpectedFormat('mcp-json', expected);
  return {
    kind: 'mcp-json',
    format: 'mcp-json',
    serialization: 'json',
    document
  };
}

/**
 * Parse and validate a native specification document.
 *
 * Rejects empty, malformed, and wrong-kind content. OpenAPI keeps the nonempty
 * `paths` contract. XML checks distinguish WSDL/WADL/XSD roots and collect
 * relative XSD references without fetching them.
 */
export function parseAndValidateNativeSpec(
  content: string,
  expectedFormat?: SpecFormat,
  fileName?: string
): NativeValidationResult {
  const trimmed = trimContent(content);
  if (!trimmed) {
    throw new Error('Specification content is empty');
  }

  if (expectedFormat === 'openapi-json' || expectedFormat === 'openapi-yaml') {
    return validateOpenApi(content, expectedFormat);
  }
  if (expectedFormat === 'asyncapi-json' || expectedFormat === 'asyncapi-yaml') {
    return validateAsyncApi(content, expectedFormat);
  }
  if (expectedFormat === 'wsdl' || expectedFormat === 'wadl' || expectedFormat === 'xsd') {
    return validateXmlFamily(content, expectedFormat);
  }
  if (expectedFormat === 'protobuf') {
    return validateProtobuf(content, expectedFormat, fileName);
  }
  if (expectedFormat === 'graphql-sdl') {
    return validateGraphql(content, expectedFormat);
  }
  if (expectedFormat === 'mcp-json') {
    return validateMcpJson(content, expectedFormat);
  }

  const detected = detectNativeFormat(content, fileName);
  if (!detected) {
    if (looksLikeXml(trimmed)) {
      throw new Error('XML document is not a WSDL, WADL, or XSD root');
    }
    // Prefer a parse error when the content looks like broken JSON/YAML.
    if (looksLikeJson(trimmed) || /:\s*\S/.test(trimmed)) {
      try {
        if (looksLikeJson(trimmed)) JSON.parse(trimmed);
        else parse(trimmed);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Specification is not parseable JSON or YAML: ${detail}`, { cause: error });
      }
      // Near-match MCP shells (empty mcpServers, schema-only, name without servers).
      try {
        const candidate = looksLikeJson(trimmed) ? JSON.parse(trimmed) : parse(trimmed);
        if (
          candidate &&
          typeof candidate === 'object' &&
          !Array.isArray(candidate) &&
          (looksLikeMcp(candidate as Record<string, unknown>) ||
            'mcpServers' in (candidate as Record<string, unknown>) ||
            (typeof (candidate as Record<string, unknown>).$schema === 'string' &&
              /modelcontextprotocol/i.test(String((candidate as Record<string, unknown>).$schema))))
        ) {
          throw new Error(
            'Specification is not MCP JSON (mcpServers object, modelcontextprotocol $schema with servers, or registry name plus remotes/packages required)'
          );
        }
      } catch (error) {
        if (error instanceof Error && /MCP JSON/i.test(error.message)) throw error;
      }
    }
    if (/^\s*package\s+[\w.]+/m.test(trimmed) || /\bproto\b/i.test(trimmed) || /\bmessage\s+\w+\s*\{/.test(trimmed)) {
      throw new Error('Specification is not protobuf source (syntax = "proto[23]" or service with rpc required)');
    }
    if (/^\s*#/.test(trimmed) || /\b(type|schema|query)\b/i.test(trimmed)) {
      throw new Error('Specification is not GraphQL SDL (type or schema definition required)');
    }
    throw new Error('Specification is not a supported native format');
  }

  switch (detected.kind) {
    case 'openapi':
      return validateOpenApi(content, expectedFormat);
    case 'asyncapi':
      return validateAsyncApi(content, expectedFormat);
    case 'wsdl':
    case 'wadl':
    case 'xsd':
      return validateXmlFamily(content, expectedFormat);
    case 'protobuf':
      return validateProtobuf(content, expectedFormat, fileName);
    case 'graphql-sdl':
      return validateGraphql(content, expectedFormat);
    case 'mcp-json':
      return validateMcpJson(content, expectedFormat);
  }
}
