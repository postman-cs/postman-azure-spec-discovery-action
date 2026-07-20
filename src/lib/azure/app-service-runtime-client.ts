import { isIP } from 'node:net';

import type { TokenCredential } from '@azure/identity';

import { SpecFetchError } from '../fetch/spec-fetcher.js';
import type { AzureSdkOptions } from './clients.js';
import {
  armRequest,
  armUrl,
  createArmRestClientOptions,
  getArmAccessToken,
  type ArmRestClientOptions
} from './arm-rest.js';

const WEB_API_VERSION = '2023-12-01';

/** Absolute ceiling for SCM/VFS OpenAPI artifacts (matches guarded public-spec fetch). */
const MAX_SCM_ARTIFACT_BYTES = 10 * 1024 * 1024;

/** Bound for non-success diagnostic body peeks — never unbounded response.text(). */
const MAX_DIAGNOSTIC_BYTES = 4 * 1024;

export type AppServiceScmFetchResult =
  | { kind: 'content'; content: string; contentType?: string }
  | { kind: 'scm-disabled'; detail: string }
  | { kind: 'private-network-unreachable'; detail: string }
  | { kind: 'permission-denied'; status: number }
  | { kind: 'not-found'; status: number }
  | { kind: 'failed'; detail: string };

export interface AppServiceRuntimeSiteConfig {
  apiDefinitionUrl?: string;
  /** Absolute filesystem path from aiIntegration.ApiSpecPath when present. */
  apiSpecPath?: string;
  defaultHostName?: string;
  /** Enabled SCM/Kudu hostname when discoverable (never a credential). */
  scmHostName?: string;
  publicNetworkAccess?: string;
}

export interface AzureAppServiceRuntimeClient {
  getSiteRuntimeConfig(resourceGroup: string, siteName: string, signal?: AbortSignal): Promise<AppServiceRuntimeSiteConfig>;
  fetchApiSpecFromScm(
    resourceGroup: string,
    siteName: string,
    apiSpecPath: string,
    signal?: AbortSignal
  ): Promise<AppServiceScmFetchResult>;
}

interface SiteArmEnvelope {
  properties?: {
    defaultHostName?: unknown;
    enabledHostNames?: unknown;
    publicNetworkAccess?: unknown;
    siteConfig?: {
      apiDefinition?: { url?: unknown };
      metadata?: Array<{ name?: unknown; value?: unknown }>;
    };
  };
}

interface ConfigArmEnvelope {
  properties?: {
    apiDefinition?: { url?: unknown };
    metadata?: Array<{ name?: unknown; value?: unknown }>;
    aiIntegration?: { ApiSpecPath?: unknown; apiSpecPath?: unknown };
  };
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function extractApiSpecPath(config: ConfigArmEnvelope | undefined, site: SiteArmEnvelope | undefined): string | undefined {
  const direct =
    str(config?.properties?.aiIntegration?.ApiSpecPath) ?? str(config?.properties?.aiIntegration?.apiSpecPath);
  if (direct) return direct;
  const metadata = [
    ...(config?.properties?.metadata ?? []),
    ...(site?.properties?.siteConfig?.metadata ?? [])
  ];
  for (const entry of metadata) {
    const name = str(entry.name)?.toLowerCase();
    if (name === 'apispecpath' || name === 'aiintegration.apispecpath') {
      return str(entry.value);
    }
  }
  return undefined;
}

/** Safe origin+path for evidence/errors — strips query, fragment, and userinfo. */
export function safeUrlForEvidence(raw: string): string {
  try {
    const parsed = new URL(raw);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    const withoutUserinfo = raw.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/@]+@/i, (prefix) =>
      prefix.replace(/\/\/[^/@]+@/, '//')
    );
    return withoutUserinfo.split(/[?#]/, 1)[0] || '[invalid-url]';
  }
}

function hostnameLooksLikeIpLiteral(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, '');
  return isIP(bare) !== 0;
}

/**
 * DNS hostname shape only — no userinfo, scheme, path, port, query, or IP literals.
 * Labels are alphanumeric/hyphen; at least two labels required.
 */
