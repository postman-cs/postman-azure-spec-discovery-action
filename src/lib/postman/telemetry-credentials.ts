import { resolveTelemetryAccountType } from './credential-identity.js';
import { AccessTokenProvider } from './token-provider.js';
import { POSTMAN_ENDPOINT_PROFILES } from './base-urls.js';

export interface PrepareTelemetryCredentialsOptions {
  postmanApiKey?: string;
  postmanAccessToken?: string;
  apiBaseUrl?: string;
  onToken?: (token: string) => void;
  fetchImpl?: typeof fetch;
}

export interface PreparedTelemetryCredentials {
  provider?: AccessTokenProvider;
  accountType?: string;
}

export function resolveTelemetryTeamId(env: NodeJS.ProcessEnv): string | undefined {
  return String(env.POSTMAN_TEAM_ID ?? '').trim() || undefined;
}

/**
 * Wire AccessTokenProvider for telemetry enrichment. When only a service-account
 * PMAK is present, mint a fresh access token so iapub session identity (and thus
 * telemetry account_type) can still resolve. Mint failures are best-effort: they
 * must not block AWS spec discovery.
 */
export async function prepareTelemetryCredentials(
  options: PrepareTelemetryCredentialsOptions
): Promise<PreparedTelemetryCredentials> {
  const apiKey = String(options.postmanApiKey || '').trim();
  const accessToken = String(options.postmanAccessToken || '').trim();
  if (!apiKey && !accessToken) {
    return {};
  }

  const provider = new AccessTokenProvider({
    accessToken,
    apiKey,
    apiBaseUrl: options.apiBaseUrl || POSTMAN_ENDPOINT_PROFILES.prod.apiBaseUrl,
    onToken: options.onToken,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})
  });

  if (!accessToken && apiKey && provider.canRefresh()) {
    try {
      await provider.refresh();
    } catch {
      // Telemetry-only path: discovery continues without account_type enrichment.
    }
  }

  const accountType = await resolveTelemetryAccountType(provider.current(), options.fetchImpl);
  return {
    provider,
    ...(accountType ? { accountType } : {})
  };
}
