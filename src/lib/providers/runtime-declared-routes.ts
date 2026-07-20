import type { ProviderProbeStatus } from '../../contracts.js';
import { fetchSpecFromUrl, SpecFetchError } from '../fetch/spec-fetcher.js';
import { parseAndValidateOpenApi } from '../spec/validate-openapi.js';
import type { SpecCandidate, SpecCandidateHeader, SpecExportResult, SpecProvider } from './types.js';
import { toSpecCandidate } from './types.js';

export type RuntimeDeclaredWorkloadKind =
  | 'app-service'
  | 'functions'
  | 'container-apps'
  | 'static-web-apps'
  | 'aci'
  | 'aks';

/**
 * An explicitly declared HTTPS specification target. Targets must originate from
 * repository/manifest evidence or an authorized ARM-owned host + declared path.
 * Blind common-path probing is intentionally unsupported.
 */
export interface RuntimeDeclaredSpecTarget {
  id: string;
  name: string;
  workloadKind: RuntimeDeclaredWorkloadKind;
  /** Exact HTTPS URL (no userinfo). */
  url: string;
  resourceId?: string;
  resourceGroup?: string;
  tags?: Record<string, string>;
  /** Provider/resource identity preserved for association. */
  providerResourceType?: string;
  evidence?: string[];
}

export interface RuntimeDeclaredRoutesProviderOptions {
  /** When false (default), the provider probes as available but lists nothing. */
  enabled?: boolean;
  targets?: RuntimeDeclaredSpecTarget[];
  requestTimeoutMs?: number;
}

function isAuthorizationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /authorizationfailed|forbidden|401|403/i.test(message);
}

function assertExactHttpsTarget(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (error) {
    throw new Error(`Runtime-declared spec URL is not a valid URL: ${url}`, { cause: error });
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`Runtime-declared spec URL must use HTTPS; got ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('Runtime-declared spec URL must not contain userinfo credentials');
  }
  return parsed;
}

/**
 * Runtime-declared specification routes for App Service, Functions, Container
 * Apps, Static Web Apps, ACI, and AKS workloads.
 *
 * Only exact binding URLs or authorized ARM-owned host + declared path targets
 * are accepted. No blind common-path estate probing. Fetches never forward
 * Azure/GitHub credentials. Validated documents are authoritative; invalid
 * documents remain association-only / unsupported.
 */
export class RuntimeDeclaredRoutesProvider implements SpecProvider {
  public readonly type = 'runtime-declared' as const;

  private readonly options: RuntimeDeclaredRoutesProviderOptions;

  public constructor(options: RuntimeDeclaredRoutesProviderOptions = {}) {
    this.options = options;
  }

  public async probe(): Promise<ProviderProbeStatus> {
    try {
      if (!(this.options.enabled ?? false)) {
        return 'available';
      }
      for (const target of this.options.targets ?? []) {
        assertExactHttpsTarget(target.url);
      }
      return 'available';
    } catch (error) {
      return isAuthorizationError(error) ? 'skipped:iam' : 'skipped:error';
    }
  }

  public async listCandidateHeaders(): Promise<SpecCandidateHeader[]> {
    const candidates = await this.listCandidates();
    return candidates.map((candidate) => ({ ...candidate, headerHydrated: true }));
  }

  public async hydrateCandidates(headers: SpecCandidateHeader[]): Promise<SpecCandidate[]> {
    return headers.map((header) => toSpecCandidate(header));
  }

  public async listCandidates(): Promise<SpecCandidate[]> {
    if (!(this.options.enabled ?? false)) {
      return [];
    }
    const candidates: SpecCandidate[] = [];
    for (const target of this.options.targets ?? []) {
      assertExactHttpsTarget(target.url);
      candidates.push({
        id: target.id,
        name: target.name,
        providerType: 'runtime-declared',
        resourceGroup: target.resourceGroup,
        tags: target.tags ?? {},
        supported: true,
        evidence: [
          `Runtime-declared ${target.workloadKind} specification URL ${target.url}`,
          ...(target.evidence ?? []),
          'No blind common-path probing was performed'
        ],
        meta: {
          workloadKind: target.workloadKind,
          specUrl: target.url,
          ...(target.resourceId ? { resourceId: target.resourceId } : {}),
          ...(target.providerResourceType ? { providerResourceType: target.providerResourceType } : {})
        }
      });
    }
    return candidates;
  }

  public async exportSpec(candidate: SpecCandidate): Promise<SpecExportResult> {
    const specUrl = candidate.meta.specUrl ?? '';
    if (!specUrl) {
      throw new Error(`Runtime-declared candidate ${candidate.name} has no specification URL`);
    }
    assertExactHttpsTarget(specUrl);

    let fetched;
    try {
      fetched = await fetchSpecFromUrl(specUrl, { timeoutMs: this.options.requestTimeoutMs });
    } catch (error) {
      if (error instanceof SpecFetchError && error.code === 'private-network-unreachable') {
        throw new Error(
          `Runtime-declared specification at ${specUrl} is private-network-unreachable from this runner`,
          { cause: error }
        );
      }
      if (error instanceof SpecFetchError && error.code === 'blocked-ssrf') {
        throw new Error(`Runtime-declared specification URL blocked by SSRF defenses: ${specUrl}`, {
          cause: error
        });
      }
      throw error;
    }

    try {
      const validated = parseAndValidateOpenApi(fetched.content);
      const normalized = fetched.content.endsWith('\n') ? fetched.content : `${fetched.content}\n`;
      return {
        content: normalized,
        format: validated.isJson ? 'openapi-json' : 'openapi-yaml',
        filename: validated.isJson ? 'index.json' : 'index.yaml',
        completeness: 'full',
        contractClass: 'authoritative',
        evidence: [
          `Fetched runtime-declared specification for ${candidate.name} over guarded HTTPS`,
          `Workload kind: ${candidate.meta.workloadKind ?? 'unknown'}`,
          'Document validated; treated as authoritative runtime bytes',
          'No Authorization/Cookie/Azure/GitHub credentials were forwarded'
        ]
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Runtime-declared specification for ${candidate.name} did not validate as OpenAPI (${detail}); bytes are not authoritative`,
        { cause: error }
      );
    }
  }
}
