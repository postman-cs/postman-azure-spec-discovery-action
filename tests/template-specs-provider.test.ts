import { describe, expect, it, vi } from 'vitest';

import type { AzureTemplateSpecsClient, DeploymentSummary, TemplateSpecSummary } from '../src/lib/azure/clients.js';
import { extractApimInlineSpecs, TemplateSpecsProvider } from '../src/lib/providers/template-specs.js';

const INLINE_OPENAPI = {
  openapi: '3.0.3',
  info: { title: 'Billing', version: '1.0.0' },
  paths: { '/invoices': { get: { responses: { '200': { description: 'ok' } } } } }
};

const SECURE_DEFAULT = 'super-secret-default-value';
const SCRIPT_CONTENT = 'echo leaked-script-content';

function mainTemplate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',
    parameters: {
      backendSecret: { type: 'secureString', defaultValue: SECURE_DEFAULT }
    },
    resources: [
      {
        type: 'Microsoft.ApiManagement/service/apis',
        name: 'svc/billing',
        properties: { format: 'openapi+json', value: INLINE_OPENAPI }
      },
      {
        type: 'Microsoft.Resources/deploymentScripts',
        name: 'setup-script',
        properties: { scriptContent: SCRIPT_CONTENT, environmentVariables: [{ name: 'KEY', secureValue: SECURE_DEFAULT }] }
      }
    ],
    ...overrides
  };
}

const VERSION_ID =
  '/subscriptions/sub-1/resourceGroups/rg-infra/providers/Microsoft.Resources/templateSpecs/billing-stack/versions/1.0';

function templateSpec(overrides: Partial<TemplateSpecSummary> = {}): TemplateSpecSummary {
  return {
    id: '/subscriptions/sub-1/resourceGroups/rg-infra/providers/Microsoft.Resources/templateSpecs/billing-stack',
    name: 'billing-stack',
    resourceGroup: 'rg-infra',
    tags: { 'postman:repo': 'contoso/billing' },
    ...overrides
  };
}

function client(overrides: Partial<AzureTemplateSpecsClient> = {}): AzureTemplateSpecsClient {
  return {
    listTemplateSpecs: vi.fn(async () => [templateSpec()]),
    listVersions: vi.fn(async () => [{ id: VERSION_ID, name: '1.0' }]),
    getVersionMainTemplate: vi.fn(async () => mainTemplate()),
    listDeployments: vi.fn(async (): Promise<DeploymentSummary[]> => [
      { name: 'deploy-billing-prod', templateSpecVersionId: VERSION_ID },
      { name: 'deploy-unrelated' }
    ]),
    probeTemplateSpecsReadAccess: vi.fn(async () => undefined),
    ...overrides
  };
}

