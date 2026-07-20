import type { NarrowingTier } from '../../contracts.js';
import type { RepoSignals } from '../repo/signals.js';
import { normalizeApiBasePath, normalizeHostname } from '../repo/signals.js';
import type { AzureResourceGraphClient } from '../azure/clients.js';
import { buildRepoTagLookupQuery } from './resource-graph-query.js';

export type NarrowingMode = 'select' | 'narrow';

export interface NarrowingResult {
  apiIds: string[]; // intersecting enumerated IDs only, in tier order
  tier: NarrowingTier;
  mode: NarrowingMode;
  droppedCount: number; // count demoted behind the intersection, never physically deleted
  evidence: string[];
}

export interface NarrowingContext {
  repoSlug?: string;
  subscriptionId?: string;
  resourceGroup?: string;
  /** Extra select-grade repo tag keys beside postman:repo, matched case-insensitively. */
  repoTagKeys?: string[];
  /** Optional environment selector (matches environment/env/postman:environment tags). */
  environment?: string;
  /** Optional self-hosted gateway id; "managed" is rejected by callers and ignored here. */
  gatewayId?: string;
  apiVersion?: string;
  apiRevision?: string;
  serviceHints: string[];
  signals: RepoSignals;
  resourceGraphClient?: AzureResourceGraphClient;
}

interface TierHit {
  ids: string[]; // raw tier-produced IDs (may include unknown/duplicates)
  selectId?: string; // set only when exactly one select-grade match survives
  evidence: string[];
}

export interface NarrowingCandidate {
  id: string;
  name: string;
  resourceGroup?: string;
  tags?: Record<string, string>;
  /** api = ownership on the API; service-inherited = copied service tags (never select-grade alone). */
  tagSource?: 'api' | 'service-inherited';
  apiPath?: string;
  apiVersion?: string;
  apiRevision?: string;
  hostnames?: string[];
  assignedGatewayIds?: string[];
  serviceName?: string;
  workspaceId?: string;
}

function slugifyRepoName(repoSlug?: string): string[] {
  if (!repoSlug) return [];
  const repoName = repoSlug.split('/').pop()?.trim() ?? '';
  if (!repoName) return [];

  const slugs = [repoName];
  for (const suffix of ['-service', '-api', '-backend', '-server', '-app']) {
    if (repoName.endsWith(suffix)) {
      slugs.push(repoName.slice(0, -suffix.length));
    }
  }
  return slugs.filter((s) => s.length > 2);
}

