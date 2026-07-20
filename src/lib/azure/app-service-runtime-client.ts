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

function deriveScmHostName(defaultHostName: string | undefined, enabledHostNames: unknown): string | undefined {
  if (Array.isArray(enabledHostNames)) {
    for (const host of enabledHostNames) {
      const value = str(host)?.toLowerCase();
      if (value && value.includes('.scm.')) return value;
    }
  }
  const host = str(defaultHostName)?.toLowerCase();
  if (!host) return undefined;
  // Contoso.azurewebsites.net -> contoso.scm.azurewebsites.net
  const match = /^([^.]+)\.(.+)$/.exec(host);
  if (!match) return undefined;
  return `${match[1]}.scm.${match[2]}`;
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

/**
 * App Service runtime-declared spec seams:
 *  - read `aiIntegration.ApiSpecPath` (and apiDefinition.url) from site config
 *  - optionally retrieve bytes from the site's own SCM/VFS host using the ARM token
 *
 * Never forwards credentials to arbitrary hosts. Never calls publishing password APIs.
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
    const scmHostName = deriveScmHostName(defaultHostName, site.properties?.enabledHostNames);
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
    const scmHost = runtime.scmHostName;
    if (!scmHost) {
      return { kind: 'scm-disabled', detail: `App Service ${siteName} has no discoverable SCM hostname` };
    }

    let vfsPath: string;
    try {
      vfsPath = normalizeVfsPath(apiSpecPath);
    } catch (error) {
      return { kind: 'failed', detail: error instanceof Error ? error.message : String(error) };
    }

    // Least-privilege: ARM bearer to the site's own SCM host only — never arbitrary hosts,
    // never publishing user/password list APIs.
    const token = await getArmAccessToken(this.credential, this.options.cloud);
    const url = `https://${scmHost}/api/vfs/${vfsPath}`;
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json, application/yaml, text/yaml, text/plain, */*'
        },
        redirect: 'manual',
        signal: signal ?? AbortSignal.timeout(this.options.requestTimeoutMs)
      });

      if (response.status === 401 || response.status === 403) {
        return { kind: 'permission-denied', status: response.status };
      }
      if (response.status === 404) {
        return { kind: 'not-found', status: 404 };
      }
      if (response.status === 403 && /scm|kudu|basic auth|publishing/i.test(await response.text().catch(() => ''))) {
        return { kind: 'scm-disabled', detail: `SCM refused access for ${siteName}` };
      }
      if (!response.ok) {
        return { kind: 'failed', detail: `SCM VFS read failed with HTTP ${response.status}` };
      }
      const content = await response.text();
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
      const message = error instanceof Error ? error.message : String(error);
      if (/econnrefused|etimedout|ehostunreach|enetunreach|enotfound|socket hang up/i.test(message)) {
        return {
          kind: 'private-network-unreachable',
          detail: `SCM host ${scmHost} is unreachable from this runner (${message})`
        };
      }
      return { kind: 'failed', detail: message };
    }
  }
}
