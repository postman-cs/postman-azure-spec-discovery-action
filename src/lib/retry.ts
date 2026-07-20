export interface RetryDecisionContext {
  attempt: number;
  maxAttempts: number;
}

export interface RetryContext extends RetryDecisionContext {
  delayMs: number;
  error: unknown;
}

export interface RetryOptions {
  maxAttempts?: number;
  delayMs?: number;
  backoffMultiplier?: number;
  maxDelayMs?: number;
  onRetry?: (context: RetryContext) => void | Promise<void>;
  shouldRetry?: (error: unknown, context: RetryDecisionContext) => boolean;
  sleep?: (delayMs: number) => Promise<void>;
}

/** Default base delay for ARM direct-REST full-jitter backoff. */
export const ARM_RETRY_BASE_DELAY_MS = 500;
/** Absolute ceiling so a rogue Retry-After cannot stall CI. */
export const ARM_RETRY_MAX_DELAY_MS = 8000;

export function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

/**
 * Parse an HTTP `Retry-After` value (RFC 7231): either delta-seconds or an
 * HTTP-date. Returns milliseconds, or undefined when absent/unparseable. A past
 * date clamps to 0 (retry now).
 */
export function parseRetryAfterMs(
  value: string | null | undefined,
  nowMs: number = Date.now()
): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - nowMs);
  }
  return undefined;
}

export interface BoundedRetryDelayOptions {
  attempt: number;
  retryAfterHeader?: string | null;
  baseDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
  nowMs?: number;
}

/**
 * Prefer a capped Retry-After signal when present; otherwise full jitter in
 * [0, min(maxDelayMs, baseDelayMs * 2^(attempt-1))].
 */
export function computeBoundedRetryDelayMs(options: BoundedRetryDelayOptions): number {
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? ARM_RETRY_BASE_DELAY_MS);
  const maxDelayMs = Math.max(0, options.maxDelayMs ?? ARM_RETRY_MAX_DELAY_MS);
  const random = options.random ?? Math.random;
  const signal = parseRetryAfterMs(options.retryAfterHeader, options.nowMs ?? Date.now());
  if (signal !== undefined) {
    return Math.min(Math.max(0, signal), maxDelayMs);
  }
  const exponent = Math.max(0, options.attempt - 1);
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** exponent);
  return Math.round(random() * ceiling);
}

/** Transient HTTP statuses eligible for bounded ARM direct-REST retries. */
export function isTransientHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function normalizeRetryOptions(options: RetryOptions): Required<RetryOptions> {
  return {
    maxAttempts: Math.max(1, options.maxAttempts ?? 3),
    delayMs: Math.max(0, options.delayMs ?? 2000),
    backoffMultiplier: Math.max(1, options.backoffMultiplier ?? 1),
    maxDelayMs:
      options.maxDelayMs === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(0, options.maxDelayMs),
    onRetry: options.onRetry ?? (async () => undefined),
    shouldRetry: options.shouldRetry ?? (() => true),
    sleep: options.sleep ?? sleep
  };
}

export async function retry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const normalized = normalizeRetryOptions(options);
  let nextDelayMs = normalized.delayMs;

  for (let attempt = 1; attempt <= normalized.maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const shouldRetry =
        attempt < normalized.maxAttempts &&
        normalized.shouldRetry(error, {
          attempt,
          maxAttempts: normalized.maxAttempts
        });

      if (!shouldRetry) {
        throw error;
      }

      await normalized.onRetry({
        attempt,
        maxAttempts: normalized.maxAttempts,
        delayMs: nextDelayMs,
        error
      });
      await normalized.sleep(nextDelayMs);
      nextDelayMs = Math.min(
        normalized.maxDelayMs,
        Math.round(nextDelayMs * normalized.backoffMultiplier)
      );
    }
  }

  throw new Error('Retry exhausted without returning or throwing');
}
