import type { TokenCredential } from '@azure/identity';

import { isSecretValue, sanitizeEvidenceValue } from '../repo/secret-hygiene.js';
import { parseRepoSlug } from '../estate/enumerate.js';
import type { AzureSdkOptions } from './clients.js';
import {
  armRequest,
  armUrl,
  createArmRestClientOptions,
  getArmAccessToken,
  MAX_ARM_LIST_PAGES,
  takeNextLink,
  type ArmRestClientOptions
} from './arm-rest.js';

/**
 * App Service site source-control uses the repository's current Microsoft.Web
 * management API version (same pin as other Web REST clients here).
 * Microsoft Learn documents GET sites/{name}/sourcecontrols/web with repoUrl/branch.
 */
const WEB_API_VERSION = '2023-12-01';

/**
 * Container Apps source-controls list uses the documented stable Microsoft.App
 * version (2026-01-01). Microsoft Learn documents containerApps/{name}/sourcecontrols
 * with repoUrl/branch. Credential-bearing githubActionConfiguration fields are never retained.
 */
const CONTAINER_APPS_API_VERSION = '2026-01-01';

/** Hard ceiling for ARM source-control response bodies (secret-safe projection only). */
const MAX_SOURCE_CONTROL_BODY_BYTES = 256 * 1024;

export type SourceControlWorkloadKind = 'app-service' | 'container-apps';

/** Secret-safe association evidence only — never a specification source. */
export interface SourceControlAssociation {
  /** Owning App Service site or Container App ARM ID (not the sourcecontrols child). */
  resourceId: string;
  resourceGroup: string;
  name: string;
  kind: SourceControlWorkloadKind;
  /** Normalized HTTPS origin+path without .git / userinfo / query / fragment. */
  repoUrl: string;
  branch: string;
  /** Normalized org/repo slug when parseable. */
  org?: string;
  repo?: string;
}

export type SourceControlLookupStatus =
  | { status: 'ok'; association: SourceControlAssociation }
  | { status: 'absent' }
  | { status: 'unavailable'; reason: 'iam' | 'malformed' | 'oversized' | 'pagination' | 'error'; detail: string };

export interface ContainerAppSummary {
  id: string;
  name: string;
  resourceGroup: string;
}

export interface AzureSourceControlClient {
  getAppServiceSourceControl(
    resourceGroup: string,
    siteName: string,
    signal?: AbortSignal
  ): Promise<SourceControlLookupStatus>;
  listContainerAppSourceControls(
    resourceGroup: string,
    containerAppName: string,
    signal?: AbortSignal
  ): Promise<SourceControlLookupStatus[]>;
  /** Reader list of Container Apps within the selected subscription / optional RG. */
  listContainerApps(resourceGroup?: string, signal?: AbortSignal): Promise<ContainerAppSummary[]>;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function extractResourceGroup(resourceId: string | undefined): string {
  const match = /\/resourceGroups\/([^/]+)\//i.exec(resourceId ?? '');
  return match?.[1] ?? '';
}

function owningResourceId(kind: SourceControlWorkloadKind, resourceId: string, fallback: string): string {
  if (kind === 'app-service') {
    const match = /^(.*?\/providers\/Microsoft\.Web\/sites\/[^/]+)/i.exec(resourceId);
    return match?.[1] ?? fallback;
  }
  const match = /^(.*?\/providers\/Microsoft\.App\/containerApps\/[^/]+)/i.exec(resourceId);
  return match?.[1] ?? fallback;
}

/**
 * Normalize a source-control repository URL for exact org/repo comparison.
 * Strips userinfo, query, fragment, trailing .git; converts git@host:path to https.
 * Returns undefined when the URL is secret-shaped or not an org/repo coordinate.
 */
export function normalizeSourceControlRepoUrl(
  raw: string | undefined
): { repoUrl: string; org: string; repo: string } | undefined {
  const trimmed = (raw ?? '').trim();
  if (!trimmed || isSecretValue(trimmed)) return undefined;

  let candidate = trimmed;
  const sshMatch = /^git@([^:]+):(.+?)(?:\.git)?$/i.exec(trimmed);
  if (sshMatch) {
    candidate = `https://${sshMatch[1]}/${sshMatch[2]}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    const slug = parseRepoSlug(trimmed);
    if (!slug) return undefined;
    return {
      repoUrl: `https://github.com/${slug.org}/${slug.repo}`,
      org: slug.org,
      repo: slug.repo
    };
  }