describe('TemplateSpecsProvider', () => {
  it('AZ-TSPEC-001: probe maps authorization failures to skipped:iam and other failures to skipped:error', async () => {
    const denied = new TemplateSpecsProvider(
      client({ probeTemplateSpecsReadAccess: vi.fn(async () => { throw new Error('AuthorizationFailed: template spec probe returned HTTP 403'); }) })
    );
    expect(await denied.probe()).toBe('skipped:iam');

    const broken = new TemplateSpecsProvider(
      client({ probeTemplateSpecsReadAccess: vi.fn(async () => { throw new Error('ECONNRESET'); }) })
    );
    expect(await broken.probe()).toBe('skipped:error');

    expect(await new TemplateSpecsProvider(client()).probe()).toBe('available');
  });

  it('AZ-TSPEC-002: versions embedding inline APIM documents become supported candidates with deployment evidence', async () => {
    const provider = new TemplateSpecsProvider(client());
    const candidates = await provider.listCandidates();
    expect(candidates).toHaveLength(1);
    const candidate = candidates[0]!;
    expect(candidate.providerType).toBe('template-specs');
    expect(candidate.supported).toBe(true);
    expect(candidate.id).toBe(`${VERSION_ID}#svc/billing`);
    expect(candidate.tags['postman:repo']).toBe('contoso/billing');
    expect(candidate.evidence.join(' ')).toContain('deploy-billing-prod');
    expect(candidate.evidence.join(' ')).not.toContain('deploy-unrelated');
  });

  it('AZ-TSPEC-003: versions without inline APIM documents stay visible as unsupported candidates', async () => {
    const provider = new TemplateSpecsProvider(
      client({ getVersionMainTemplate: vi.fn(async () => ({ resources: [] })) })
    );
    const candidates = await provider.listCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.supported).toBe(false);
    await expect(provider.exportSpec(candidates[0]!)).rejects.toThrow(/no exportable inline APIM document/);
  });

  it('AZ-TSPEC-004: exportSpec validates, normalizes, and declares completeness partial', async () => {
    const provider = new TemplateSpecsProvider(client());
    const [candidate] = await provider.listCandidates();
    const exported = await provider.exportSpec(candidate!);
    expect(exported.format).toBe('openapi-json');
    expect(exported.filename).toBe('index.json');
    expect(exported.completeness).toBe('partial');
    const parsed = JSON.parse(exported.content) as { openapi?: string; info?: { title?: string } };
    expect(parsed.openapi).toBe('3.0.3');
    expect(parsed.info?.title).toBe('Billing');
  });

  it('AZ-TSPEC-005: nested deployment templates are walked for embedded APIM documents', async () => {
    const nested = {
      resources: [
        {
          type: 'Microsoft.Resources/deployments',
          name: 'inner',
          properties: {
            template: {
              resources: [
                {
                  type: 'Microsoft.ApiManagement/service/apis',
                  name: 'svc/nested-api',
                  properties: { format: 'swagger-json', value: { swagger: '2.0', info: { title: 'Nested', version: '1' }, paths: { '/n': { get: { responses: { '200': { description: 'ok' } } } } } } }
                }
              ]
            }
          }
        }
      ]
    };
    const provider = new TemplateSpecsProvider(client({ getVersionMainTemplate: vi.fn(async () => nested) }));
    const candidates = await provider.listCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.supported).toBe(true);
    expect(candidates[0]!.id).toBe(`${VERSION_ID}#svc/nested-api`);
  });

  it('AZ-TSPEC-006: secure parameter defaults and deploymentScripts content never appear in candidates or exports', async () => {
    const provider = new TemplateSpecsProvider(client());
    const candidates = await provider.listCandidates();
    const serializedCandidates = JSON.stringify(candidates);
    expect(serializedCandidates).not.toContain(SECURE_DEFAULT);
    expect(serializedCandidates).not.toContain(SCRIPT_CONTENT);
    const exported = await provider.exportSpec(candidates.find((c) => c.supported)!);
    expect(exported.content).not.toContain(SECURE_DEFAULT);
    expect(exported.content).not.toContain(SCRIPT_CONTENT);
    expect(JSON.stringify(exported.evidence)).not.toContain(SECURE_DEFAULT);
  });

  it('AZ-TSPEC-007: an embedded document that references a secure parameter default is withheld, not exported', async () => {
    const leaky = mainTemplate({
      resources: [
        {
          type: 'Microsoft.ApiManagement/service/apis',
          name: 'svc/leaky',
          properties: {
            format: 'openapi+json',
            value: {
              openapi: '3.0.3',
              info: { title: 'Leaky', version: '1.0.0', description: `uses ${SECURE_DEFAULT}` },
              paths: { '/x': { get: { responses: { '200': { description: 'ok' } } } } }
            }
          }
        }
      ]
    });
    const provider = new TemplateSpecsProvider(client({ getVersionMainTemplate: vi.fn(async () => leaky) }));
    const candidates = await provider.listCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.supported).toBe(false);
    expect(candidates[0]!.evidence.join(' ')).toContain('withheld');
    expect(JSON.stringify(candidates)).not.toContain(SECURE_DEFAULT);
  });

  it('AZ-TSPEC-008: deployment history failures are fail-soft evidence-only, never fatal', async () => {
    const provider = new TemplateSpecsProvider(
      client({ listDeployments: vi.fn(async () => { throw new Error('HTTP 500'); }) })
    );
    const candidates = await provider.listCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.supported).toBe(true);
  });

  it('AZ-TSPEC-009: extractApimInlineSpecs ignores deploymentScripts subtrees entirely', () => {
    const extraction = extractApimInlineSpecs({
      resources: [
        {
          type: 'Microsoft.Resources/deploymentScripts',
          name: 'script',
          properties: { scriptContent: SCRIPT_CONTENT },
          resources: [
            {
              type: 'Microsoft.ApiManagement/service/apis',
              name: 'svc/inside-script',
              properties: { format: 'openapi+json', value: INLINE_OPENAPI }
            }
          ]
        }
      ]
    });
    expect(extraction.specs).toHaveLength(0);
  });
});
