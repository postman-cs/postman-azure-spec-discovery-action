import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApimProvider, buildApimApiArmId } from '../src/lib/providers/apim.js';
import { AppServiceProvider } from '../src/lib/providers/app-service.js';
import { IacLocalProvider } from '../src/lib/providers/iac-local.js';
import { scanAzureIac } from '../src/lib/repo/azure-iac-scanner.js';
import type { AzureApimClient, AzureAppServiceClient } from '../src/lib/azure/clients.js';

const VALID_OPENAPI = JSON.stringify({
  openapi: '3.0.3',
  info: { title: 'Payments', version: '1.0.0' },
  paths: { '/payments': { get: { responses: { '200': { description: 'ok' } } } } }
});

const SWAGGER_20 = JSON.stringify({
  swagger: '2.0',
  info: { title: 'Legacy', version: '1.0.0' },
  paths: { '/legacy': { get: { responses: { '200': { description: 'ok' } } } } }
});

describe('APIM provider', () => {
  function apimClient(overrides: Partial<AzureApimClient> = {}): AzureApimClient {
    return {
      listServices: vi.fn(async () => [
        { name: 'svc', resourceGroup: 'rg', tags: { 'postman:repo': 'org/payments' } }
      ]),
      listApis: vi.fn(async () => [
        {
          apiId: 'payments',
          displayName: 'Payments API',
          apiType: 'http',
          isCurrent: true,
          serviceName: 'svc',
          resourceGroup: 'rg'
        },
        {
          apiId: 'payments-soap',
          displayName: 'Payments SOAP',
          apiType: 'soap',
          isCurrent: true,
          serviceName: 'svc',
          resourceGroup: 'rg'
        },
        {
          apiId: 'payments-old;rev=1',
          displayName: 'Payments old revision',
          apiType: 'http',
          isCurrent: false,
          serviceName: 'svc',
          resourceGroup: 'rg'
        },
        {
          apiId: 'workspace-payments',
          displayName: 'Workspace Payments',
          apiType: 'http',
          isCurrent: true,
          serviceName: 'svc',
          resourceGroup: 'rg',
          workspaceId: 'team-a'
        }
      ]),
      exportApi: vi.fn(async () => VALID_OPENAPI),
      probeApimReadAccess: vi.fn(async () => undefined),
      ...overrides
    };
  }

  it('AZ-APIM-001: lists current APIs; http supported, soap visible-unsupported, non-current dropped', async () => {
    const provider = new ApimProvider(apimClient(), { subscriptionId: 'sub-1' });
    const candidates = await provider.listCandidates();
    expect(candidates).toHaveLength(3);
    const http = candidates.find((c) => c.meta.apiId === 'payments');
    const soap = candidates.find((c) => c.meta.apiId === 'payments-soap');
    expect(http?.supported).toBe(true);
    expect(soap?.supported).toBe(false);
    expect(http?.apiId).toBe(buildApimApiArmId('sub-1', 'rg', 'svc', 'payments'));
    expect(candidates.find((c) => c.meta.workspaceId === 'team-a')?.apiId).toBe(
      buildApimApiArmId('sub-1', 'rg', 'svc', 'workspace-payments', 'team-a')
    );
  });

  it('AZ-APIM-002: export validates OpenAPI and rejects unsupported candidates', async () => {
    const provider = new ApimProvider(apimClient(), { subscriptionId: 'sub-1' });
    const candidates = await provider.listCandidates();
    const http = candidates.find((c) => c.meta.apiId === 'payments');
    const soap = candidates.find((c) => c.meta.apiId === 'payments-soap');

    const exported = await provider.exportSpec(http!);
    expect(exported.format).toBe('openapi-json');
    expect(exported.filename).toBe('index.json');
    expect(exported.content.endsWith('\n')).toBe(true);
    expect(exported.content).toBe(`${JSON.stringify(JSON.parse(VALID_OPENAPI), null, 2)}\n`);

    await expect(provider.exportSpec(soap!)).rejects.toThrow('not exportable in v1');
  });

  it('AZ-APIM-005: malformed export content rejects', async () => {
    const provider = new ApimProvider(apimClient({ exportApi: vi.fn(async () => 'not json at all {{{') }), {
      subscriptionId: 'sub-1'
    });
    const candidates = await provider.listCandidates();
    const http = candidates.find((c) => c.meta.apiId === 'payments');
    await expect(provider.exportSpec(http!)).rejects.toThrow();
  });

  it('probe maps authorization failures to skipped:iam and others to skipped:error', async () => {
    const iam = new ApimProvider(
      apimClient({ probeApimReadAccess: vi.fn(async () => Promise.reject(new Error('AuthorizationFailed: no'))) }),
      { subscriptionId: 'sub-1' }
    );
    expect(await iam.probe()).toBe('skipped:iam');

    const err = new ApimProvider(
      apimClient({ probeApimReadAccess: vi.fn(async () => Promise.reject(new Error('socket hang up'))) }),
      { subscriptionId: 'sub-1' }
    );
    expect(await err.probe()).toBe('skipped:error');
  });
});