  if (parsed.username || parsed.password) return undefined;
  parsed.username = '';
  parsed.password = '';
  parsed.search = '';
  parsed.hash = '';
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length < 2) return undefined;
  const org = segments[0]!;
  const repo = segments[1]!.replace(/\.git$/i, '');
  const slug = parseRepoSlug(`${org}/${repo}`);
  if (!slug) return undefined;
  const normalizedPath = `/${slug.org}/${slug.repo}`;
  return {
    repoUrl: `${parsed.protocol}//${parsed.host.toLowerCase()}${normalizedPath}`,
    org: slug.org,
    repo: slug.repo
  };
}

/** Exact branch compare after trim; empty branches never match. */
export function sourceControlBranchMatches(associated: string | undefined, expected: string | undefined): boolean {
  const left = (associated ?? '').trim();
  const right = (expected ?? '').trim();
  return left.length > 0 && right.length > 0 && left === right;
}

/**
 * Exact normalized org/repo + branch match against the running repository context.
 */
export function sourceControlMatchesRepoContext(
  association: Pick<SourceControlAssociation, 'org' | 'repo' | 'branch' | 'repoUrl'>,
  repoSlug: string | undefined,
  ref: string | undefined
): boolean {
  if (!sourceControlBranchMatches(association.branch, ref)) return false;
  const expected = parseRepoSlug(repoSlug ?? '');
  if (!expected) return false;
  if (association.org && association.repo) {
    return (
      association.org.toLowerCase() === expected.org.toLowerCase() &&
      association.repo.toLowerCase() === expected.repo.toLowerCase()
    );
  }
  const fromUrl = normalizeSourceControlRepoUrl(association.repoUrl);
  if (!fromUrl) return false;
  return (
    fromUrl.org.toLowerCase() === expected.org.toLowerCase() &&
    fromUrl.repo.toLowerCase() === expected.repo.toLowerCase()
  );
}

async function cancelResponseBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!body) return;
  try {
    await body.cancel();
  } catch {
    // Ignore cancel failures; the caller already treats the body as discarded.
  }
}

/**
 * Read and parse a JSON response with a hard 256 KiB ceiling.
 * Inspects Content-Length first, then streams chunks; cancels the reader on
 * overflow and never retains partial/raw body bytes in thrown details.
 */
