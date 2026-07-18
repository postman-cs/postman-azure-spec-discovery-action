import { parse } from 'yaml';

export interface ValidatedOpenApi {
  document: Record<string, unknown>;
  version: 'swagger-2.0' | 'openapi-3.0' | 'openapi-3.1';
  isJson: boolean;
}

/**
 * Parse and validate an OpenAPI/Swagger document string.
 *
 * Accepts JSON or YAML. Rejects (throws) on:
 *  - unparseable content;
 *  - documents that are not Swagger 2.0 or OpenAPI 3.x;
 *  - missing or non-object `paths`;
 *  - empty `paths` (a spec with zero operations is not exportable evidence).
 */
export function parseAndValidateOpenApi(content: string): ValidatedOpenApi {
  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error('Specification content is empty');
  }
  const isJson = trimmed.startsWith('{');
  let parsed: unknown;
  try {
    parsed = isJson ? JSON.parse(trimmed) : parse(trimmed);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Specification is not parseable JSON or YAML: ${detail}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Specification did not parse to an object document');
  }
  const document = parsed as Record<string, unknown>;

  let version: ValidatedOpenApi['version'] | undefined;
  const swagger = typeof document.swagger === 'string' ? document.swagger : '';
  const openapi = typeof document.openapi === 'string' ? document.openapi : '';
  if (swagger.startsWith('2')) {
    version = 'swagger-2.0';
  } else if (openapi.startsWith('3.1')) {
    version = 'openapi-3.1';
  } else if (openapi.startsWith('3.')) {
    version = 'openapi-3.0';
  }
  if (!version) {
    throw new Error('Specification is not Swagger 2.0 or OpenAPI 3.x');
  }

  const paths = document.paths;
  if (!paths || typeof paths !== 'object' || Array.isArray(paths)) {
    throw new Error('Specification has no paths object');
  }
  if (Object.keys(paths as Record<string, unknown>).length === 0) {
    throw new Error('Specification has an empty paths object');
  }

  return { document, version, isJson };
}
