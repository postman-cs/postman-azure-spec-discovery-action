import type { ContractClass, ProviderType, ProviderProbeStatus, SpecFormat } from '../../contracts.js';

export interface SpecCandidate {
  id: string; // full ARM ID, or stable repo-relative IaC candidate ID
  name: string;
  providerType: ProviderType;
  /** Full APIM API ARM ID or API Center definition ARM ID when applicable. */
  apiId?: string;
  resourceGroup?: string;
  tags: Record<string, string>;
  supported: boolean;
  evidence: string[];
  meta: Record<string, string>;
}

export interface SpecExportResult {
  content: string;
  format: SpecFormat;
  filename: string;
  evidence: string[];
  /**
   * Provider-declared completeness of the exported document. Omitted means
   * 'full' (the provider exported a complete authored spec). Derivation may
   * downgrade completeness but must never upgrade a provider-declared
   * 'partial' to 'full'.
   */
  completeness?: 'full' | 'partial';
  /** Optional fidelity class declared by the exporting provider. */
  contractClass?: ContractClass;
}

/**
 * Lightweight enumeration header. When `headerHydrated` is true the payload
 * already carries list-complete identity/support and hydration is a no-op.
 * When false/omitted, expensive per-resource GETs must wait until hydrate*.
 */
export interface SpecCandidateHeader extends SpecCandidate {
  /** True when this header already includes list-complete detail. */
  headerHydrated?: boolean;
}

export interface SpecProvider {
  readonly type: ProviderType;
  probe(signal?: AbortSignal): Promise<ProviderProbeStatus>;
  /**
   * Full candidate enumeration (headers + hydration). Kept for provider unit
   * tests and legacy callers; resolve-one/discover-many prefer the split seam.
   */
  listCandidates(): Promise<SpecCandidate[]>;
  exportSpec(candidate: SpecCandidate): Promise<SpecExportResult>;
  /**
   * Lightweight identifiers/tags/paths for narrowing. Optional for legacy
   * injected providers; the runtime adapts missing methods.
   */
  listCandidateHeaders?(): Promise<SpecCandidateHeader[]>;
  /**
   * Expensive detail/export-prep for a selected partition. May expand one
   * header into multiple candidates (e.g. template-spec embeds).
   */
  hydrateCandidates?(headers: SpecCandidateHeader[]): Promise<SpecCandidate[]>;
  /** Single-candidate convenience; default adapters fan out to hydrateCandidates. */
  hydrateCandidate?(header: SpecCandidateHeader): Promise<SpecCandidate>;
}

/** Runtime-facing provider that always exposes the split enumeration seam. */
export interface HydratingSpecProvider extends SpecProvider {
  listCandidateHeaders(): Promise<SpecCandidateHeader[]>;
  hydrateCandidates(headers: SpecCandidateHeader[]): Promise<SpecCandidate[]>;
}

function asHeader(candidate: SpecCandidate, headerHydrated: boolean): SpecCandidateHeader {
  return { ...candidate, headerHydrated };
}

/** Drop the optional headerHydrated flag for ranking/export. */
export function toSpecCandidate(header: SpecCandidateHeader): SpecCandidate {
  return {
    id: header.id,
    name: header.name,
    providerType: header.providerType,
    ...(header.apiId ? { apiId: header.apiId } : {}),
    ...(header.resourceGroup ? { resourceGroup: header.resourceGroup } : {}),
    tags: header.tags,
    supported: header.supported,
    evidence: header.evidence,
    meta: header.meta
  };
}

/**
 * Adapt a legacy SpecProvider that only implements listCandidates into the
 * split header/hydrate seam. listCandidates results are treated as already
 * hydrated so resolve-one does not re-fetch detail for injected test doubles.
 */
export function adaptLegacyProvider(provider: SpecProvider): HydratingSpecProvider {
  if (
    typeof provider.listCandidateHeaders === 'function' &&
    typeof provider.hydrateCandidates === 'function'
  ) {
    return provider as HydratingSpecProvider;
  }

  let cached: SpecCandidateHeader[] | undefined;

  const listCandidateHeaders = async (): Promise<SpecCandidateHeader[]> => {
    if (typeof provider.listCandidateHeaders === 'function') {
      return provider.listCandidateHeaders();
    }
    if (!cached) {
      const listed = await provider.listCandidates();
      cached = listed.map((candidate) => asHeader(candidate, true));
    }
    return cached;
  };

  const hydrateCandidates = async (headers: SpecCandidateHeader[]): Promise<SpecCandidate[]> => {
    if (typeof provider.hydrateCandidates === 'function') {
      return provider.hydrateCandidates(headers);
    }
    if (typeof provider.hydrateCandidate === 'function') {
      const out: SpecCandidate[] = [];
      for (const header of headers) {
        out.push(await provider.hydrateCandidate(header));
      }
      return out;
    }
    return headers.map((header) => toSpecCandidate(header));
  };

  return {
    type: provider.type,
    probe: (signal) => provider.probe(signal),
    listCandidates: () => provider.listCandidates(),
    exportSpec: (candidate) => provider.exportSpec(candidate),
    listCandidateHeaders,
    hydrateCandidates,
    hydrateCandidate: async (header) => {
      const [first] = await hydrateCandidates([header]);
      if (!first) {
        throw new Error(`Provider ${provider.type} hydration produced no candidate for ${header.id}`);
      }
      return first;
    }
  };
}

/** Shared helper: listCandidates = headers then hydrate all (stable order). */
export async function listCandidatesViaHydration(provider: {
  listCandidateHeaders(): Promise<SpecCandidateHeader[]>;
  hydrateCandidates(headers: SpecCandidateHeader[]): Promise<SpecCandidate[]>;
}): Promise<SpecCandidate[]> {
  const headers = await provider.listCandidateHeaders();
  const pending = headers.filter((header) => header.headerHydrated !== true);
  const hydrated = pending.length > 0 ? await provider.hydrateCandidates(pending) : [];
  // Preserve header encounter order for already-hydrated rows; append expansions.
  const ordered: SpecCandidate[] = [];
  const seen = new Set<string>();
  for (const header of headers) {
    if (header.headerHydrated === true) {
      const candidate = toSpecCandidate(header);
      if (!seen.has(candidate.id)) {
        seen.add(candidate.id);
        ordered.push(candidate);
      }
    }
  }
  for (const candidate of hydrated) {
    if (!seen.has(candidate.id)) {
      seen.add(candidate.id);
      ordered.push(candidate);
    }
  }
  return ordered;
}
