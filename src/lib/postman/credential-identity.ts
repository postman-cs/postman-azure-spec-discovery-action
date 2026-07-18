// Session-identity subset copied from the shared credential-identity foundation
// (postman-repo-sync-action/src/lib/postman/credential-identity.ts). This action
// makes no Postman asset calls; it resolves the access-token -> iapub session
// only so telemetry can emit `account_type` from the resolved `consumerType`.
// Access tokens may be supplied directly or minted via AccessTokenProvider
// (postman-api-key -> POST /service-account-tokens) in telemetry-credentials.ts.

export interface CredentialIdentity {
  source: 'pmak/me' | 'iapub/sessions';
  userId?: string;
  fullName?: string;
  teamId?: string;
  teamName?: string;
  teamDomain?: string;
  roles?: string[];
  consumerType?: string;
}

export interface ResolveSessionIdentityOptions {
  iapubBaseUrl: string;
  accessToken: string;
  fetchImpl?: typeof fetch;
  /** Max attempts for transient (network / 429 / 5xx) iapub failures (default 3). */
  maxAttempts?: number;
  /**
   * Injectable clock for deterministic retry tests: the computed wait (ms) is
   * passed here so the suite advances without real time. Defaults to setTimeout.
   */
  sleepImpl?: (ms: number) => Promise<void>;
  /**
   * Injectable RNG for the full-jitter backoff fallback, so the jittered path is
   * deterministic under test. Defaults to Math.random.
   */
  randomImpl?: () => number;
}

/**
 * Why the last session-identity resolution failed, when it did:
 * - `auth`: iapub rejected the token (401/403) - it is invalid or expired.
 * - `unavailable`: network error, 5xx after retries, or a non-auth non-2xx.
 */
export type SessionResolutionFailure = 'auth' | 'unavailable';

const sessionPath = '/api/sessions/current';
const DEFAULT_IAPUB_BASE_URL = 'https://iapub.postman.co';

type JsonRecord = Record<string, unknown>;

const SESSION_MAX_ATTEMPTS = 3;
const SESSION_RETRY_BASE_DELAY_MS = 500;
const SESSION_RETRY_MAX_DELAY_MS = 8000;

const sessionMemo = new Map<string, Promise<CredentialIdentity | undefined>>();
let memoizedSessionIdentity: CredentialIdentity | undefined;
let memoizedSessionFailure: SessionResolutionFailure | undefined;

function defaultSessionSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultRandom(): number {
  return Math.random();
}

/**
 * Parse an HTTP `Retry-After` value (RFC 7231): either delta-seconds or an
 * HTTP-date. Returns milliseconds, or undefined when absent/unparseable. A past
 * date clamps to 0 (retry now).
 */
function parseRetryAfterMs(value: string | null): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return undefined;
}

/**
 * Parse a `RateLimit-Reset` header. IETF ratelimit uses seconds-until-reset;
 * some servers emit an absolute epoch (seconds). Values that look like an epoch
 * (greater than "now" in seconds) are treated as absolute and converted to a
 * delta. Returns milliseconds, or undefined when absent/unparseable.
 */
function parseRateLimitResetMs(value: string | null): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) {
    return undefined;
  }
  const seconds = Number(trimmed);
  const nowSeconds = Date.now() / 1000;
  if (seconds > nowSeconds) {
    return Math.max(0, (seconds - nowSeconds) * 1000);
  }
  return seconds * 1000;
}

/**
 * Event-based backoff: prefer a server-provided wait signal (`Retry-After`,
 * then `RateLimit-Reset`/`x-ratelimit-reset`), clamped to [0, maxDelayMs] so a
 * rogue large value cannot stall CI. With no signal (or a network-level failure
 * where `response` is undefined), fall back to full-jitter exponential:
 * random in [0, min(maxDelayMs, baseDelayMs * 2^(attempt-1))].
 */
function computeSessionRetryDelayMs(
  response: Response | undefined,
  attempt: number,
  random: () => number
): number {
  const headers = response?.headers;
  const signal =
    parseRetryAfterMs(headers?.get('retry-after') ?? null) ??
    parseRateLimitResetMs(
      headers?.get('ratelimit-reset') ?? headers?.get('x-ratelimit-reset') ?? null
    );
  if (signal !== undefined) {
    return Math.min(Math.max(0, signal), SESSION_RETRY_MAX_DELAY_MS);
  }
  const ceiling = Math.min(SESSION_RETRY_MAX_DELAY_MS, SESSION_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
  return Math.round(random() * ceiling);
}

/** Test-only: clears the in-process identity memo so cases cannot bleed into each other. */
export function __resetIdentityMemo(): void {
  sessionMemo.clear();
  memoizedSessionIdentity = undefined;
  memoizedSessionFailure = undefined;
}

/** Last session identity resolved in this process, consumed for telemetry account_type. */
export function getMemoizedSessionIdentity(): CredentialIdentity | undefined {
  return memoizedSessionIdentity;
}

/**
 * Why the last session-identity resolution failed in this process, or `undefined`
 * when the most recent resolve succeeded (or none has run). Cleared on success.
 */
export function getSessionResolutionFailure(): SessionResolutionFailure | undefined {
  return memoizedSessionFailure;
}

function asRecord(value: unknown): JsonRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as JsonRecord;
}

function coerceId(raw: unknown): string | undefined {
  return raw ? String(raw) : undefined;
}

function coerceText(raw: unknown): string | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeBaseUrl(raw: string): string {
  return String(raw || '').replace(/\/+$/, '');
}

