import { describe, expect, it } from 'vitest';

import { runNarrowingPipeline, type NarrowingCandidate } from '../src/lib/resolve/narrowing-pipeline.js';
import { partitionCandidates } from '../src/runtime.js';
import type { RepoSignals } from '../src/lib/repo/signals.js';
import type { SpecCandidate } from '../src/lib/providers/types.js';

function signals(overrides: Partial<RepoSignals> = {}): RepoSignals {
  return {
    serviceHints: [],
    explicitApiIdHints: [],
    inferredApiIdHints: [],
    evidence: [],
    ...overrides
  };
}

function candidate(id: string, overrides: Partial<NarrowingCandidate> = {}): NarrowingCandidate {
  return { id, name: id.split('/').pop() ?? id, ...overrides };
}

function specCandidate(id: string, overrides: Partial<SpecCandidate> = {}): SpecCandidate {
  return {
    id,
    name: id.split('/').pop() ?? id,
    providerType: 'apim',
    tags: {},
    supported: true,
    evidence: [],
    meta: {},
    ...overrides
  };
}

describe('narrowing pipeline', () => {
  it('AZ-NARROW-001: first non-empty tier wins in locked order', async () => {
    // iac-fingerprint via inferred API id hint
    const iacResult = await runNarrowingPipeline(
      { repoSlug: 'org/payments', serviceHints: [], signals: signals({ inferredApiIdHints: ['/x/apis/pay'] }) },
      [candidate('/x/apis/pay'), candidate('/x/apis/other')]
    );
    expect(iacResult?.tier).toBe('iac-fingerprint');

    // rg-correlation when no IaC ids
    const rgResult = await runNarrowingPipeline(
      { repoSlug: 'org/payments-service', serviceHints: [], signals: signals() },
      [candidate('/x/a', { resourceGroup: 'payments-rg' }), candidate('/x/b', { resourceGroup: 'unrelated' })]
    );
    expect(rgResult?.tier).toBe('rg-correlation');

    // tag-prefilter when no rg match
    const tagResult = await runNarrowingPipeline(
      { repoSlug: 'org/payments', serviceHints: [], signals: signals() },
      [candidate('/x/a', { tags: { 'postman:repo': 'org/payments' } }), candidate('/x/b')]
    );
    expect(tagResult?.tier).toBe('tag-prefilter');

    // naming-heuristic fallback
    const nameResult = await runNarrowingPipeline(
      { repoSlug: 'org/payments', serviceHints: [], signals: signals() },
      [candidate('/x/payments-api', { name: 'payments-api' }), candidate('/x/orders', { name: 'orders' })]
    );
    expect(nameResult?.tier).toBe('naming-heuristic');
  });

  it('AZ-NARROW-002: partition keeps every candidate exactly once with the hit first', async () => {
    const enumerated = [specCandidate('/x/alpha'), specCandidate('/x/bravo'), specCandidate('/x/charlie'), specCandidate('/x/delta')];
    const narrowing = await runNarrowingPipeline(
      { repoSlug: 'org/charlie', serviceHints: [], signals: signals() },
      enumerated.map((c) => candidate(c.id, { name: c.name }))
    );
    expect(narrowing?.apiIds).toEqual(['/x/charlie']);
    expect(narrowing?.droppedCount).toBe(3);
    expect(narrowing?.evidence.join(' ')).toContain('demoted 3 (not deleted)');

    const partitioned = partitionCandidates(enumerated, narrowing);
    expect(partitioned.map((c) => c.id)).toEqual(['/x/charlie', '/x/alpha', '/x/bravo', '/x/delta']);
    expect(new Set(partitioned.map((c) => c.id)).size).toBe(4);
  });

  it('AZ-NARROW-003: stale/unknown/duplicate IaC ids fall through; duplicates collapse', async () => {
    const result = await runNarrowingPipeline(
      { repoSlug: undefined, serviceHints: [], signals: signals({ inferredApiIdHints: ['/x/gone', '/x/gone'] }) },
      [candidate('/x/real')]
    );
    // Tier 1 hit intersects to zero -> falls through; nothing else matches -> undefined
    expect(result).toBeUndefined();

    const dup = await runNarrowingPipeline(
      { repoSlug: undefined, serviceHints: [], signals: signals({ inferredApiIdHints: ['/x/real', '/x/real'] }) },
      [candidate('/x/real')]
    );
    expect(dup?.apiIds).toEqual(['/x/real']);
  });

  it('AZ-NARROW-004: only exactly one exact canonical postman:repo match selects', async () => {
    const single = await runNarrowingPipeline(
      { repoSlug: 'org/payments', serviceHints: [], signals: signals() },
      [candidate('/x/a', { tags: { 'postman:repo': 'org/payments' } }), candidate('/x/b')]
    );
    expect(single?.mode).toBe('select');

    const double = await runNarrowingPipeline(
      { repoSlug: 'org/payments', serviceHints: [], signals: signals() },
      [
        candidate('/x/a', { tags: { 'postman:repo': 'org/payments' } }),
        candidate('/x/b', { tags: { 'postman:repo': 'org/payments' } })
      ]
    );
    expect(double?.mode).toBe('narrow');

    for (const key of ['repo', 'repository', 'service']) {
      const generic = await runNarrowingPipeline(
        { repoSlug: 'org/payments', serviceHints: [], signals: signals() },
        [candidate('/x/a', { tags: { [key]: 'org/payments' } }), candidate('/x/b')]
      );
      expect(generic?.mode).toBe('narrow');
    }
  });

  it('AZ-NARROW-006: cap applies after partitioning and the match survives the cap', async () => {
    const enumerated: SpecCandidate[] = [];
    for (let i = 0; i < 75; i += 1) {
      enumerated.push(specCandidate(`/x/api-${String(i).padStart(2, '0')}`));
    }
    enumerated[69] = specCandidate('/x/target', { tags: { 'postman:repo': 'org/target' } });

    const narrowing = await runNarrowingPipeline(
      { repoSlug: 'org/target', serviceHints: [], signals: signals() },
      enumerated.map((c) => candidate(c.id, { name: c.name, tags: c.tags }))
    );
    const partitioned = partitionCandidates(enumerated, narrowing);
    expect(partitioned).toHaveLength(75);
    expect(partitioned[0]?.id).toBe('/x/target');

    const capped = partitioned.slice(0, 50);
    expect(capped).toHaveLength(50);
    expect(capped[0]?.id).toBe('/x/target');
    expect(partitioned.length - capped.length).toBe(25);
  });
});
