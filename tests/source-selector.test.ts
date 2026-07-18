import { describe, expect, it } from 'vitest';

import { chooseSource } from '../src/lib/resolve/source-selector.js';
import { rankServiceCandidates, resolveServiceCandidate, toAmbiguousViews } from '../src/lib/resolve/service-resolver.js';
import type { AzureCandidateInput } from '../src/lib/resolve/service-resolver.js';
import type { RepoSignals } from '../src/lib/repo/signals.js';

function signals(overrides: Partial<RepoSignals> = {}): RepoSignals {
  return { serviceHints: [], explicitApiIdHints: [], inferredApiIdHints: [], evidence: [], ...overrides };
}

function input(id: string, overrides: Partial<AzureCandidateInput> = {}): AzureCandidateInput {
  return { id, name: id.split('/').pop() ?? id, providerType: 'apim', tags: {}, supported: true, ...overrides };
}

describe('source selector', () => {
  it('repo spec always wins', () => {
    const result = chooseSource({
      existingSpecPath: 'openapi.yaml',
      existingSpecFormat: 'openapi-yaml',
      fallbackServiceName: 'payments'
    });
    expect(result.status).toBe('resolved');
    expect(result.sourceType).toBe('repo-spec');
    expect(result.confidence).toBe(70);
  });

  it('supported unambiguous candidate above minimum confidence resolves with provider source type', () => {
    const ranked = resolveServiceCandidate(
      [input('/x/apis/payments', { apiId: '/x/apis/payments', tags: { 'postman:project-name': 'payments' } })],
      signals({ serviceHints: ['payments'] })
    );
    expect(ranked).toBeDefined();
    const result = chooseSource({ candidate: ranked });
    expect(result.status).toBe('resolved');
    expect(result.sourceType).toBe('apim-export');
    expect(result.apiId).toBe('/x/apis/payments');
  });

  it('AZ-NARROW-005: equal-confidence tie is ambiguous -> manual review, both candidates in stable order, no selection', () => {
    const candidates = [
      input('/x/apis/a', { name: 'payments-a' }),
      input('/x/apis/b', { name: 'payments-b' })
    ];
    const sig = signals({ serviceHints: ['payments'] });
    const best = resolveServiceCandidate(candidates, sig);
    expect(best?.ambiguous).toBe(true);

    const result = chooseSource({ candidate: best, fallbackServiceName: 'unknown-service' });
    expect(result.status).toBe('unresolved');
    expect(result.sourceType).toBe('manual-review');

    const views = toAmbiguousViews(rankServiceCandidates(candidates, sig));
    expect(views.map((v) => v.resourceId)).toEqual(['/x/apis/a', '/x/apis/b']);
    expect(views[0]?.rank).toBe(1);
  });

  it('unsupported candidate cannot resolve even above minimum confidence', () => {
    const ranked = resolveServiceCandidate(
      [input('/x/apis/soap', { supported: false, tags: { 'postman:project-name': 'soap-api' }, name: 'payments' })],
      signals({ serviceHints: ['payments'] })
    );
    const result = chooseSource({ candidate: ranked });
    expect(result.status).toBe('unresolved');
    expect(result.sourceType).toBe('manual-review');
  });

  it('below minimum confidence goes to manual review', () => {
    const ranked = resolveServiceCandidate([input('/x/apis/a', { name: 'unrelated' })], signals());
    const result = chooseSource({ candidate: ranked });
    expect(result.status).toBe('unresolved');
  });
});

describe('exact tag equality precedence (AZ-RESOLVE-EXACT)', () => {
  it('exact tag match outranks substring containment so near-name siblings cannot tie', () => {
    const hints = signals({ serviceHints: ['payments-live'] });
    const apimCandidate = input(
      '/subscriptions/s/resourceGroups/rg/providers/Microsoft.ApiManagement/service/svc/apis/payments-live',
      { name: 'Payments Live API', tags: { 'postman:project-name': 'payments-live' } }
    );
    const siteCandidate = input(
      '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Web/sites/pmspecsite',
      { name: 'pmspecsite', providerType: 'app-service', tags: { 'postman:project-name': 'payments-live-site' } }
    );
    const ranked = rankServiceCandidates([apimCandidate, siteCandidate], hints);
    expect(ranked[0]?.resourceId).toBe(apimCandidate.id);
    expect(ranked[0] && ranked[1] && ranked[0].confidence > ranked[1].confidence).toBe(true);
    const resolved = resolveServiceCandidate([apimCandidate, siteCandidate], hints);
    expect(resolved?.ambiguous).not.toBe(true);
  });
});