function isValidDnsHostname(hostname: string): boolean {
  if (!hostname || hostname.length > 253) return false;
  // Reject userinfo, path/query/fragment markers, ports, brackets, and whitespace.
  if (/[@/?#:[\]]/.test(hostname) || /\s/.test(hostname)) return false;
  if (hostnameLooksLikeIpLiteral(hostname)) return false;
  return /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i.test(hostname);
}

function hasScmDnsLabel(hostname: string): boolean {
  return hostname.split('.').includes('scm');
}

/**
 * Derive the site SCM hostname from the ARM-owned default hostname and optionally
 * correlate against enabledHostNames.
 *
 * Documented Azure App Service SCM shapes insert an `scm` DNS label after the
 * site name (public, sovereign, and ASE forms), e.g.:
 *  - app.azurewebsites.net -> app.scm.azurewebsites.net
 *  - app.azurewebsites.us -> app.scm.azurewebsites.us
 *  - app.chinacloudsites.cn -> app.scm.chinacloudsites.cn
 *  - app.ase.p.azurewebsites.net -> app.scm.ase.p.azurewebsites.net
 *  - app.ase.appserviceenvironment.net -> app.scm.ase.appserviceenvironment.net
 *
 * Never accepts an arbitrary enabledHostNames entry merely because it contains `.scm.`.
 * Mismatched / malformed / IP / userinfo SCM candidates fail closed.
 */
export function deriveCorrelatedScmHostName(
  defaultHostName: string | undefined,
  enabledHostNames: unknown
): string | undefined {
  const defaultHost = str(defaultHostName)?.toLowerCase();
  if (!defaultHost || !isValidDnsHostname(defaultHost)) return undefined;
  // Default site hostname must not already be an SCM host.
  if (hasScmDnsLabel(defaultHost)) return undefined;

  const match = /^([^.]+)\.(.+)$/.exec(defaultHost);
  if (!match) return undefined;
  const expectedScm = `${match[1]}.scm.${match[2]}`.toLowerCase();
  if (!isValidDnsHostname(expectedScm) || !hasScmDnsLabel(expectedScm)) return undefined;
  // Structural: site-label.scm.<remainder> with at least three labels.
  const labels = expectedScm.split('.');
  if (labels.length < 3 || labels[1] !== 'scm') return undefined;

  if (Array.isArray(enabledHostNames)) {
    for (const host of enabledHostNames) {
      const value = str(host)?.toLowerCase();
      if (!value) continue;
      if (!hasScmDnsLabel(value) && !value.includes('.scm.')) continue;
      // SCM-shaped candidate from ARM must exactly equal the derived host.
      if (!isValidDnsHostname(value) || value !== expectedScm) {
        return undefined;
      }
      return expectedScm;
    }
  }

  return expectedScm;
}

function normalizeVfsPath(apiSpecPath: string): string {
  const trimmed = apiSpecPath.trim();
  if (!trimmed) {
    throw new Error('ApiSpecPath is empty');
  }
  // Reject path traversal and scheme smuggling.
  if (trimmed.includes('..') || trimmed.includes('\\') || /^[a-z]+:/i.test(trimmed)) {
    throw new Error(`ApiSpecPath is not a safe absolute app filesystem path: ${trimmed}`);
  }
  const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  // VFS API expects paths relative to site root without a duplicated /api/vfs prefix.
  return withLeading.replace(/^\/+/, '');
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer;
}

/**
 * Read a response body with a hard byte ceiling. When Content-Length already
 * exceeds the ceiling, the body is not consumed.
 */
async function readBoundedResponseText(
  response: Response,
  maxBytes: number
): Promise<{ text: string; overflow: boolean }> {
  const contentLength = response.headers.get('content-length');
  if (contentLength) {
    const declared = Number.parseInt(contentLength, 10);
    if (Number.isFinite(declared) && declared > maxBytes) {
      if (response.body) {
        try {
          await response.body.cancel();
        } catch {
          // ignore cancel failures
        }
      }
      return { text: '', overflow: true };
    }
  }

  if (!response.body) {
    return { text: '', overflow: false };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        return { text: new TextDecoder().decode(concatChunks(chunks, received - value.byteLength)), overflow: true };
      }
      chunks.push(value);
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
    throw error;
  }

  return { text: new TextDecoder().decode(concatChunks(chunks, received)), overflow: false };
}

function composeRequestSignal(requestTimeoutMs: number, signal?: AbortSignal): AbortSignal {
  return AbortSignal.any([AbortSignal.timeout(requestTimeoutMs), ...(signal ? [signal] : [])]);
}

function isTimeoutAbort(error: unknown, requestSignal: AbortSignal, callerSignal?: AbortSignal): boolean {
  if (callerSignal?.aborted) return false;
  if (!requestSignal.aborted) return false;
  const name = error instanceof Error ? error.name : '';
  return name === 'AbortError' || name === 'TimeoutError' || /aborted|timed? ?out/i.test(String(error));
}

/**
 * App Service runtime-declared spec seams:
 *  - read `aiIntegration.ApiSpecPath` (and apiDefinition.url) from site config
 *  - optionally retrieve bytes from the site's own SCM/VFS host using the ARM token
 *
 * Never forwards credentials to arbitrary hosts. Never calls publishing password APIs.
 * SCM host must be exactly correlated to the ARM-returned default hostname and a
 * documented App Service SCM hostname shape (public/sovereign/ASE). Microsoft Learn
 * documents Entra/ARM bearer auth for SCM and requires Microsoft.Web/sites/publish/Action.
 */
export class AppServiceRuntimeSdkClient implements AzureAppServiceRuntimeClient {
  private readonly credential: TokenCredential;
  private readonly subscriptionId: string;
  private readonly options: ArmRestClientOptions;

  public constructor(credential: TokenCredential, subscriptionId: string, options?: AzureSdkOptions) {
    this.credential = credential;
    this.subscriptionId = subscriptionId;
    this.options = createArmRestClientOptions(options);
  }

  public async getSiteRuntimeConfig(
    resourceGroup: string,
    siteName: string,
    signal?: AbortSignal
  ): Promise<AppServiceRuntimeSiteConfig> {
    const token = await getArmAccessToken(this.credential, this.options.cloud);
    const siteUrl = armUrl(
      this.options.cloud,
      `/subscriptions/${encodeURIComponent(this.subscriptionId)}` +
        `/resourceGroups/${encodeURIComponent(resourceGroup)}` +
        `/providers/Microsoft.Web/sites/${encodeURIComponent(siteName)}?api-version=${WEB_API_VERSION}`
    );
    const configUrl = armUrl(
      this.options.cloud,
      `/subscriptions/${encodeURIComponent(this.subscriptionId)}` +
        `/resourceGroups/${encodeURIComponent(resourceGroup)}` +
        `/providers/Microsoft.Web/sites/${encodeURIComponent(siteName)}` +
        `/config/web?api-version=${WEB_API_VERSION}`
    );

    const [siteResponse, configResponse] = await Promise.all([
      armRequest(siteUrl, token, {
        maxAttempts: this.options.maxAttempts,
        requestTimeoutMs: this.options.requestTimeoutMs,
        operation: 'App Service site read',
        signal,
        sleep: this.options.sleep,
        random: this.options.random
      }),
      armRequest(configUrl, token, {
        maxAttempts: this.options.maxAttempts,
        requestTimeoutMs: this.options.requestTimeoutMs,
        operation: 'App Service web config read',
        signal,
        sleep: this.options.sleep,
        random: this.options.random
      })
    ]);

    if (siteResponse.status === 401 || siteResponse.status === 403) {
      throw new Error(`AuthorizationFailed: App Service site read returned HTTP ${siteResponse.status}`);
    }
    if (!siteResponse.ok) {
      throw new Error(`App Service site read failed with HTTP ${siteResponse.status}`);
    }

    const site = (await siteResponse.json()) as SiteArmEnvelope;
    let config: ConfigArmEnvelope | undefined;
    if (configResponse.ok) {
      config = (await configResponse.json()) as ConfigArmEnvelope;
    } else if (configResponse.status !== 401 && configResponse.status !== 403) {
      config = undefined;
    } else {
      throw new Error(`AuthorizationFailed: App Service web config read returned HTTP ${configResponse.status}`);
    }

    const defaultHostName = str(site.properties?.defaultHostName);
    const apiDefinitionUrl =
      str(config?.properties?.apiDefinition?.url) ?? str(site.properties?.siteConfig?.apiDefinition?.url);
    const apiSpecPath = extractApiSpecPath(config, site);
    const scmHostName = deriveCorrelatedScmHostName(defaultHostName, site.properties?.enabledHostNames);
    const publicNetworkAccess = str(site.properties?.publicNetworkAccess);

    return {
      ...(apiDefinitionUrl ? { apiDefinitionUrl } : {}),
      ...(apiSpecPath ? { apiSpecPath } : {}),
      ...(defaultHostName ? { defaultHostName } : {}),
      ...(scmHostName ? { scmHostName } : {}),
      ...(publicNetworkAccess ? { publicNetworkAccess } : {})
    };
  }

  public async fetchApiSpecFromScm(
    resourceGroup: string,
    siteName: string,
    apiSpecPath: string,
    signal?: AbortSignal
  ): Promise<AppServiceScmFetchResult> {
    const runtime = await this.getSiteRuntimeConfig(resourceGroup, siteName, signal);
    if ((runtime.publicNetworkAccess ?? '').toLowerCase() === 'disabled') {
      return {
        kind: 'private-network-unreachable',
        detail: `App Service ${siteName} has publicNetworkAccess disabled; SCM artifact fetch is unreachable from this runner`
      };
    }

    // Only the ARM-correlated scmHostName from getSiteRuntimeConfig is usable.
    // Re-verify exact correlation to the ARM-owned default hostname before any SCM token.
    const scmHost = runtime.scmHostName;
    const verified = scmHost
      ? deriveCorrelatedScmHostName(runtime.defaultHostName, [scmHost])
      : undefined;
    if (!scmHost || !verified || verified !== scmHost) {
      return {
        kind: 'scm-disabled',
        detail: `App Service ${siteName} has no ARM-correlated SCM hostname`
      };
    }

    let vfsPath: string;
    try {
      vfsPath = normalizeVfsPath(apiSpecPath);
    } catch (error) {
      return { kind: 'failed', detail: error instanceof Error ? error.message : String(error) };
    }

    // Least-privilege: ARM/Entra bearer to the site's own correlated SCM host only —
    // never arbitrary hosts, never publishing user/password list APIs.
    // Token is obtained only after exact host correlation (Microsoft Learn: Entra auth
    // for SCM; Microsoft.Web/sites/publish/Action required).
    const token = await getArmAccessToken(this.credential, this.options.cloud);
    const url = `https://${scmHost}/api/vfs/${vfsPath}`;
    const requestSignal = composeRequestSignal(this.options.requestTimeoutMs, signal);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json, application/yaml, text/yaml, text/plain, */*'
        },
        redirect: 'manual',
        signal: requestSignal
      });

      // Never follow redirects — refuse to forward the bearer to another host.
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (response.body) {
          try {
            await response.body.cancel();
          } catch {
            // ignore
          }
        }
        return {
          kind: 'failed',
          detail: 'SCM VFS returned unexpected redirect'
        };
      }

      if (response.status === 401 || response.status === 403) {
        const diagnostic = await readBoundedResponseText(response, MAX_DIAGNOSTIC_BYTES);
        if (
          response.status === 403 &&
          /scm|kudu|basic auth|publishing|scm is disabled|remote debugging/i.test(diagnostic.text)
        ) {
          return { kind: 'scm-disabled', detail: `SCM refused access for ${siteName}` };
        }
        return { kind: 'permission-denied', status: response.status };
      }
      if (response.status === 404) {
        if (response.body) {
          try {
            await response.body.cancel();
          } catch {
            // ignore
          }
        }
        return { kind: 'not-found', status: 404 };
      }
      if (!response.ok) {
        await readBoundedResponseText(response, MAX_DIAGNOSTIC_BYTES);
        return { kind: 'failed', detail: `SCM VFS read failed with HTTP ${response.status}` };
      }

      const body = await readBoundedResponseText(response, MAX_SCM_ARTIFACT_BYTES);
        if (body.overflow) {
          return {
            kind: 'failed',
            detail: 'SCM VFS artifact exceeds size ceiling'
        };
      }
      const content = body.text;
      if (!content.trim()) {
        return { kind: 'failed', detail: 'SCM VFS returned an empty artifact' };
      }
      return {
        kind: 'content',
        content: content.endsWith('\n') ? content : `${content}\n`,
        ...(response.headers.get('content-type')
          ? { contentType: response.headers.get('content-type') ?? undefined }
          : {})
      };
    } catch (error) {
      if (error instanceof SpecFetchError && error.code === 'private-network-unreachable') {
        return { kind: 'private-network-unreachable', detail: error.message };
      }
      if (isTimeoutAbort(error, requestSignal, signal)) {
        return { kind: 'failed', detail: `SCM request timed out for ${siteName}` };
      }
      const message = error instanceof Error ? error.message : String(error);
      if (/econnrefused|etimedout|ehostunreach|enetunreach|enotfound|socket hang up/i.test(message)) {
        return {
          kind: 'private-network-unreachable',
          detail: `SCM host ${scmHost} is unreachable from this runner`
        };
      }
      return { kind: 'failed', detail: 'SCM VFS read failed' };
    }
  }
}