export async function resolveSessionIdentity(
  opts: ResolveSessionIdentityOptions
): Promise<CredentialIdentity | undefined> {
  const accessToken = String(opts.accessToken || '').trim();
  if (!accessToken) {
    return undefined;
  }
  const baseUrl = normalizeBaseUrl(opts.iapubBaseUrl);
  const memoKey = `${baseUrl}::${accessToken}`;
  let pending = sessionMemo.get(memoKey);
  if (!pending) {
    pending = probeSessionIdentity(
      baseUrl,
      accessToken,
      opts.fetchImpl ?? fetch,
      Math.max(1, opts.maxAttempts ?? SESSION_MAX_ATTEMPTS),
      opts.sleepImpl ?? defaultSessionSleep,
      opts.randomImpl ?? defaultRandom
    );
    sessionMemo.set(memoKey, pending);
  }
  return pending;
}

/**
 * Resolve telemetry `account_type` (session consumerType) from an optional
 * access token. Best-effort: any failure yields undefined so telemetry stays
 * `unknown` rather than breaking discovery.
 */
export async function resolveTelemetryAccountType(
  accessToken: string | undefined,
  fetchImpl?: typeof fetch
): Promise<string | undefined> {
  const token = String(accessToken || '').trim();
  if (!token) {
    return undefined;
  }
  const identity = await resolveSessionIdentity({
    iapubBaseUrl: DEFAULT_IAPUB_BASE_URL,
    accessToken: token,
    ...(fetchImpl ? { fetchImpl } : {})
  }).catch(() => undefined);
  return identity?.consumerType;
}

/**
 * Parse a 2xx iapub session body into a whitelisted identity. iapub wraps the
 * live session under `session`; an unwrapped shape is tolerated. Only the
 * whitelisted fields are lifted - the raw body (including session.token) is
 * discarded. Returns undefined on an unparseable/empty body.
 */
async function parseSessionResponse(response: Response): Promise<CredentialIdentity | undefined> {
  let payload: JsonRecord | undefined;
  try {
    payload = asRecord(await response.json());
  } catch {
    return undefined;
  }
  if (!payload) {
    return undefined;
  }
  const root = asRecord(payload.session) ?? payload;
  const identity = asRecord(root.identity);
  const data = asRecord(root.data);
  const user = asRecord(data?.user);
  const roleEntries = Array.isArray(user?.roles)
    ? user.roles
        .map((entry) => coerceText(entry) ?? coerceId(entry))
        .filter((entry): entry is string => Boolean(entry))
    : [];
  const singleRole = coerceText(user?.role);
  const roles = roleEntries.length > 0 ? roleEntries : singleRole ? [singleRole] : undefined;
  return {
    source: 'iapub/sessions',
    userId: coerceId(identity?.user) ?? coerceId(user?.id),
    fullName:
      coerceText(user?.fullName) ?? coerceText(user?.name) ?? coerceText(user?.username),
    teamId: coerceId(identity?.team),
    teamName: coerceText(user?.teamName),
    teamDomain: coerceText(identity?.domain),
    ...(roles ? { roles } : {}),
    consumerType:
      coerceText(root.consumerType) ??
      coerceText(data?.consumerType) ??
      coerceText(user?.consumerType)
  };
}

/**
 * Resolve the session identity from iapub with status-aware, event-based
 * retries. Transient failures (network errors, 429, 5xx) are retried; the wait
 * honors a server signal (`Retry-After`, then `RateLimit-Reset`) when present
 * and otherwise uses full-jitter exponential backoff - never a fixed sleep. A
 * 401/403 is a deterministic auth failure and is NOT retried; other non-2xx are
 * treated as terminal-unavailable. On terminal failure it records the reason
 * (see getSessionResolutionFailure) and returns undefined. On success the
 * failure memo is cleared.
 */
async function probeSessionIdentity(
  baseUrl: string,
  accessToken: string,
  fetchImpl: typeof fetch,
  maxAttempts: number,
  sleepImpl: (ms: number) => Promise<void>,
  random: () => number
): Promise<CredentialIdentity | undefined> {
  let failure: SessionResolutionFailure = 'unavailable';
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${sessionPath}`, {
        method: 'GET',
        headers: { 'x-access-token': accessToken }
      });
    } catch {
      // Network-level failure: transient. No response to read a signal from, so
      // fall back to full jitter and retry.
      failure = 'unavailable';
      if (attempt < maxAttempts) {
        await sleepImpl(computeSessionRetryDelayMs(undefined, attempt, random));
        continue;
      }
      break;
    }

    if (response.ok) {
      const resolved = await parseSessionResponse(response);
      if (resolved) {
        memoizedSessionIdentity = resolved;
        memoizedSessionFailure = undefined;
        return resolved;
      }
      // 2xx but unparseable/empty: deterministic, no retry.
      failure = 'unavailable';
      break;
    }

    if (response.status === 401 || response.status === 403) {
      // Deterministic auth failure: the token is invalid or expired. No retry.
      failure = 'auth';
      break;
    }

    if (response.status === 429 || response.status >= 500) {
      // Transient (rate-limited or server-side): honor a server wait signal
      // when present, else full jitter.
      failure = 'unavailable';
      if (attempt < maxAttempts) {
        await sleepImpl(computeSessionRetryDelayMs(response, attempt, random));
        continue;
      }
      break;
    }

    // Other non-2xx (e.g. 400/404): deterministic, no retry.
    failure = 'unavailable';
    break;
  }
  memoizedSessionFailure = failure;
  return undefined;
}