function sortedIds(ids: string[]): string[] {
  return [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function candidateEnvironment(candidate: NarrowingCandidate): string | undefined {
  const tags = normalizeTagBag(candidate.tags);
  const value = tags.environment || tags.env || tags['postman:environment'];
  return value || undefined;
}

function applySelectors(candidates: NarrowingCandidate[], ctx: NarrowingContext): NarrowingCandidate[] {
  return candidates.filter((candidate) => {
    if (ctx.environment) {
      const env = candidateEnvironment(candidate);
      if (!env || env.toLowerCase() !== ctx.environment.toLowerCase()) return false;
    }
    if (ctx.apiVersion) {
      if ((candidate.apiVersion ?? '').toLowerCase() !== ctx.apiVersion.toLowerCase()) return false;
    }
    if (ctx.apiRevision) {
      if (String(candidate.apiRevision ?? '') !== String(ctx.apiRevision)) return false;
    }
    return true;
  });
}

function ambiguityReason(candidates: NarrowingCandidate[], ctx: NarrowingContext): string {
  const envs = new Set(candidates.map(candidateEnvironment).filter((v): v is string => Boolean(v)));
  if (envs.size > 1 && !ctx.environment) {
    return `Ambiguous environments (${sortedIds([...envs]).join(', ')}); supply environment selector`;
  }
  const versions = new Set(candidates.map((c) => c.apiVersion).filter((v): v is string => Boolean(v)));
  if (versions.size > 1 && !ctx.apiVersion) {
    return `Ambiguous API versions (${sortedIds([...versions]).join(', ')}); supply api-version selector`;
  }
  const revisions = new Set(candidates.map((c) => c.apiRevision).filter((v): v is string => Boolean(v)));
  if (revisions.size > 1 && !ctx.apiRevision) {
    return `Ambiguous API revisions (${sortedIds([...revisions]).join(', ')}); supply api-revision selector`;
  }
  const paths = new Set(candidates.map((c) => normalizeApiBasePath(c.apiPath)).filter((v) => v.length > 0));
  if (paths.size > 1) {
    return `Ambiguous API paths (${sortedIds([...paths]).join(', ')})`;
  }
  return `Ambiguous match across ${candidates.length} candidate(s)`;
}

/**
 * Exact gateway hostname + API base path. Selects only when one candidate remains
 * after optional environment/version/revision selectors. Host-only evidence against
 * a multi-API hostname never selects.
 */
function tierGatewayHostPath(candidates: NarrowingCandidate[], ctx: NarrowingContext): TierHit | undefined {
  const urls = ctx.signals.gatewayUrls ?? [];
  if (urls.length === 0) return undefined;

  const matches: NarrowingCandidate[] = [];
  const seen = new Set<string>();
  for (const url of urls) {
    const host = normalizeHostname(url.hostname);
    const basePath = normalizeApiBasePath(url.basePath);
    if (!host) continue;
    for (const candidate of candidates) {
      const hosts = (candidate.hostnames ?? []).map(normalizeHostname).filter(Boolean);
      if (!hosts.includes(host)) continue;
      if (!basePath) {
        // Host-only: collect for narrowing only when later logic decides; never select here.
        continue;
      }
      if (normalizeApiBasePath(candidate.apiPath) !== basePath) continue;
      if (!seen.has(candidate.id)) {
        seen.add(candidate.id);
        matches.push(candidate);
      }
    }
  }

  // Host-only evidence: if any azure-api-net/custom host matches multiple APIs, narrow those APIs.
  if (matches.length === 0) {
    const hostOnly: NarrowingCandidate[] = [];
    const hostSeen = new Set<string>();
    for (const url of urls) {
      if (normalizeApiBasePath(url.basePath)) continue;
      const host = normalizeHostname(url.hostname);
      for (const candidate of candidates) {
        const hosts = (candidate.hostnames ?? []).map(normalizeHostname).filter(Boolean);
        if (!hosts.includes(host)) continue;
        if (!hostSeen.has(candidate.id)) {
          hostSeen.add(candidate.id);
          hostOnly.push(candidate);
        }
      }
    }
    if (hostOnly.length === 0) return undefined;
    const filtered = applySelectors(hostOnly, ctx);
    if (filtered.length === 0) return undefined;
    return {
      ids: sortedIds(filtered.map((c) => c.id)),
      evidence: [
        `Gateway hostname matched ${filtered.length} API(s) without a base path; refusing to select`,
        ambiguityReason(filtered, ctx)
      ]
    };
  }

  const filtered = applySelectors(matches, ctx);
  if (filtered.length === 0) return undefined;
  if (filtered.length === 1) {
    return {
      ids: [filtered[0]!.id],
      selectId: filtered[0]!.id,
      evidence: [`Exact gateway host and API base path selected one API`]
    };
  }
  return {
    ids: sortedIds(filtered.map((c) => c.id)),
    evidence: [
      `Gateway host and API path matched ${filtered.length} API(s)`,
      ambiguityReason(filtered, ctx)
    ]
  };
}

/** Self-hosted / workspace gateway assignment. Narrows only; never selects. */
function tierGatewayAssignment(candidates: NarrowingCandidate[], ctx: NarrowingContext): TierHit | undefined {
  const gatewayId = (ctx.gatewayId ?? '').trim();
  if (!gatewayId || gatewayId.toLowerCase() === 'managed') return undefined;
  const matches = candidates.filter((candidate) =>
    (candidate.assignedGatewayIds ?? []).some((id) => id.toLowerCase() === gatewayId.toLowerCase())
  );
  if (matches.length === 0) return undefined;
  const filtered = applySelectors(matches, ctx);
  if (filtered.length === 0) return undefined;
  return {
    ids: sortedIds(filtered.map((c) => c.id)),
    evidence: [
      `Gateway assignment for ${gatewayId} narrowed to ${filtered.length} API(s)`,
      ...(filtered.length > 1 ? [ambiguityReason(filtered, ctx)] : [])
    ]
  };
}

/** T-weak: IaC fingerprinting -- APIM API IDs already found by signal collection. Never selects. */
function tierIacFingerprint(signals: RepoSignals): TierHit | undefined {
  const ids = [...signals.explicitApiIdHints, ...signals.inferredApiIdHints];
  if (ids.length === 0) return undefined;
  return {
    ids,
    evidence: [`IaC fingerprinting found ${ids.length} APIM API ID(s) from repo files`]
  };
}

/** Resource-group correlation -- never selects. */
function tierResourceGroupCorrelation(candidates: NarrowingCandidate[], ctx: NarrowingContext): TierHit | undefined {
  const slugs = slugifyRepoName(ctx.repoSlug);
  if (slugs.length === 0) return undefined;
  const matches = candidates.filter((candidate) => {
    const group = (candidate.resourceGroup ?? '').toLowerCase();
    return group.length > 0 && slugs.some((slug) => group.includes(slug.toLowerCase()));
  });
  if (matches.length === 0) return undefined;
  return {
    ids: matches.map((m) => m.id),
    evidence: [`Resource group correlation matched ${matches.length} candidate(s) to repo slug`]
  };
}

const CANONICAL_REPO_TAG = 'postman:repo';
const GITHUB_ORG_TAG = 'githuborg';
const GITHUB_REPO_TAG = 'githubrepo';
const GENERIC_TAG_KEYS = ['repo', 'repository', 'service', 'github:repository'];

/** Lowercase every tag key and trim values so lookups ignore tag-name casing (Azure tag names are case-insensitive). */
function normalizeTagBag(tags: Record<string, string> | undefined): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags ?? {})) {
    normalized[key.toLowerCase()] = (value ?? '').trim();
  }
  return normalized;
}

