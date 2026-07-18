import { describe, expect, it } from 'vitest';

import { renderAmbiguityStepSummary } from '../src/lib/logging/step-summary.js';

describe('ambiguity step summary', () => {
  it('AZ-SUMMARY-001: golden markdown with Azure heading, probes, and redacted resource ids', () => {
    const markdown = renderAmbiguityStepSummary({
      status: 'unresolved',
      sourceType: 'manual-review',
      narrowingTier: 'naming-heuristic',
      candidates: [
        {
          rank: 1,
          serviceName: 'payments-a',
          resourceId:
            '/subscriptions/aaaaaaaa-1111-2222-3333-444444444444/resourceGroups/payments-rg/providers/Microsoft.ApiManagement/service/svc/apis/payments-a',
          providerType: 'apim',
          confidence: 30,
          supported: true,
          evidence: ['Display name matches']
        },
        {
          rank: 2,
          serviceName: 'payments-b',
          resourceId:
            '/subscriptions/aaaaaaaa-1111-2222-3333-444444444444/resourceGroups/payments-rg/providers/Microsoft.ApiManagement/service/svc/apis/payments-b',
          providerType: 'apim',
          confidence: 30,
          supported: true,
          evidence: ['Display name matches']
        }
      ],
      probes: [
        { provider: 'apim', status: 'available' },
        { provider: 'app-service', status: 'skipped:iam' },
        { provider: 'iac-local', status: 'skipped:error' }
      ]
    });

    expect(markdown).toContain('## Postman Azure spec discovery');
    expect(markdown).toContain('`unresolved`');
    expect(markdown).toContain('`manual-review`');
    expect(markdown).toContain('`naming-heuristic`');
    expect(markdown).toContain('`payments-a`');
    expect(markdown).toContain('`available`');
    expect(markdown).toContain('`skipped:iam`');
    expect(markdown).toContain('`skipped:error`');
    // Subscription UUID must be redacted out of the resource column
    expect(markdown).not.toContain('aaaaaaaa-1111-2222-3333-444444444444');
  });
});
