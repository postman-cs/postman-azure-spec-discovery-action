const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const ARM_ID_RE = /\/subscriptions\/[^\s'"]+/gi;
const BEARER_TOKEN_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const URL_QUERY_RE = /(https:\/\/[^\s'"?]+)\?[^\s'"]*/gi;
const ABS_PATH_RE = /(?:^|(?<=[\s'"=([{,]))(?:[A-Za-z]:\\|\/)[^\s'"]+/g;

export function isDebugLoggingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.ACTIONS_STEP_DEBUG || '').toLowerCase() === 'true';
}

/**
 * Redact Azure-sensitive material from a log line:
 *  - SAS/query strings are stripped from HTTPS URLs (origin + path survive);
 *  - full ARM IDs (and the subscription UUIDs inside them) become [redacted-azure-id];
 *  - bearer tokens become [redacted-token];
 *  - any remaining bare subscription/tenant UUID becomes [redacted-azure-id];
 *  - other absolute filesystem paths become [redacted-path].
 */
export function sanitizeLogMessage(message: string): string {
  return message
    .replace(URL_QUERY_RE, '$1')
    .replace(ARM_ID_RE, '[redacted-azure-id]')
    .replace(BEARER_TOKEN_RE, '[redacted-token]')
    .replace(UUID_RE, '[redacted-azure-id]')
    .replace(ABS_PATH_RE, (match) => (match.startsWith('https://') ? match : '[redacted-path]'));
}

/** Recursively sanitize every string leaf of a JSON-safe value. */
export function sanitizeJsonValue<T>(value: T): T {
  if (typeof value === 'string') {
    return sanitizeLogMessage(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJsonValue(item)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = sanitizeJsonValue(item);
    }
    return out as unknown as T;
  }
  return value;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatUserSafeError(error: unknown, env: NodeJS.ProcessEnv = process.env): string {
  const message = errorMessage(error);
  if (isDebugLoggingEnabled(env)) {
    return message;
  }
  return sanitizeLogMessage(message);
}
