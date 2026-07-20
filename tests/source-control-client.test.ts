import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SourceControlSdkClient,
  normalizeSourceControlRepoUrl,
  sourceControlMatchesRepoContext,
  sourceControlAssociationEvidence
} from '../src/lib/azure/source-control-client.js';

function fakeCredential() {
  return { getToken: vi.fn(async () => ({ token: 'arm-token', expiresOnTimestamp: Date.now() + 3600_000 })) };
}

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) }
  });
}

describe('SourceControlSdkClient', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('normalizes repo URL org/repo exactly (ssh, .git, query/userinfo stripped)', () => {
    expect(normalizeSourceControlRepoUrl('https://github.com/Acme/Demo.git')).toEqual({
      repoUrl: 'https://github.com/Acme/Demo',
      org: 'Acme',
      repo: 'Demo'
    });
    expect(normalizeSourceControlRepoUrl('git@github.com:acme/demo.git')).toEqual({
      repoUrl: 'https://github.com/acme/demo',
      org: 'acme',
      repo: 'demo'
    });
    expect(normalizeSourceControlRepoUrl('https://token@github.com/acme/demo?ref=main')).toBeUndefined();
    expect(
      normalizeSourceControlRepoUrl('https://github.com/acme/demo?sig=secrettoken')
    ).toBeUndefined();
  });

  it('matches exact normalized org/repo plus branch', () => {
    const association = {
      org: 'acme',
      repo: 'demo',
      branch: 'main',
      repoUrl: 'https://github.com/acme/demo'
    };
    expect(sourceControlMatchesRepoContext(association, 'acme/demo', 'main')).toBe(true);
    expect(sourceControlMatchesRepoContext(association, 'acme/demo', 'develop')).toBe(false);
    expect(sourceControlMatchesRepoContext(association, 'acme/other', 'main')).toBe(false);
  });

  it('App Service GET sourcecontrols/web retains only normalized repoUrl/branch/owning id', async () => {
    const client = new SourceControlSdkClient(fakeCredential(), 'sub-1', {
      requestTimeoutMs: 30000,
      maxAttempts: 3,
      sleep: async () => undefined
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        id: '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.Web/sites/app1/sourcecontrols/web',
        properties: {
          repoUrl: 'https://github.com/acme/demo.git',
          branch: 'main',
          gitHubActionConfiguration: {
            containerConfiguration: { password: 'super-secret', username: 'u', serverUrl: 'https://reg' }
          },
          isGitHubAction: true
        }
      })
    );

    const result = await client.getAppServiceSourceControl('rg', 'app1');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.association).toEqual({
      resourceId: '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.Web/sites/app1',
      resourceGroup: 'rg',
      name: 'app1',
      kind: 'app-service',
      repoUrl: 'https://github.com/acme/demo',
      branch: 'main',
      org: 'acme',
      repo: 'demo'
    });
    const serialized = JSON.stringify(result.association);
    expect(serialized).not.toMatch(/super-secret|gitHubActionConfiguration|password|token/i);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain(
      '/providers/Microsoft.Web/sites/app1/sourcecontrols/web?api-version=2023-12-01'
    );
    expect(sourceControlAssociationEvidence(result.association)).toMatch(/association-only/);
  });

  it('Container Apps sourcecontrols list projects repoUrl/branch and drops credentials', async () => {
    const client = new SourceControlSdkClient(fakeCredential(), 'sub-1', {
      requestTimeoutMs: 30000,
      maxAttempts: 3,
      sleep: async () => undefined
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        value: [
          {
            id: '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.App/containerApps/orders/sourcecontrols/current',
            properties: {
              repoUrl: 'https://github.com/acme/orders',
              branch: 'release',
              githubActionConfiguration: {
                githubPersonalAccessToken: 'ghp_secret',
                azureCredentials: { clientSecret: 'secret' },
                registryInfo: { registryPassword: 'reg-secret', registryUrl: 'reg.azurecr.io' }
              }
            }
          }
        ]
      })
    );

    const results = await client.listContainerAppSourceControls('rg', 'orders');
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('ok');
    if (results[0]?.status !== 'ok') return;
    expect(results[0].association.repoUrl).toBe('https://github.com/acme/orders');
    expect(results[0].association.branch).toBe('release');
    expect(results[0].association.resourceId).toBe(
      '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.App/containerApps/orders'
    );
    expect(JSON.stringify(results[0].association)).not.toMatch(
      /ghp_secret|clientSecret|registryPassword|githubActionConfiguration/i
    );
  });

  it('401/403 is association-unavailable fail-soft', async () => {
    const client = new SourceControlSdkClient(fakeCredential(), 'sub-1', {
      requestTimeoutMs: 30000,
      maxAttempts: 1,
      sleep: async () => undefined
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ error: { code: 'AuthorizationFailed' } }, { status: 403 }));
    const result = await client.getAppServiceSourceControl('rg', 'app1');
    expect(result).toEqual({
      status: 'unavailable',
      reason: 'iam',
      detail: 'App Service source-control association unavailable (HTTP 403)'
    });
  });

  it('malformed and oversized payloads terminate as unavailable', async () => {
    const client = new SourceControlSdkClient(fakeCredential(), 'sub-1', {
      requestTimeoutMs: 30000,
      maxAttempts: 1,
      sleep: async () => undefined
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('not-json{', { status: 200, headers: { 'content-type': 'application/json' } })
    );
    const malformed = await client.getAppServiceSourceControl('rg', 'app1');
    expect(malformed.status).toBe('unavailable');
    if (malformed.status === 'unavailable') expect(malformed.reason).toBe('malformed');

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-length': String(512 * 1024) }
      })
    );
    const oversized = await client.getAppServiceSourceControl('rg', 'app1');
    expect(oversized.status).toBe('unavailable');
    if (oversized.status === 'unavailable') expect(oversized.reason).toBe('oversized');
  });

  it('chunked ReadableStream exceeding 256 KiB cancels the reader and returns oversized without secret bytes', async () => {
    const client = new SourceControlSdkClient(fakeCredential(), 'sub-1', {
      requestTimeoutMs: 30000,
      maxAttempts: 1,
      sleep: async () => undefined
    });
    const SECRET = 'super-secret-chunk-token-xyz';
    const secretBytes = new TextEncoder().encode(
      `{"properties":{"repoUrl":"https://github.com/acme/demo","branch":"main","token":"${SECRET}"}}`
    );
    const padChunk = new Uint8Array(64 * 1024).fill(0x61); // 'a' padding
    // Enough chunks that a full drain exceeds 256 KiB; cancel must stop natural close.
    const maxChunks = 8;
    let enqueued = 0;
    let cancelCount = 0;
    let closedNaturally = false;

    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (enqueued === 0) {
          controller.enqueue(secretBytes);
          enqueued += 1;
          return;
        }
        if (enqueued >= maxChunks) {
          closedNaturally = true;
          controller.close();
          return;
        }
        controller.enqueue(padChunk);
        enqueued += 1;
      },
      cancel() {
        cancelCount += 1;
      }
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );

    const result = await client.getAppServiceSourceControl('rg', 'app1');
    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') {
      expect(result.reason).toBe('oversized');
      expect(result.detail).toMatch(/exceeded .* bytes/i);
      expect(result.detail).not.toContain(SECRET);
      expect(result.detail).not.toMatch(/super-secret|ghp_|Bearer|password/i);
    }
    expect(cancelCount).toBeGreaterThan(0);
    expect(closedNaturally).toBe(false);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    // Bounded termination: fewer than a full oversized drain was enqueued.
    expect(enqueued).toBeLessThan(maxChunks);
  });

  it('pagination repeat and page ceiling terminate', async () => {
    const client = new SourceControlSdkClient(fakeCredential(), 'sub-1', {
      requestTimeoutMs: 30000,
      maxAttempts: 1,
      sleep: async () => undefined
    });
    const firstUrl =
      'https://management.azure.com/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.App/containerApps/orders/sourcecontrols?api-version=2026-01-01';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === firstUrl) {
        return jsonResponse({
          value: [],
          nextLink: firstUrl
        });
      }
      return jsonResponse({ value: [] });
    });
    const repeated = await client.listContainerAppSourceControls('rg', 'orders');
    expect(repeated[0]?.status).toBe('unavailable');
    if (repeated[0]?.status === 'unavailable') expect(repeated[0].reason).toBe('pagination');
  });

  it('sovereign ARM host is used; foreign nextLink host is rejected', async () => {
    vi.stubEnv('AZURE_ENVIRONMENT', 'AzureUSGovernment');
    const client = new SourceControlSdkClient(fakeCredential(), 'sub-1', {
      requestTimeoutMs: 30000,
      maxAttempts: 1,
      sleep: async () => undefined
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      expect(url.startsWith('https://management.usgovcloudapi.net/')).toBe(true);
      if (url.includes('sourcecontrols?') && !url.includes('page=')) {
        return jsonResponse({
          value: [],
          nextLink:
            'https://management.azure.com/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.App/containerApps/orders/sourcecontrols?api-version=2026-01-01&page=2'
        });
      }
      return jsonResponse({ value: [] });
    });
    const results = await client.listContainerAppSourceControls('rg', 'orders');
    expect(fetchSpy).toHaveBeenCalled();
    expect(results[0]?.status).toBe('unavailable');
    if (results[0]?.status === 'unavailable') expect(results[0].reason).toBe('pagination');
  });

  it('never retains credentials in evidence helpers', () => {
    const evidence = sourceControlAssociationEvidence({
      resourceId: '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.Web/sites/app1',
      resourceGroup: 'rg',
      name: 'app1',
      kind: 'app-service',
      repoUrl: 'https://github.com/acme/demo',
      branch: 'main',
      org: 'acme',
      repo: 'demo'
    });
    expect(evidence).toContain('acme/demo');
    expect(evidence).not.toMatch(/token|password|secret|Bearer/i);
  });
});