/** Case-insensitive comparison that tolerates a trailing .git on either side. */
function slugEquals(a: string, b: string): boolean {
  const strip = (value: string) => value.trim().replace(/\.git$/i, '').toLowerCase();
  const left = strip(a);
  return left.length > 0 && left === strip(b);
}

function hasSelectGradeRepoTag(candidate: NarrowingCandidate, repoSlug: string, repoTagKeys: string[]): boolean {
  const tags = normalizeTagBag(candidate.tags);
  const selectKeys = [CANONICAL_REPO_TAG, ...repoTagKeys.map((key) => key.toLowerCase())];
  if (selectKeys.some((key) => slugEquals(tags[key] ?? '', repoSlug))) return true;
  const org = tags[GITHUB_ORG_TAG] ?? '';
  const repo = tags[GITHUB_REPO_TAG] ?? '';
  return org.length > 0 && repo.length > 0 && slugEquals(`${org}/${repo}`, repoSlug);
}

/**
 * Tag pre-filter. Selects only when exactly one candidate carries an API-level
 * (not service-inherited) select-grade repo tag. Service-level tags inherited by
 * multiple APIs narrow but never select. Environment selector can disambiguate.
 */
async function tierTagPreFilter(candidates: NarrowingCandidate[], ctx: NarrowingContext): Promise<TierHit | undefined> {
  if (!ctx.repoSlug) return undefined;
  const repoSlug = ctx.repoSlug;
  const repoTagKeys = ctx.repoTagKeys ?? [];

  const selectMatches = candidates.filter((candidate) => hasSelectGradeRepoTag(candidate, repoSlug, repoTagKeys));
  const filtered = applySelectors(selectMatches, ctx);
  const uniqueExact = [...new Set(filtered.map((candidate) => candidate.id))];

  if (uniqueExact.length === 1) {
    const only = filtered.find((candidate) => candidate.id === uniqueExact[0]);
    // Service-inherited tags never select, even when only one API remains in the filter set
    // after selectors — unless the candidate set for that tag is a true API-level ownership.
    const canSelect = only?.tagSource !== 'service-inherited';
    if (canSelect) {
      return {
        ids: uniqueExact,
        selectId: uniqueExact[0],
        evidence: [`Exactly one API carries a select-grade repo tag matching ${repoSlug}`]
      };
    }
    return {
      ids: uniqueExact,
      evidence: [
        `Service-inherited repo tag matched ${repoSlug} but is not select-grade for multi-API ownership`
      ]
    };
  }
  if (uniqueExact.length > 1) {
    return {
      ids: sortedIds(uniqueExact),
      evidence: [
        `Found ${uniqueExact.length} APIs with select-grade repo tags matching ${repoSlug}`,
        ambiguityReason(filtered, ctx)
      ]
    };
  }

  // No post-selector matches: if selectors eliminated inherited/select matches, fall through.
  if (selectMatches.length > 0 && filtered.length === 0) {
    return undefined;
  }

  const graphHit = await tierTagGraphFallback(candidates, ctx);
  if (graphHit) return graphHit;

  const repoName = repoSlug.split('/').pop()?.trim();
  const genericMatches = candidates.filter((candidate) => {
    const tags = normalizeTagBag(candidate.tags);
    return GENERIC_TAG_KEYS.some((key) => {
      const value = tags[key] ?? '';
      return slugEquals(value, repoSlug) || (repoName !== undefined && slugEquals(value, repoName));
    });
  });
  if (genericMatches.length > 0) {
    return {
      ids: sortedIds([...new Set(genericMatches.map((candidate) => candidate.id))]),
      evidence: [`Found ${genericMatches.length} API(s) with generic repo/service tags`]
    };
  }
  return undefined;
}

