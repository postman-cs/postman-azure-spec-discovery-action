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

  it('AZ-NARROW-007: select-grade tags match case-insensitively and tolerate trailing .git', async () => {
    const mixedKeyCase = await runNarrowingPipeline(
      { repoSlug: 'Org/Payments', serviceHints: [], signals: signals() },
      [candidate('/x/a', { tags: { 'Postman:Repo': 'org/payments' } }), candidate('/x/b')]
    );
    expect(mixedKeyCase?.tier).toBe('tag-prefilter');
    expect(mixedKeyCase?.mode).toBe('select');
    expect(mixedKeyCase?.apiIds).toEqual(['/x/a']);

    const gitSuffix = await runNarrowingPipeline(
      { repoSlug: 'org/payments', serviceHints: [], signals: signals() },
      [candidate('/x/a', { tags: { 'postman:repo': 'org/payments.git' } }), candidate('/x/b')]
    );
    expect(gitSuffix?.mode).toBe('select');

    const slugSuffix = await runNarrowingPipeline(
      { repoSlug: 'org/payments.git', serviceHints: [], signals: signals() },
      [candidate('/x/a', { tags: { 'postman:repo': 'org/payments' } }), candidate('/x/b')]
    );
    expect(slugSuffix?.mode).toBe('select');
  });

  it('AZ-NARROW-008: GithubOrg/GithubRepo pair composes to a select-grade match', async () => {
    const single = await runNarrowingPipeline(
      { repoSlug: 'org/payments', serviceHints: [], signals: signals() },
      [
        candidate('/x/a', { tags: { GithubOrg: 'Org', GithubRepo: 'Payments' } }),
        candidate('/x/b', { tags: { GithubOrg: 'org', GithubRepo: 'other' } })
      ]
    );
    expect(single?.tier).toBe('tag-prefilter');
    expect(single?.mode).toBe('select');
    expect(single?.apiIds).toEqual(['/x/a']);

    // Two candidates carrying the same pair narrow instead of selecting.
    const double = await runNarrowingPipeline(
      { repoSlug: 'org/payments', serviceHints: [], signals: signals() },
      [
        candidate('/x/a', { tags: { GithubOrg: 'org', GithubRepo: 'payments' } }),
        candidate('/x/b', { tags: { githuborg: 'org', githubrepo: 'payments' } })
      ]
    );
    expect(double?.mode).toBe('narrow');
    expect(double?.apiIds).toEqual(['/x/a', '/x/b']);

    // Org-only or repo-only never matches.
    const partial = await runNarrowingPipeline(
      { repoSlug: 'org/payments', serviceHints: [], signals: signals() },
      [candidate('/x/a', { tags: { GithubOrg: 'org' } }), candidate('/x/b', { tags: { GithubRepo: 'payments' } })]
    );
    expect(partial?.tier).not.toBe('tag-prefilter');
  });

  it('AZ-NARROW-009: caller-supplied repo-tag-keys are select-grade', async () => {
    const custom = await runNarrowingPipeline(
      { repoSlug: 'org/payments', repoTagKeys: ['team:source-repo'], serviceHints: [], signals: signals() },
      [candidate('/x/a', { tags: { 'Team:Source-Repo': 'org/payments' } }), candidate('/x/b')]
    );
    expect(custom?.tier).toBe('tag-prefilter');
    expect(custom?.mode).toBe('select');
    expect(custom?.apiIds).toEqual(['/x/a']);

    // Without the key registered, the same tag is not select-grade.
    const unregistered = await runNarrowingPipeline(
      { repoSlug: 'org/payments', serviceHints: [], signals: signals() },
      [candidate('/x/a', { tags: { 'Team:Source-Repo': 'org/payments' } }), candidate('/x/b')]
    );
    expect(unregistered?.mode).not.toBe('select');
  });

  it('AZ-NARROW-010: Resource Graph fallback maps tag hits to enumerated candidates and stays fail-soft', async () => {
    const graphClient = {
      queryResources: async () => [
        { id: '/X/A', name: 'a', type: 't', resourceGroup: 'rg', tags: { 'postman:repo': 'org/payments' } }
      ]
    };
    const selectViaGraph = await runNarrowingPipeline(
      {
        repoSlug: 'org/payments',
        subscriptionId: 'sub-1',
        serviceHints: [],
        signals: signals(),
        resourceGraphClient: graphClient
      },
      [candidate('/x/a'), candidate('/x/b')]
    );
    expect(selectViaGraph?.tier).toBe('tag-prefilter');
    expect(selectViaGraph?.mode).toBe('select');
    expect(selectViaGraph?.apiIds).toEqual(['/x/a']);

    // Query failure narrows nothing and falls through to later tiers.
    const failing = {
      queryResources: async () => {
        throw new Error('graph unavailable');
      }
    };
    const failSoft = await runNarrowingPipeline(
      {
        repoSlug: 'org/payments',
        subscriptionId: 'sub-1',
        serviceHints: [],
        signals: signals(),
        resourceGraphClient: failing
      },
      [candidate('/x/payments-api', { name: 'payments-api' }), candidate('/x/orders', { name: 'orders' })]
    );
    expect(failSoft?.tier).toBe('naming-heuristic');

    // No subscription id: fallback is skipped entirely (no query issued).
    let queried = 0;
    const counting = {
      queryResources: async () => {
        queried += 1;
        return [];
      }
    };
    await runNarrowingPipeline(
      { repoSlug: 'org/payments', serviceHints: [], signals: signals(), resourceGraphClient: counting },
      [candidate('/x/a')]
    );
    expect(queried).toBe(0);
  });
});
