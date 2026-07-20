import type { TokenCredential } from '@azure/identity';

import { fetchSpecFromUrl } from '../fetch/spec-fetcher.js';
import { sanitizeLogMessage } from '../logging/sanitize.js';
import {
  computeBoundedRetryDelayMs,
  isTransientHttpStatus,
  sleep as defaultSleep
} from '../retry.js';
import {
  armManagementUrl,
  assertSafeArmNextLink,
  resolveAzureCloudProfile,
  type AzureCloudProfile
} from './cloud.js';
import type { AzureSdkOptions } from './clients.js';

/** Documented API Center management-plane version for inventory and export. */
export const API_CENTER_API_VERSION = '2024-03-01';

/**
 * Absolute ceiling on pages consumed from any API Center list surface.
 * Matches the shared ARM inventory bound used elsewhere in this action.
 */
const MAX_LIST_PAGES = 100;

/** Total definition headers retained from an API Center hierarchy inventory. */
export const MAX_API_CENTER_INVENTORY = 1000;

/** Per-parent child ceiling to prevent hierarchy fan-out from multiplying requests. */
export const MAX_API_CENTER_CHILDREN_PER_LEVEL = 200;

/** Default bound on 202 LRO poll iterations for exportSpecification. */
const DEFAULT_MAX_LRO_POLLS = 30;

export interface ApiCenterSdkOptions extends AzureSdkOptions {
  /** Max Location / Azure-AsyncOperation poll iterations for export LRO. */
  maxLroPolls?: number;
  /** Wall-clock ceiling for a single export LRO (milliseconds). */
  maxLroWallClockMs?: number;
}

export interface ApiCenterDeploymentSummary {
  name: string;
  environmentId?: string;
  runtimeType?: string;
}

export interface ApiCenterDefinitionSummary {
  id: string;
  name: string;
  title?: string;
  resourceGroup: string;
  serviceName: string;
  workspaceName: string;
  apiName: string;
  apiTitle?: string;
  versionName: string;
  versionTitle?: string;
  lifecycleStage?: string;
  specificationName?: string;
  specificationVersion?: string;
  tags: Record<string, string>;
  /** Deployment/environment association metadata only — never a byte source. */
  deployments?: ApiCenterDeploymentSummary[];
}

/** Array-compatible API Center inventory with an observable truncation signal. */
export type ApiCenterDefinitionsResult = ApiCenterDefinitionSummary[] & { truncated?: boolean };

export interface ApiCenterExportCoordinates {
  resourceGroup: string;
  serviceName: string;
  workspaceName: string;
  apiName: string;
  versionName: string;
  definitionName: string;
}

/** Version coordinates for optional deployment/environment association enrichment. */
export interface ApiCenterVersionCoordinates {
  resourceGroup: string;
  serviceName: string;
  workspaceName: string;
  apiName: string;
  versionName: string;
}

export interface ApiCenterExportResult {
  content: string;
  source: 'inline' | 'link';
}

export interface AzureApiCenterClient {
  listServices(
    resourceGroup?: string,
    signal?: AbortSignal
  ): Promise<Array<{ id: string; name: string; resourceGroup: string; tags: Record<string, string> }>>;
  /**
   * Header inventory: services → workspaces → APIs → versions → definitions.
   * Does not list deployments or call exportSpecification.
   */
  listDefinitions(resourceGroup?: string, signal?: AbortSignal): Promise<ApiCenterDefinitionsResult>;
  /**
   * Optional association enrichment for a selected version. Callers treat
   * authorization/other failures as empty (fail-soft); this method never throws
   * for deployment listing denials.
   */
  listDeployments(coords: ApiCenterVersionCoordinates, signal?: AbortSignal): Promise<ApiCenterDeploymentSummary[]>;
  exportSpecification(coords: ApiCenterExportCoordinates, signal?: AbortSignal): Promise<ApiCenterExportResult>;
  probeApiCenterReadAccess(resourceGroup?: string, signal?: AbortSignal): Promise<void>;
}