async function tierTagGraphFallback(
  candidates: NarrowingCandidate[],
  ctx: NarrowingContext
): Promise<TierHit | undefined> {
  if (!ctx.resourceGraphClient || !ctx.subscriptionId || !ctx.repoSlug) return undefined;
  let rows;
  try {
    rows = await ctx.resourceGraphClient.queryResources(
      ctx.subscriptionId,
      buildRepoTagLookupQuery(ctx.repoSlug, ctx.repoTagKeys ?? [], ctx.resourceGroup)
    );
  } catch {
    return undefined;
  }
  if (rows.length === 0) return undefined;

  const byLowerId = new Map(candidates.map((candidate) => [candidate.id.toLowerCase(), candidate.id]));
  const matched: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const canonical = byLowerId.get(row.id.toLowerCase());
    if (canonical !== undefined && !seen.has(canonical)) {
      seen.add(canonical);
      matched.push(canonical);
    }
  }
  if (matched.length === 0) return undefined;
  const matchedCandidates = candidates.filter((candidate) => matched.includes(candidate.id));
  const filtered = applySelectors(matchedCandidates, ctx);
  const ids = sortedIds(filtered.map((c) => c.id));
  if (ids.length === 0) return undefined;
  // Graph rows are resource-level; treat as select only when a single non-inherited candidate remains.
  if (ids.length === 1) {
    const only = filtered[0];
    if (only?.tagSource !== 'service-inherited') {
      return {
        ids,
        selectId: ids[0],
        evidence: [`Resource Graph tag lookup matched exactly one enumerated candidate for ${ctx.repoSlug}`]
      };
    }
  }
  return {
    ids,
    evidence: [
      `Resource Graph tag lookup matched ${ids.length} enumerated candidate(s) for ${ctx.repoSlug}`,
      ...(ids.length > 1 ? [ambiguityReason(filtered, ctx)] : [])
    ]
  };
}

/** Naming heuristic -- rank signal only, never selects. */
function tierNamingHeuristic(candidates: NarrowingCandidate[], ctx: NarrowingContext): TierHit | undefined {
  const slugs = slugifyRepoName(ctx.repoSlug);
  if (slugs.length === 0) return undefined;
  const matches = candidates.filter((candidate) => {
    const nameLower = candidate.name.toLowerCase();
    return slugs.some((slug) => nameLower.includes(slug.toLowerCase()));
  });
  if (matches.length === 0) return undefined;
  return {
    ids: matches.map((m) => m.id),
    evidence: [`Name matching narrowed ${candidates.length} candidates to ${matches.length} using repo slug`]
  };
}

/**
 * Progressive narrowing.
 * Precedence: gateway-host-path -> tag-prefilter -> gateway-assignment ->
 * iac-fingerprint -> rg-correlation -> naming-heuristic.
 */
export async function runNarrowingPipeline(
  ctx: NarrowingContext,
  allCandidates: NarrowingCandidate[]
): Promise<NarrowingResult | undefined> {
  const enumeratedSet = new Set(allCandidates.map((c) => c.id));

  const tiers: Array<{ tier: NarrowingTier; run: () => Promise<TierHit | undefined> | TierHit | undefined }> = [
    { tier: 'gateway-host-path', run: () => tierGatewayHostPath(allCandidates, ctx) },
    { tier: 'tag-prefilter', run: () => tierTagPreFilter(allCandidates, ctx) },
    { tier: 'gateway-assignment', run: () => tierGatewayAssignment(allCandidates, ctx) },
    { tier: 'iac-fingerprint', run: () => tierIacFingerprint(ctx.signals) },
    { tier: 'rg-correlation', run: () => tierResourceGroupCorrelation(allCandidates, ctx) },
    { tier: 'naming-heuristic', run: () => tierNamingHeuristic(allCandidates, ctx) }
  ];

  for (const { tier, run } of tiers) {
    const hit = await run();
    if (!hit) continue;
    const intersecting: string[] = [];
    const seen = new Set<string>();
    for (const id of hit.ids) {
      if (enumeratedSet.has(id) && !seen.has(id)) {
        seen.add(id);
        intersecting.push(id);
      }
    }
    if (intersecting.length === 0) continue;

    const demoted = allCandidates.length - intersecting.length;
    const isSelect = hit.selectId !== undefined && intersecting.length === 1 && intersecting[0] === hit.selectId;
    return {
      apiIds: intersecting,
      tier,
      mode: isSelect ? 'select' : 'narrow',
      droppedCount: demoted,
      evidence: [
        ...hit.evidence,
        `Narrowing (${tier}) ranked ${intersecting.length} candidate(s) first and demoted ${demoted} (not deleted)`
      ]
    };
  }
  return undefined;
}