describe('App Service provider', () => {
  function appClient(sites: Array<{ name: string; resourceGroup: string; tags?: Record<string, string>; apiDefinitionUrl?: string }>): AzureAppServiceClient {
    return {
      listSites: vi.fn(async () => sites.map((s) => ({ tags: {}, ...s }))),
      probeAppServiceReadAccess: vi.fn(async () => undefined)
    };
  }

  it('AZ-APP-001: only sites with a non-empty API definition URL are candidates; HTTP rejects before fetch', async () => {
    const provider = new AppServiceProvider(
      appClient([
        { name: 'no-def', resourceGroup: 'rg' },
        { name: 'http-def', resourceGroup: 'rg', apiDefinitionUrl: 'http://insecure.example/swagger.json' },
        { name: 'https-def', resourceGroup: 'rg', apiDefinitionUrl: 'https://ok.example/swagger.json' }
      ]),
      { subscriptionId: 'sub-1' }
    );
    const candidates = await provider.listCandidates();
    expect(candidates.map((c) => c.name)).toEqual(['http-def', 'https-def']);

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const httpCandidate = candidates.find((c) => c.name === 'http-def');
    await expect(provider.exportSpec(httpCandidate!)).rejects.toThrow('must use HTTPS');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe('IaC scanner + provider', () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), 'az-iac-'));
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('AZ-IAC-001: inline APIM OpenAPI values become candidates; link formats never do', async () => {
    const template = {
      resources: [
        {
          type: 'Microsoft.ApiManagement/service/apis',
          name: 'svc/payments',
          properties: { format: 'openapi+json', value: JSON.parse(VALID_OPENAPI) }
        },
        {
          type: 'Microsoft.ApiManagement/service/apis',
          name: 'svc/linked',
          properties: { format: 'openapi-link', value: 'https://example.com/spec.json' }
        },
        {
          type: 'Microsoft.Storage/storageAccounts',
          name: 'unrelated',
          properties: {}
        }
      ]
    };
    await writeFile(path.join(repoRoot, 'azuredeploy.json'), JSON.stringify(template));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const scan = await scanAzureIac(repoRoot, 'discovered-specs');
    expect(scan.candidates).toHaveLength(1);
    expect(scan.candidates[0]?.id).toContain('azuredeploy.json#svc/payments');
    expect(scan.fingerprint.evidence.join(' ')).toContain('not fetched');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('AZ-IAC-001b: string inline values parse as JSON or YAML; swagger 2.0 accepted', async () => {
    const template = {
      resources: [
        {
          type: 'Microsoft.ApiManagement/service/apis',
          name: 'svc/legacy',
          properties: { format: 'swagger-json', value: SWAGGER_20 }
        }
      ]
    };
    await writeFile(path.join(repoRoot, 'template.json'), JSON.stringify(template));
    const scan = await scanAzureIac(repoRoot, 'discovered-specs');
    expect(scan.candidates).toHaveLength(1);

    const provider = new IacLocalProvider(scan);
    const exported = await provider.exportSpec(scan.candidates[0]!);
    expect(exported.format).toBe('openapi-json');
  });

  it('AZ-IAC-002: invalid inline documents are not candidates', async () => {
    const template = {
      resources: [
        {
          type: 'Microsoft.ApiManagement/service/apis',
          name: 'svc/broken',
          properties: { format: 'openapi+json', value: { openapi: '3.0.3', info: { title: 'x', version: '1' }, paths: {} } }
        }
      ]
    };
    await writeFile(path.join(repoRoot, 'azuredeploy.json'), JSON.stringify(template));
    const scan = await scanAzureIac(repoRoot, 'discovered-specs');
    expect(scan.candidates).toHaveLength(0);
  });

  it('AZ-IAC-003: confinement skips output dir, node_modules, and out-of-root symlinks', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'az-outside-'));
    try {
      const template = {
        resources: [
          {
            type: 'Microsoft.ApiManagement/service/apis',
            name: 'svc/outside',
            properties: { format: 'openapi+json', value: JSON.parse(VALID_OPENAPI) }
          }
        ]
      };
      await writeFile(path.join(outside, 'evil.json'), JSON.stringify(template));
      await mkdir(path.join(repoRoot, 'node_modules'), { recursive: true });
      await writeFile(path.join(repoRoot, 'node_modules', 'dep.json'), JSON.stringify(template));
      await mkdir(path.join(repoRoot, 'discovered-specs'), { recursive: true });
      await writeFile(path.join(repoRoot, 'discovered-specs', 'gen.json'), JSON.stringify(template));
      await symlink(path.join(outside, 'evil.json'), path.join(repoRoot, 'link.json'));

      const scan = await scanAzureIac(repoRoot, 'discovered-specs');
      expect(scan.candidates).toHaveLength(0);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('AZ-IAC-004: azure.yaml yields confined validated references and fingerprint hints, no exec/network', async () => {
    await writeFile(path.join(repoRoot, 'openapi.json'), VALID_OPENAPI);
    await writeFile(
      path.join(repoRoot, 'azure.yaml'),
      ['name: payments-project', 'services:', '  payments:', '    project: ./openapi.json', '  escapes:', '    project: ../outside.json', '  remote:', '    project: https://example.com/spec.json'].join('\n')
    );
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const scan = await scanAzureIac(repoRoot, 'discovered-specs');
    expect(scan.candidates).toHaveLength(1);
    expect(scan.candidates[0]?.name).toBe('payments');
    expect(scan.fingerprint.serviceNames).toContain('payments-project');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