interface ArmListEnvelope<T> {
  value?: T[];
  nextLink?: string;
}

interface ArmNamedResource {
  id?: string;
  name?: string;
  tags?: Record<string, string>;
  properties?: Record<string, unknown>;
}

function extractResourceGroup(resourceId: string | undefined): string {
  const match = /\/resourceGroups\/([^/]+)\//i.exec(resourceId ?? '');
  return match?.[1] ?? '';
}

async function getArmAccessToken(credential: TokenCredential, cloud: AzureCloudProfile): Promise<string> {
  const token = await credential.getToken(cloud.armTokenScope);
  if (!token) {
    throw new Error('Azure credential produced no ARM token');
  }
  return token.token;
}

function takeNextLink(
  nextLink: string | undefined,
  currentUrl: string,
  seen: Set<string>,
  cloud: AzureCloudProfile,
  operation: string
): string | undefined {
  if (nextLink === undefined) return undefined;
  if (nextLink === currentUrl || seen.has(nextLink)) {
    throw new Error(`${operation} pagination returned a repeated nextLink; aborting`);
  }
  const safe = assertSafeArmNextLink(nextLink, cloud, operation);
  seen.add(currentUrl);
  return safe;
}

function assertSafeArmPollUrl(url: string, cloud: AzureCloudProfile, operation: string): string {
  return assertSafeArmNextLink(url, cloud, operation);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * Defensively extract exported specification bytes from documented and observed
 * ApiSpecExportResult shapes: top-level value/content string or object, nested
 * properties, or a short-lived HTTPS link (format=link).
 */
export function extractApiCenterExportPayload(body: unknown): { kind: 'inline'; content: string } | { kind: 'link'; url: string } | undefined {
  const root = asRecord(body);
  if (!root) return undefined;

  const format =
    typeof root.format === 'string'
      ? root.format.toLowerCase()
      : typeof asRecord(root.properties)?.format === 'string'
        ? String(asRecord(root.properties)!.format).toLowerCase()
        : undefined;

  const candidates: unknown[] = [
    root.value,
    root.content,
    asRecord(root.properties)?.value,
    asRecord(root.properties)?.content,
    asRecord(root.result)?.value,
    asRecord(root.result)?.content
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      if (format === 'link' || /^https:\/\//i.test(candidate.trim())) {
        return { kind: 'link', url: candidate.trim() };
      }
      return { kind: 'inline', content: candidate };
    }
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      return { kind: 'inline', content: JSON.stringify(candidate) };
    }
  }
  return undefined;
}

  /**
   * Azure API Center management-plane client (api-version 2024-03-01).
   *
   * Header inventory walks services → workspaces → APIs → versions → definitions
   * through ARM GETs only. Deployment/environment association is a separate
   * selected enrichment. Spec bytes come exclusively from POST
   * exportSpecification (200 immediate or 202 LRO). Data-plane inventory APIs
   * are never called.
   */
  export class ApiCenterSdkClient implements AzureApiCenterClient {
    private readonly credential: TokenCredential;
    private readonly subscriptionId: string;
    private readonly cloud: AzureCloudProfile;
    private readonly maxAttempts: number;
    private readonly requestTimeoutMs: number;
    private readonly maxLroPolls: number;
    private readonly maxLroWallClockMs: number;
    private readonly sleep: (delayMs: number) => Promise<void>;
    private readonly random: () => number;

    public constructor(credential: TokenCredential, subscriptionId: string, options?: ApiCenterSdkOptions) {
      this.credential = credential;
      this.subscriptionId = subscriptionId;
      this.cloud = resolveAzureCloudProfile();
      this.maxAttempts = options?.maxAttempts ?? 3;
      this.requestTimeoutMs = options?.requestTimeoutMs ?? 30000;
      this.maxLroPolls = options?.maxLroPolls ?? DEFAULT_MAX_LRO_POLLS;
      this.maxLroWallClockMs = options?.maxLroWallClockMs ?? Math.max(this.requestTimeoutMs * this.maxAttempts, 120_000);
      this.sleep = options?.sleep ?? defaultSleep;
      this.random = options?.random ?? Math.random;
    }

    public async listServices(
      resourceGroup?: string,
      signal?: AbortSignal
    ): Promise<Array<{ id: string; name: string; resourceGroup: string; tags: Record<string, string> }>> {
      const scope = resourceGroup
        ? `resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.ApiCenter/services`
        : 'providers/Microsoft.ApiCenter/services';
      const first = armManagementUrl(
        this.cloud,
        `/subscriptions/${encodeURIComponent(this.subscriptionId)}/${scope}?api-version=${API_CENTER_API_VERSION}`
      );
      const entries = await this.listPaged<ArmNamedResource>(first, 'API Center service listing', signal);
      return entries
        .filter((entry) => entry.id && entry.name)
        .map((entry) => ({
          id: entry.id!,
          name: entry.name!,
          resourceGroup: extractResourceGroup(entry.id),
          tags: entry.tags ?? {}
        }));
    }

    public async listDefinitions(resourceGroup?: string, signal?: AbortSignal): Promise<ApiCenterDefinitionsResult> {
      const services = await this.listServices(resourceGroup, signal);
      const definitions: ApiCenterDefinitionsResult = [];
      let truncated = false;
      const markTruncated = (): ApiCenterDefinitionsResult => {
        Object.defineProperty(definitions, 'truncated', { value: true, enumerable: false });
        return definitions;
      };
      const boundedChildren = <T>(children: T[]): T[] => {
        if (children.length > MAX_API_CENTER_CHILDREN_PER_LEVEL) truncated = true;
        return children.slice(0, MAX_API_CENTER_CHILDREN_PER_LEVEL);
      };
      for (const service of services) {
        signal?.throwIfAborted();
        const workspaces = await this.listNamedChildren(
          service.resourceGroup,
          service.name,
          'workspaces',
          'API Center workspace listing',
          signal
        );
        for (const workspace of boundedChildren(workspaces)) {
          signal?.throwIfAborted();
          const apis = await this.listNamedChildren(
            service.resourceGroup,
            service.name,
            `workspaces/${encodeURIComponent(workspace.name)}/apis`,
            'API Center API listing',
            signal
          );
          for (const api of boundedChildren(apis)) {
            signal?.throwIfAborted();
            const versions = await this.listNamedChildren(
              service.resourceGroup,
              service.name,
              `workspaces/${encodeURIComponent(workspace.name)}/apis/${encodeURIComponent(api.name)}/versions`,
              'API Center version listing',
              signal
            );
            for (const version of boundedChildren(versions)) {
              signal?.throwIfAborted();
              const versionProps = asRecord(version.properties) ?? {};
              const defs = await this.listNamedChildren(
                service.resourceGroup,
                service.name,
                `workspaces/${encodeURIComponent(workspace.name)}/apis/${encodeURIComponent(api.name)}/versions/${encodeURIComponent(version.name)}/definitions`,
                'API Center definition listing',
                signal
              );
              for (const def of boundedChildren(defs)) {
                if (!def.id || !def.name) continue;
                if (definitions.length >= MAX_API_CENTER_INVENTORY) {
                  truncated = true;
                  return markTruncated();
                }
                const defProps = asRecord(def.properties) ?? {};
                const specification = asRecord(defProps.specification) ?? {};
                definitions.push({
                  id: def.id,
                  name: def.name,
                  title: typeof defProps.title === 'string' ? defProps.title : undefined,
                  resourceGroup: service.resourceGroup,
                  serviceName: service.name,
                  workspaceName: workspace.name,
                  apiName: api.name,
                  apiTitle: typeof asRecord(api.properties)?.title === 'string' ? String(asRecord(api.properties)!.title) : undefined,
                  versionName: version.name,
                  versionTitle: typeof versionProps.title === 'string' ? versionProps.title : undefined,
                  lifecycleStage:
                    typeof versionProps.lifecycleStage === 'string' ? versionProps.lifecycleStage : undefined,
                  specificationName: typeof specification.name === 'string' ? specification.name : undefined,
                  specificationVersion: typeof specification.version === 'string' ? specification.version : undefined,
                  tags: { ...service.tags, ...(def.tags ?? {}) }
                });
              }
            }
          }
        }
      }
      if (truncated) return markTruncated();
      return definitions;
    }

    public async listDeployments(
      coords: ApiCenterVersionCoordinates,
      signal?: AbortSignal
    ): Promise<ApiCenterDeploymentSummary[]> {
      try {
        const entries = await this.listNamedChildren(
          coords.resourceGroup,
          coords.serviceName,
          `workspaces/${encodeURIComponent(coords.workspaceName)}/apis/${encodeURIComponent(coords.apiName)}/versions/${encodeURIComponent(coords.versionName)}/deployments`,
          'API Center deployment listing',
          signal
        );
        return entries.map((entry) => {
          const props = asRecord(entry.properties) ?? {};
          const server = asRecord(props.server) ?? {};
          return {
            name: entry.name,
            ...(typeof props.environmentId === 'string' ? { environmentId: props.environmentId } : {}),
            ...(typeof server.type === 'string' ? { runtimeType: server.type } : {})
          };
        });
      } catch {
        // Deployments are association enrichment only; selected inventory must still succeed.
        return [];
      }
    }

  public async exportSpecification(
    coords: ApiCenterExportCoordinates,
    signal?: AbortSignal
  ): Promise<ApiCenterExportResult> {
    const token = await getArmAccessToken(this.credential, this.cloud);
    const url = armManagementUrl(
      this.cloud,
      `/subscriptions/${encodeURIComponent(this.subscriptionId)}` +
        `/resourceGroups/${encodeURIComponent(coords.resourceGroup)}` +
        `/providers/Microsoft.ApiCenter/services/${encodeURIComponent(coords.serviceName)}` +
        `/workspaces/${encodeURIComponent(coords.workspaceName)}` +
        `/apis/${encodeURIComponent(coords.apiName)}` +
        `/versions/${encodeURIComponent(coords.versionName)}` +
        `/definitions/${encodeURIComponent(coords.definitionName)}` +
        `/exportSpecification?api-version=${API_CENTER_API_VERSION}`
    );

    const response = await this.armRequest(url, token, {
      method: 'POST',
      operation: 'API Center exportSpecification',
      signal
    });

    if (response.status === 200) {
      return this.materializeExportResult(await response.json(), signal);
    }
    if (response.status === 202) {
      const body = await this.pollExportLro(response, token, signal);
      return this.materializeExportResult(body, signal);
    }
    throw new Error(`API Center exportSpecification failed with HTTP ${response.status}`);
  }

  public async probeApiCenterReadAccess(resourceGroup?: string, signal?: AbortSignal): Promise<void> {
    const token = await getArmAccessToken(this.credential, this.cloud);
    const scope = resourceGroup
      ? `resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.ApiCenter/services`
      : 'providers/Microsoft.ApiCenter/services';
    const url = armManagementUrl(
      this.cloud,
      `/subscriptions/${encodeURIComponent(this.subscriptionId)}/${scope}?api-version=${API_CENTER_API_VERSION}&$top=1`
    );
    const response = await this.armRequest(url, token, {
      method: 'GET',
      operation: 'API Center probe',
      signal
    });
    if (response.status === 401 || response.status === 403) {
      throw new Error(`AuthorizationFailed: API Center probe returned HTTP ${response.status}`);
    }
    if (!response.ok) {
      throw new Error(`API Center probe failed with HTTP ${response.status}`);
    }
  }

  private async listNamedChildren(
    resourceGroup: string,
    serviceName: string,
    relativePath: string,
    operation: string,
    signal?: AbortSignal
  ): Promise<Array<ArmNamedResource & { name: string }>> {
    const first = armManagementUrl(
      this.cloud,
      `/subscriptions/${encodeURIComponent(this.subscriptionId)}` +
        `/resourceGroups/${encodeURIComponent(resourceGroup)}` +
        `/providers/Microsoft.ApiCenter/services/${encodeURIComponent(serviceName)}` +
        `/${relativePath}?api-version=${API_CENTER_API_VERSION}`
    );
    const entries = await this.listPaged<ArmNamedResource>(first, operation, signal);
    return entries.filter((entry): entry is ArmNamedResource & { name: string } => Boolean(entry.name));
  }

  private async listPaged<T>(firstUrl: string, operation: string, signal?: AbortSignal): Promise<T[]> {
    const token = await getArmAccessToken(this.credential, this.cloud);
    let url: string | undefined = firstUrl;
    const entries: T[] = [];
    const seen = new Set<string>();
    let pages = 0;
    while (url) {
      signal?.throwIfAborted();
      pages += 1;
      if (pages > MAX_LIST_PAGES) {
        throw new Error(`${operation} pagination exceeded ${MAX_LIST_PAGES} pages; aborting`);
      }
      const response = await this.armRequest(url, token, { method: 'GET', operation, signal });
      if (response.status === 401 || response.status === 403) {
        throw new Error(`AuthorizationFailed: ${operation} returned HTTP ${response.status}`);
      }
      if (!response.ok) {
        throw new Error(`${operation} failed with HTTP ${response.status}`);
      }
      const body = (await response.json()) as ArmListEnvelope<T>;
      entries.push(...(body.value ?? []));
      url = takeNextLink(body.nextLink, url, seen, this.cloud, operation);
    }
    return entries;
  }

  private async pollExportLro(
    initial: Response,
    token: string,
    signal?: AbortSignal
  ): Promise<unknown> {
    const started = Date.now();
    let pollUrl =
      initial.headers.get('Azure-AsyncOperation') ??
      initial.headers.get('azure-asyncoperation') ??
      initial.headers.get('Location') ??
      initial.headers.get('location');
    if (!pollUrl) {
      throw new Error('API Center exportSpecification returned 202 without Location or Azure-AsyncOperation');
    }
    pollUrl = assertSafeArmPollUrl(pollUrl, this.cloud, 'API Center exportSpecification LRO');

    let retryAfter = initial.headers.get('Retry-After') ?? initial.headers.get('retry-after');
    for (let poll = 1; poll <= this.maxLroPolls; poll += 1) {
      signal?.throwIfAborted();
      if (Date.now() - started > this.maxLroWallClockMs) {
        throw new Error(`API Center exportSpecification LRO exceeded ${this.maxLroWallClockMs}ms wall-clock ceiling`);
      }
      const delayMs = computeBoundedRetryDelayMs({
        attempt: poll,
        retryAfterHeader: retryAfter,
        random: this.random
      });
      await this.sleep(delayMs);

      const response = await this.armRequest(pollUrl, token, {
        method: 'GET',
        operation: 'API Center exportSpecification LRO poll',
        signal
      });
      retryAfter = response.headers.get('Retry-After') ?? response.headers.get('retry-after');

      if (response.status === 200) {
        const body: unknown = await response.json().catch(() => ({}));
        const payload = extractApiCenterExportPayload(body);
        if (payload) return body;
        // Some LROs wrap the result; keep polling only while still async.
        const status = typeof asRecord(body)?.status === 'string' ? String(asRecord(body)!.status).toLowerCase() : '';
        if (status === 'succeeded' || status === 'failed' || status === 'canceled') {
          if (status !== 'succeeded') {
            throw new Error(`API Center exportSpecification LRO ended with status ${status}`);
          }
          const result = asRecord(body)?.result ?? asRecord(body)?.properties ?? body;
          return result;
        }
        // 200 with final export body lacking an async status.
        if (payload === undefined && !status) {
          return body;
        }
      } else if (response.status === 202) {
        const next =
          response.headers.get('Azure-AsyncOperation') ??
          response.headers.get('azure-asyncoperation') ??
          response.headers.get('Location') ??
          response.headers.get('location') ??
          pollUrl;
        pollUrl = assertSafeArmPollUrl(next, this.cloud, 'API Center exportSpecification LRO');
      } else if (response.status >= 400 && response.status < 500 && !isTransientHttpStatus(response.status)) {
        throw new Error(`API Center exportSpecification LRO poll failed with HTTP ${response.status}`);
      } else if (!isTransientHttpStatus(response.status)) {
        throw new Error(`API Center exportSpecification LRO poll failed with HTTP ${response.status}`);
      }

      if (poll === this.maxLroPolls) {
        throw new Error(`API Center exportSpecification LRO poll exceeded ${this.maxLroPolls} attempts`);
      }
    }
    throw new Error(`API Center exportSpecification LRO poll exceeded ${this.maxLroPolls} attempts`);
  }

  private async materializeExportResult(body: unknown, signal?: AbortSignal): Promise<ApiCenterExportResult> {
    const payload = extractApiCenterExportPayload(body);
    if (!payload) {
      throw new Error('API Center exportSpecification returned no specification content');
    }
    if (payload.kind === 'inline') {
      return { content: payload.content, source: 'inline' };
    }
    try {
      const fetched = await fetchSpecFromUrl(payload.url, {
        timeoutMs: this.requestTimeoutMs,
        ...(signal ? {} : {})
      });
      return { content: fetched.content, source: 'link' };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(sanitizeLogMessage(`API Center export link fetch failed: ${detail}`), { cause: error });
    }
  }

  private async armRequest(
    url: string,
    token: string,
    options: {
      method: string;
      operation: string;
      signal?: AbortSignal;
      body?: string;
    }
  ): Promise<Response> {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      options.signal?.throwIfAborted();
      const requestSignal = AbortSignal.any([
        AbortSignal.timeout(this.requestTimeoutMs),
        ...(options.signal ? [options.signal] : [])
      ]);
      try {
        const response = await fetch(url, {
          method: options.method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(options.body !== undefined ? { 'content-type': 'application/json' } : {})
          },
          body: options.body,
          signal: requestSignal
        });
        if (response.ok || response.status === 202) {
          return response;
        }
        if (!isTransientHttpStatus(response.status)) {
          // Route through typed status so catch rethrows permanent 5xx (501/505)
          // the same way as 4xx — never via a 1xx–4xx-only message regex.
          throw new ArmHttpError(options.operation, response.status, response);
        }
        if (attempt === this.maxAttempts) {
          return response;
        }
        const delayMs = computeBoundedRetryDelayMs({
          attempt,
          retryAfterHeader: response.headers.get('retry-after'),
          random: this.random
        });
        await this.sleep(delayMs);
      } catch (error) {
        if (error instanceof ArmHttpError && !isTransientHttpStatus(error.status)) {
          return error.response;
        }
        if (options.signal?.aborted) throw error;
        if (attempt === this.maxAttempts) {
          throw new Error(`${options.operation} failed after ${attempt} attempt(s)`, { cause: error });
        }
        const delayMs = computeBoundedRetryDelayMs({ attempt, random: this.random });
        await this.sleep(delayMs);
      }
    }
    throw new Error(`${options.operation} exhausted its attempt limit`);
  }
}

/** Private to this helper: carries status (+ response) so catch can honor isTransientHttpStatus. */
class ArmHttpError extends Error {
  readonly status: number;
  readonly response: Response;

  constructor(operation: string, status: number, response: Response) {
    super(`${operation} failed with HTTP ${status}`);
    this.name = 'ArmHttpError';
    this.status = status;
    this.response = response;
  }
}
