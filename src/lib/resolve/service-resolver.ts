import type { AmbiguousCandidateView, ProviderType } from '../../contracts.js';
import type { RepoSignals } from '../repo/signals.js';

export interface AzureCandidateInput {
  id: string; // full ARM resource ID (or repo-relative IaC candidate ID)
  name: string;
  providerType: ProviderType;
  apiId?: string; // full APIM API ARM ID only
  tags: Record<string, string>;
  supported: boolean;
  evidence?: string[];
}

export interface RankedServiceCandidate {
  serviceName: string;
  resourceId: string;
  apiId?: string;
  providerType: ProviderType;
  confidence: number;
  supported: boolean;
  ambiguous?: boolean;
  evidence: string[];
}

function includesIgnoreCase(value: string, candidates: string[]): boolean {
  const v = value.toLowerCase();
  return candidates.some((candidate) => candidate.toLowerCase() === v);
}

function shortApiId(value: string): string {
  return value.split('/').pop() ?? value;
}

function scoreCandidate(candidate: AzureCandidateInput, signals: RepoSignals): { score: number; evidence: string[] } {
  let score = 0;
  const evidence: string[] = [];

  const candidateApiIds = [candidate.apiId ?? '', shortApiId(candidate.apiId ?? ''), candidate.id, shortApiId(candidate.id)].filter(Boolean);
  if (candidateApiIds.some((id) => includesIgnoreCase(id, signals.explicitApiIdHints))) {
    score += 100;
    evidence.push(`Matched explicit API ID ${shortApiId(candidate.apiId ?? candidate.id)}`);
  } else if (candidateApiIds.some((id) => includesIgnoreCase(id, signals.inferredApiIdHints))) {
    score += 25;
    evidence.push(`Matched inferred API ID ${shortApiId(candidate.apiId ?? candidate.id)}`);
  }

  const serviceHints = signals.serviceHints.map((hint) => hint.toLowerCase());
  if (serviceHints.some((hint) => hint && candidate.name.toLowerCase().includes(hint))) {
    score += 30;
    evidence.push(`Display name "${candidate.name}" matches service hint`);
  }

  const tagValues = Object.values(candidate.tags).map((value) => value.toLowerCase());
  if (serviceHints.some((hint) => hint && tagValues.some((tag) => tag === hint))) {
    // Exact tag equality is a stronger signal than substring containment and
    // must outrank it so "payments-live" cannot tie with "payments-live-site".
    score += 60;
    evidence.push('Resource tag exactly matches service hint');
  } else if (serviceHints.some((hint) => hint && tagValues.some((tag) => tag.includes(hint)))) {
    score += 40;
    evidence.push('Resource tags match service hint');
  }

  return { score, evidence };
}

function toRanked(candidate: AzureCandidateInput, signals: RepoSignals, score: number, evidence: string[]): RankedServiceCandidate {
  const mergedEvidence = [...signals.evidence, ...(candidate.evidence ?? []), ...evidence];
  const serviceName =
    (candidate.tags['postman:project-name'] ?? '').trim() ||
    (candidate.tags.Name ?? '').trim() ||
    candidate.name;
  return {
    serviceName,
    resourceId: candidate.id,
    apiId: candidate.apiId,
    providerType: candidate.providerType,
    confidence: score,
    supported: candidate.supported,
    evidence: mergedEvidence.length > 0 ? mergedEvidence : ['No strong resolver evidence found']
  };
}

/**
 * Deterministic ranking of every Azure candidate.
 * Sort: confidence descending, then full resource ID ascending. This is the single source
 * of truth for candidate ordering; resolveServiceCandidate() consumes it so the ranked view
 * surfaced for ambiguity can never diverge from resolution.
 */
export function rankServiceCandidates(
  candidates: AzureCandidateInput[],
  signals: RepoSignals
): RankedServiceCandidate[] {
  const ranked = candidates.map((candidate) => {
    const scored = scoreCandidate(candidate, signals);
    return toRanked(candidate, signals, scored.score, scored.evidence);
  });
  ranked.sort(
    (left, right) =>
      right.confidence - left.confidence ||
      (left.resourceId < right.resourceId ? -1 : left.resourceId > right.resourceId ? 1 : 0)
  );
  return ranked;
}

export function resolveServiceCandidate(
  candidates: AzureCandidateInput[],
  signals: RepoSignals
): RankedServiceCandidate | undefined {
  const ranked = rankServiceCandidates(candidates, signals);
  if (ranked.length === 0) return undefined;
  const best = ranked[0];
  // Equal top confidence across more than one candidate is ambiguous.
  const tied = ranked.filter((candidate) => candidate.confidence === best.confidence);
  if (tied.length > 1 && best.confidence > 0) {
    best.ambiguous = true;
    best.evidence = [
      ...best.evidence,
      `Ambiguous match: ${tied.map((candidate) => shortApiId(candidate.resourceId)).join(' and ')} have equal confidence ${best.confidence}`
    ];
  }
  return best;
}

/** Serialize ranked candidates into the public AmbiguousCandidateView shape. */
export function toAmbiguousViews(ranked: RankedServiceCandidate[]): AmbiguousCandidateView[] {
  return ranked.map((candidate, index) => ({
    rank: index + 1,
    serviceName: candidate.serviceName,
    resourceId: candidate.resourceId,
    ...(candidate.apiId ? { apiId: candidate.apiId } : {}),
    providerType: candidate.providerType,
    confidence: candidate.confidence,
    supported: candidate.supported,
    evidence: candidate.evidence
  }));
}
