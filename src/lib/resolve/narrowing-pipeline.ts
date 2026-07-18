import type { NarrowingTier } from '../../contracts.js';
import type { RepoSignals } from '../repo/signals.js';
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
  /** Extra select-grade tag keys beside postman:repo, matched case-insensitively. */
  repoTagKeys?: string[];
  serviceHints: string[];
  signals: RepoSignals;
  resourceGraphClient?: AzureResourceGraphClient;
}

interface TierHit {
  ids: string[]; // raw tier-produced IDs (may include unknown/duplicates)
  selectId?: string; // set only for exactly one exact canonical postman:repo match
  evidence: string[];
}

export interface NarrowingCandidate {
  id: string;
  name: string;
  resourceGroup?: string;
  tags?: Record<string, string>;
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

/** T1: IaC fingerprinting -- APIM API IDs already found by signal collection. Never selects. */
function tierIacFingerprint(signals: RepoSignals): TierHit | undefined {
  const ids = [...signals.explicitApiIdHints, ...signals.inferredApiIdHints];
  if (ids.length === 0) return undefined;
  return {
    ids,
    evidence: [`IaC fingerprinting found ${ids.length} APIM API ID(s) from repo files`]
  };
}

/** T2: resource-group correlation -- candidates whose resource group matches the repo slug. Never selects. */
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
const FOX_ORG_TAG = 'githuborg';
const FOX_REPO_TAG = 'githubrepo';
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

/**
 * T3: tag pre-filter. Selects on exactly one candidate whose select-grade repo
 * tag matches the repo slug: canonical postman:repo, any caller-supplied
 * repo-tag-keys, or the Fox-style GithubOrg/GithubRepo pair composed as
 * org/repo. Tag keys compare case-insensitively (Azure tag names are
 * case-insensitive) and values ignore case and a trailing .git. When no
 * candidate tag matches and a Resource Graph client is available, a targeted
 * tag lookup runs once as a fallback before generic tags narrow.
 */
async function tierTagPreFilter(candidates: NarrowingCandidate[], ctx: NarrowingContext): Promise<TierHit | undefined> {
  if (!ctx.repoSlug) return undefined;
  const repoSlug = ctx.repoSlug;

  const selectKeys = [CANONICAL_REPO_TAG, ...(ctx.repoTagKeys ?? []).map((key) => key.toLowerCase())];
  const selectMatches = candidates.filter((candidate) => {
    const tags = normalizeTagBag(candidate.tags);
    if (selectKeys.some((key) => slugEquals(tags[key] ?? '', repoSlug))) return true;
    const org = tags[FOX_ORG_TAG] ?? '';
    const repo = tags[FOX_REPO_TAG] ?? '';
    return org.length > 0 && repo.length > 0 && slugEquals(`${org}/${repo}`, repoSlug);
  });
  const uniqueExact = [...new Set(selectMatches.map((candidate) => candidate.id))];
  if (uniqueExact.length === 1) {
    return {
      ids: uniqueExact,
      selectId: uniqueExact[0],
      evidence: [`Exactly one API carries a select-grade repo tag matching ${repoSlug}`]
    };
  }
  if (uniqueExact.length > 1) {
    return {
      ids: uniqueExact,
      evidence: [`Found ${uniqueExact.length} APIs with select-grade repo tags matching ${repoSlug}`]
    };
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
      ids: [...new Set(genericMatches.map((candidate) => candidate.id))],
      evidence: [`Found ${genericMatches.length} API(s) with generic repo/service tags`]
    };
  }
  return undefined;
}

/**
 * Resource Graph fallback for T3: one targeted tag-lookup query maps
 * select-grade repo tags to ARM IDs when enumerated candidates carried no
 * matching tag bag (for example providers that cannot surface tags). Returned
 * IDs intersect case-insensitively with the enumerated candidate set; exactly
 * one intersecting hit is select-grade. Fail-soft: query errors narrow nothing.
 */
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
  if (matched.length === 1) {
    return {
      ids: matched,
      selectId: matched[0],
      evidence: [`Resource Graph tag lookup matched exactly one enumerated candidate for ${ctx.repoSlug}`]
    };
  }
  return {
    ids: matched,
    evidence: [`Resource Graph tag lookup matched ${matched.length} enumerated candidate(s) for ${ctx.repoSlug}`]
  };
}

/** T4: Naming heuristic -- match repo slug against API display names. Rank signal only, never selects. */
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
 * Run the progressive narrowing pipeline.
 * Tier order: iac-fingerprint -> rg-correlation -> tag-prefilter -> naming-heuristic.
 * A tier whose intersection with the enumerated set is empty falls through to the next tier.
 * Unknown IDs are ignored, duplicates de-duplicated, each enumerated candidate appears once.
 * mode 'select' is reserved for exactly one exact canonical postman:repo=<repoSlug> match.
 */
export async function runNarrowingPipeline(
  ctx: NarrowingContext,
  allCandidates: NarrowingCandidate[]
): Promise<NarrowingResult | undefined> {
  const enumeratedSet = new Set(allCandidates.map((c) => c.id));

  const tiers: Array<{ tier: NarrowingTier; run: () => Promise<TierHit | undefined> | TierHit | undefined }> = [
    { tier: 'iac-fingerprint', run: () => tierIacFingerprint(ctx.signals) },
    { tier: 'rg-correlation', run: () => tierResourceGroupCorrelation(allCandidates, ctx) },
    { tier: 'tag-prefilter', run: () => tierTagPreFilter(allCandidates, ctx) },
    { tier: 'naming-heuristic', run: () => tierNamingHeuristic(allCandidates, ctx) }
  ];

  for (const { tier, run } of tiers) {
    const hit = await run();
    if (!hit) continue;
    // Intersect with enumerated set, dedup, preserve tier order then enumeration order for stability.
    const intersecting: string[] = [];
    const seen = new Set<string>();
    for (const id of hit.ids) {
      if (enumeratedSet.has(id) && !seen.has(id)) {
        seen.add(id);
        intersecting.push(id);
      }
    }
    if (intersecting.length === 0) continue; // zero-intersection: fall through to next tier

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
