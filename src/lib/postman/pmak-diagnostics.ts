export type PmakDiagnosticKind = 'personal' | 'service-account' | 'invalid' | 'inconclusive';

export interface PmakDiagnosticResult {
  kind: PmakDiagnosticKind;
  status?: number;
  payload?: Record<string, unknown>;
}

export interface InspectPmakIdentityOptions {
  apiBaseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
  mode?: 'diagnostic' | 'preflight';
}

const memo = new Map<string, Promise<PmakDiagnosticResult>>();

function normalizeApiBase(apiBaseUrl: string): string {
  return new URL(apiBaseUrl.trim()).toString().replace(/\/+$/, '');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isEmptyIdentityValue(value: unknown): boolean {
  return value === null || value === '';
}

async function inspectOnce(options: InspectPmakIdentityOptions): Promise<PmakDiagnosticResult> {
  const timeoutMs = options.timeoutMs ?? 2000;
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<PmakDiagnosticResult>((resolve) => {
    timeout = setTimeout(() => {
      controller.abort();
      resolve({ kind: 'inconclusive' });
    }, timeoutMs);
  });
  const request = (async (): Promise<PmakDiagnosticResult> => {
    try {
      const response = await (options.fetchImpl ?? fetch)(`${normalizeApiBase(options.apiBaseUrl)}/me`, {
        headers: { 'x-api-key': options.apiKey },
        signal
      });
      if (response.status === 401 || response.status === 403) {
        return { kind: 'invalid', status: response.status };
      }
      if (!response.ok) {
        return { kind: 'inconclusive', status: response.status };
      }
      const payload = asRecord(await response.json().catch(() => undefined));
      const user = asRecord(payload?.user);
      if (!payload || !user) {
        return { kind: 'inconclusive', status: response.status };
      }
      const username = user.username;
      const email = user.email;
      if ((typeof username === 'string' && username.trim()) || (typeof email === 'string' && email.trim())) {
        return { kind: 'personal', status: response.status, payload };
      }
      if (
        Object.prototype.hasOwnProperty.call(user, 'username') &&
        Object.prototype.hasOwnProperty.call(user, 'email') &&
        isEmptyIdentityValue(username) &&
        isEmptyIdentityValue(email)
      ) {
        return { kind: 'service-account', status: response.status, payload };
      }
      return { kind: 'inconclusive', status: response.status };
    } catch {
      return { kind: 'inconclusive' };
    }
  })();
  try {
    return await Promise.race([request, deadline]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export function __resetPmakDiagnosticMemo(): void {
  memo.clear();
}

export function inspectPmakIdentity(options: InspectPmakIdentityOptions): Promise<PmakDiagnosticResult> {
  const normalizedApiBase = normalizeApiBase(options.apiBaseUrl);
  const key = `${normalizedApiBase}\u0000${options.apiKey}`;
  let pending = memo.get(key);
  if (!pending) {
    pending = inspectOnce({ ...options, apiBaseUrl: normalizedApiBase });
    memo.set(key, pending);
    if (options.mode === 'preflight') {
      pending.then((result) => {
        if (result.kind === 'inconclusive') {
          memo.delete(key);
        }
      });
    }
  }
  return pending;
}

export function maskPmakDiagnostic(message: string, secrets: readonly (string | undefined)[]): string {
  let masked = String(message);
  for (const secret of secrets) {
    if (secret) {
      masked = masked.split(secret).join('***');
    }
  }
  return masked.replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim();
}

export function formatRejectedMint(originalMintError: string, result: PmakDiagnosticResult): string {
  switch (result.kind) {
    case 'personal':
      return `${originalMintError} Personal API key detected, cannot mint a service-account access token.`;
    case 'service-account':
      return `${originalMintError} postman-api-key authenticates (GET /me OK) but was rejected by POST /service-account-tokens and lacks permission to mint access tokens.`;
    case 'invalid':
      return `${originalMintError} postman-api-key is invalid, disabled, or expired.`;
    default:
      return originalMintError;
  }
}
