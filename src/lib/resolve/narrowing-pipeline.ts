import type { NarrowingTier } from '../../contracts.js';
import type { RepoSignals } from '../repo/signals.js';
import type { AzureResourceGraphClient } from '../azure/clients.js';

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
const GENERIC_TAG_KEYS = ['repo', 'repository', 'service'];

/**
 * T3: tag pre-filter. Prefers candidate tags already enumerated; falls back to a Resource Graph
 * query when a client is available. Only one exact canonical postman:repo=<repoSlug> match may select.
 */
async function tierTagPreFilter(candidates: NarrowingCandidate[], ctx: NarrowingContext): Promise<TierHit | undefined> {
  if (!ctx.repoSlug) return undefined;

  const exactMatches = candidates.filter((candidate) => (candidate.tags?.[CANONICAL_REPO_TAG] ?? '') === ctx.repoSlug);
  const uniqueExact = [...new Set(exactMatches.map((candidate) => candidate.id))];
  if (uniqueExact.length === 1) {
    return {
      ids: uniqueExact,
      selectId: uniqueExact[0],
      evidence: [`Exactly one API tagged ${CANONICAL_REPO_TAG}=${ctx.repoSlug}`]
    };
  }
  if (uniqueExact.length > 1) {
    return {
      ids: uniqueExact,
      evidence: [`Found ${uniqueExact.length} APIs tagged ${CANONICAL_REPO_TAG}=${ctx.repoSlug}`]
    };
  }

  const repoName = ctx.repoSlug.split('/').pop()?.trim();
  const genericMatches = candidates.filter((candidate) => {
    const tags = candidate.tags ?? {};
    return GENERIC_TAG_KEYS.some((key) => {
      const value = tags[key] ?? '';
      return value === ctx.repoSlug || (repoName !== undefined && value === repoName);
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