async function readBoundedJson(
  response: Response,
  operation: string,
  signal?: AbortSignal
): Promise<unknown> {
  const contentLength = response.headers.get('content-length');
  if (contentLength) {
    const declared = Number.parseInt(contentLength, 10);
    if (Number.isFinite(declared) && declared > MAX_SOURCE_CONTROL_BODY_BYTES) {
      await cancelResponseBody(response.body);
      throw new Error(`${operation} response exceeded ${MAX_SOURCE_CONTROL_BODY_BYTES} bytes; aborting`);
    }
  }

  if (!response.body) {
    throw new Error(`${operation} returned malformed JSON; aborting`);
  }

  const reader = response.body.getReader();
  const onAbort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  if (signal) {
    if (signal.aborted) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`${operation} aborted`);
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }

  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      if (signal?.aborted) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`${operation} aborted`);
      }
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_SOURCE_CONTROL_BODY_BYTES) {
        await reader.cancel();
        // Never retain partial/raw content — overflow detail is size-only.
        throw new Error(`${operation} response exceeded ${MAX_SOURCE_CONTROL_BODY_BYTES} bytes; aborting`);
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
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }

  const buffer = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder('utf-8').decode(buffer);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${operation} returned malformed JSON; aborting`);
  }
}

function projectAssociation(input: {
  kind: SourceControlWorkloadKind;
  resourceGroup: string;
  name: string;
  fallbackResourceId: string;
  id?: string;
  repoUrl?: string;
  branch?: string;
}): SourceControlAssociation | undefined {
  const normalized = normalizeSourceControlRepoUrl(input.repoUrl);
  const branch = str(input.branch);
  if (!normalized || !branch || isSecretValue(branch)) return undefined;
  const resourceId = owningResourceId(
    input.kind,
    input.id ?? input.fallbackResourceId,
    input.fallbackResourceId
  );
  return {
    resourceId,
    resourceGroup: input.resourceGroup,
    name: input.name,
    kind: input.kind,
    repoUrl: normalized.repoUrl,
    branch,
    org: normalized.org,
    repo: normalized.repo
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * Reader-only ARM client for App Service and Container Apps source-control
 * association evidence. Projects only normalized repoUrl + branch + owning
 * resource ID. Never retains githubActionConfiguration, tokens, credentials,
 * registry fields, raw responses, or query strings.
 */
export class SourceControlSdkClient implements AzureSourceControlClient {
  private readonly credential: TokenCredential;
  private readonly subscriptionId: string;
  private readonly options: ArmRestClientOptions;

  public constructor(credential: TokenCredential, subscriptionId: string, options?: AzureSdkOptions) {
    this.credential = credential;
    this.subscriptionId = subscriptionId;
    this.options = createArmRestClientOptions(options);
  }

  public async getAppServiceSourceControl(
    resourceGroup: string,
    siteName: string,
    signal?: AbortSignal
  ): Promise<SourceControlLookupStatus> {
    const operation = 'App Service source-control read';
    try {
      const token = await getArmAccessToken(this.credential, this.options.cloud);
      const url = armUrl(
        this.options.cloud,
        `/subscriptions/${encodeURIComponent(this.subscriptionId)}` +
          `/resourceGroups/${encodeURIComponent(resourceGroup)}` +
          `/providers/Microsoft.Web/sites/${encodeURIComponent(siteName)}` +
          `/sourcecontrols/web?api-version=${WEB_API_VERSION}`
      );
      const response = await armRequest(url, token, {
        maxAttempts: this.options.maxAttempts,
        requestTimeoutMs: this.options.requestTimeoutMs,
        operation,
        signal,
        sleep: this.options.sleep,
        random: this.options.random
      });
      if (response.status === 401 || response.status === 403) {
        return {
          status: 'unavailable',
          reason: 'iam',
          detail: `App Service source-control association unavailable (HTTP ${response.status})`
        };
      }
      if (response.status === 404) {
        return { status: 'absent' };
      }
      if (!response.ok) {
        return {
          status: 'unavailable',
          reason: 'error',
          detail: `App Service source-control read failed with HTTP ${response.status}`
        };
      }
      const body = await readBoundedJson(response, operation, signal);
      const record = asRecord(body);
      const properties = asRecord(record?.properties) ?? {};
      // Never read gitHubActionConfiguration / credentials — project repoUrl/branch only.
      const fallbackId =
        `/subscriptions/${this.subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Web/sites/${siteName}`;
      const association = projectAssociation({
        kind: 'app-service',
        resourceGroup,
        name: siteName,
        fallbackResourceId: fallbackId,
        id: str(record?.id),
        repoUrl: str(properties.repoUrl),
        branch: str(properties.branch)
      });
      if (!association) {
        return { status: 'absent' };
      }
      return { status: 'ok', association };
    } catch (error) {
      return mapTerminalError(error, operation);
    }
  }

  public async listContainerAppSourceControls(
    resourceGroup: string,
    containerAppName: string,
    signal?: AbortSignal
  ): Promise<SourceControlLookupStatus[]> {
    const operation = 'Container Apps source-control list';
    try {
      const token = await getArmAccessToken(this.credential, this.options.cloud);
      let url: string | undefined = armUrl(
        this.options.cloud,
        `/subscriptions/${encodeURIComponent(this.subscriptionId)}` +
          `/resourceGroups/${encodeURIComponent(resourceGroup)}` +
          `/providers/Microsoft.App/containerApps/${encodeURIComponent(containerAppName)}` +
          `/sourcecontrols?api-version=${CONTAINER_APPS_API_VERSION}`
      );
      const seen = new Set<string>();
      const results: SourceControlLookupStatus[] = [];
      let pages = 0;
      while (url) {
        pages += 1;
        if (pages > MAX_ARM_LIST_PAGES) {
          throw new Error(`${operation} pagination exceeded ${MAX_ARM_LIST_PAGES} pages; aborting`);
        }
        const response = await armRequest(url, token, {
          maxAttempts: this.options.maxAttempts,
          requestTimeoutMs: this.options.requestTimeoutMs,
          operation,
          signal,
          sleep: this.options.sleep,
          random: this.options.random
        });
        if (response.status === 401 || response.status === 403) {
          return [
            {
              status: 'unavailable',
              reason: 'iam',
              detail: `Container Apps source-control association unavailable (HTTP ${response.status})`
            }
          ];
        }
        if (response.status === 404) {
          return [{ status: 'absent' }];
        }
        if (!response.ok) {
          return [
            {
              status: 'unavailable',
              reason: 'error',
              detail: `Container Apps source-control list failed with HTTP ${response.status}`
            }
          ];
        }
        const body = await readBoundedJson(response, operation, signal);
        const record = asRecord(body);
        const values = Array.isArray(record?.value) ? record.value : [];
        const fallbackId =
          `/subscriptions/${this.subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.App/containerApps/${containerAppName}`;
        for (const entry of values) {
          const item = asRecord(entry);
          const properties = asRecord(item?.properties) ?? {};
          // githubActionConfiguration / registry / credential fields are intentionally unread.
          const association = projectAssociation({
            kind: 'container-apps',
            resourceGroup,
            name: containerAppName,
            fallbackResourceId: fallbackId,
            id: str(item?.id),
            repoUrl: str(properties.repoUrl),
            branch: str(properties.branch)
          });
          if (association) {
            results.push({ status: 'ok', association });
          }
        }
        url = takeNextLink(str(record?.nextLink), url, seen, this.options.cloud, operation);
      }
      return results.length > 0 ? results : [{ status: 'absent' }];
    } catch (error) {
      return [mapTerminalError(error, operation)];
    }
  }

  public async listContainerApps(resourceGroup?: string, signal?: AbortSignal): Promise<ContainerAppSummary[]> {
    const operation = 'Container Apps inventory';
    const token = await getArmAccessToken(this.credential, this.options.cloud);
    const scope = resourceGroup
      ? `resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.App/containerApps`
      : 'providers/Microsoft.App/containerApps';
    let url: string | undefined = armUrl(
      this.options.cloud,
      `/subscriptions/${encodeURIComponent(this.subscriptionId)}/${scope}?api-version=${CONTAINER_APPS_API_VERSION}`
    );
    const seen = new Set<string>();
    const summaries: ContainerAppSummary[] = [];
    let pages = 0;
    while (url) {
      pages += 1;
      if (pages > MAX_ARM_LIST_PAGES) {
        throw new Error(`${operation} pagination exceeded ${MAX_ARM_LIST_PAGES} pages; aborting`);
      }
      const response = await armRequest(url, token, {
        maxAttempts: this.options.maxAttempts,
        requestTimeoutMs: this.options.requestTimeoutMs,
        operation,
        signal,
        sleep: this.options.sleep,
        random: this.options.random
      });
      if (response.status === 401 || response.status === 403) {
        // Inventory IAM denial is fail-soft empty for association enrichment.
        return [];
      }
      if (!response.ok) {
        throw new Error(`${operation} failed with HTTP ${response.status}`);
      }
      const body = await readBoundedJson(response, operation, signal);
      const record = asRecord(body);
      for (const entry of Array.isArray(record?.value) ? record.value : []) {
        const item = asRecord(entry);
        const id = str(item?.id);
        const name = str(item?.name);
        if (!id || !name) continue;
        summaries.push({
          id,
          name,
          resourceGroup: extractResourceGroup(id) || (resourceGroup ?? '')
        });
      }
      url = takeNextLink(str(record?.nextLink), url, seen, this.options.cloud, operation);
    }
    return summaries;
  }
}

function mapTerminalError(error: unknown, operation: string): SourceControlLookupStatus {
  const message = error instanceof Error ? error.message : String(error);
  if (/exceeded .* bytes|malformed JSON/i.test(message)) {
    return {
      status: 'unavailable',
      reason: /exceeded .* bytes/i.test(message) ? 'oversized' : 'malformed',
      detail: sanitizeEvidenceValue(message)
    };
  }
  if (/repeated nextLink|pagination exceeded|outside the configured ARM|must be HTTPS|malformed nextLink/i.test(message)) {
    return {
      status: 'unavailable',
      reason: 'pagination',
      detail: sanitizeEvidenceValue(message)
    };
  }
  if (/authorizationfailed|forbidden|\b401\b|\b403\b/i.test(message)) {
    return {
      status: 'unavailable',
      reason: 'iam',
      detail: `${operation} association unavailable`
    };
  }
  return {
    status: 'unavailable',
    reason: 'error',
    detail: sanitizeEvidenceValue(message)
  };
}

/** Association-only evidence sentence; never includes credentials or raw ARM payloads. */
export function sourceControlAssociationEvidence(association: SourceControlAssociation): string {
  const slug =
    association.org && association.repo
      ? `${association.org}/${association.repo}`
      : sanitizeEvidenceValue(association.repoUrl);
  return `Azure ${association.kind} source-control association repo ${slug} branch ${sanitizeEvidenceValue(association.branch)} (association-only; not a specification source)`;
}
