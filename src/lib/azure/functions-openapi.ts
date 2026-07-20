import type { FunctionSummary } from './clients.js';

/**
 * Documented / commonly configured Azure Functions OpenAPI extension routes.
 * Detection is evidence-based from function metadata only — never from blind
 * estate probing of common paths, and never via host/function key APIs.
 */
const OPENAPI_FUNCTION_NAME_MARKERS = [
  'renderopenapidocument',
  'renderswaggerdocument',
  'renderswaggerui',
  'openapi',
  'swagger'
];

const OPENAPI_ROUTE_MARKERS = [
  'swagger.json',
  'swagger/v1/swagger.json',
  'openapi',
  'openapi/v2.json',
  'openapi/v3.json',
  'openapi.yaml',
  'openapi.json'
];

export interface FunctionsOpenApiRoute {
  /** Absolute HTTPS URL when a host is known; otherwise undefined. */
  url?: string;
  /** Path portion beginning with /. */
  path: string;
  /** Function name that evidenced the route, when applicable. */
  functionName?: string;
  evidence: string;
}

function normalizeRoutePath(route: string): string {
  const trimmed = route.trim().replace(/^\/+/, '');
  if (!trimmed) return '/api';
  return trimmed.startsWith('api/') || trimmed.startsWith('api?') ? `/${trimmed}` : `/api/${trimmed}`;
}

function looksLikeOpenApiRoute(route: string): boolean {
  const lower = route.toLowerCase();
  return OPENAPI_ROUTE_MARKERS.some((marker) => lower.includes(marker));
}

function looksLikeOpenApiFunction(name: string): boolean {
  const lower = name.toLowerCase();
  return OPENAPI_FUNCTION_NAME_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * Detect OpenAPI extension endpoints from function binding metadata and an
 * optional repository-provided explicit path. Never invents host key calls.
 */
export function detectFunctionsOpenApiRoutes(input: {
  functions: FunctionSummary[];
  defaultHostName?: string;
  /** Explicit path from repo/manifest (e.g. /api/openapi/v3.json). */
  explicitPath?: string;
}): FunctionsOpenApiRoute[] {
  const routes: FunctionsOpenApiRoute[] = [];
  const seen = new Set<string>();

  const push = (path: string, evidence: string, functionName?: string): void => {
    const normalized = path.startsWith('/') ? path : `/${path}`;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const host = input.defaultHostName?.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    routes.push({
      path: normalized,
      evidence,
      ...(functionName ? { functionName } : {}),
      ...(host ? { url: `https://${host}${normalized}` } : {})
    });
  };

  const explicit = (input.explicitPath ?? '').trim();
  if (explicit) {
    if (!explicit.startsWith('/')) {
      throw new Error(`Explicit Functions OpenAPI path must be absolute (start with /); got ${explicit}`);
    }
    push(explicit, `Repository/manifest declared Functions OpenAPI path ${explicit}`);
  }

  for (const fn of input.functions) {
    const httpTriggers = fn.bindings.filter((binding) => binding.type.toLowerCase() === 'httptrigger');
    for (const binding of httpTriggers) {
      const route = (binding.route ?? '').trim();
      if (route && looksLikeOpenApiRoute(route)) {
        push(normalizeRoutePath(route), `Function ${fn.name} httpTrigger route declares OpenAPI document path`, fn.name);
        continue;
      }
      if (looksLikeOpenApiFunction(fn.name)) {
        const path = route ? normalizeRoutePath(route) : `/api/${fn.name}`;
        // RenderOpenApiDocument typically uses route templates like
        // openapi/{version}.{extension} — keep the declared route when present.
        push(path, `Function ${fn.name} matches Azure Functions OpenAPI extension naming`, fn.name);
      }
    }
  }

  return routes;
}
