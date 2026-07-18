import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { lookupMock } = vi.hoisted(() => ({
  lookupMock: vi.fn(async () => [{ address: '8.8.8.8', family: 4 }])
}));

vi.mock('node:dns/promises', () => ({ lookup: lookupMock }));

import { AppServiceProvider } from '../src/lib/providers/app-service.js';
import type { AzureAppServiceClient } from '../src/lib/azure/clients.js';

const VALID_OPENAPI = JSON.stringify({
  openapi: '3.0.3',
  info: { title: 'App', version: '1.0.0' },
  paths: { '/health': { get: { responses: { 200: { description: 'ok' } } } } }
});

describe('App Service provider', () => {
  beforeEach(() => {
    lookupMock.mockReset();
    lookupMock.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('AZ-APP-001: empty definitions are omitted and HTTPS documents enforce validity plus both size ceilings', async () => {
    const client: AzureAppServiceClient = {
      listSites: vi.fn(async () => [
        { name: 'empty', resourceGroup: 'rg', tags: {} },
        { name: 'http', resourceGroup: 'rg', tags: {}, apiDefinitionUrl: 'http://app.example/spec' },
        { name: 'valid', resourceGroup: 'rg', tags: {}, apiDefinitionUrl: 'https://valid.example/spec' },
        { name: 'invalid', resourceGroup: 'rg', tags: {}, apiDefinitionUrl: 'https://invalid.example/spec' },
        { name: 'header-large', resourceGroup: 'rg', tags: {}, apiDefinitionUrl: 'https://header.example/spec' },
        { name: 'body-large', resourceGroup: 'rg', tags: {}, apiDefinitionUrl: 'https://body.example/spec' }
      ]),
      probeAppServiceReadAccess: vi.fn(async () => undefined)
    };
    const provider = new AppServiceProvider(client, { subscriptionId: 'sub-1' });
    const candidates = await provider.listCandidates();
    expect(candidates.map((candidate) => candidate.name)).toEqual([
      'http', 'valid', 'invalid', 'header-large', 'body-large'
    ]);

    const byName = (name: string) => candidates.find((candidate) => candidate.name === name)!;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const host = new URL(String(input)).hostname;
      if (host === 'valid.example') return new Response(VALID_OPENAPI, { status: 200 });
      if (host === 'invalid.example') return new Response('{"openapi":"3.0.3","paths":{}}', { status: 200 });
      if (host === 'header.example') {
        return new Response('oversize', { status: 200, headers: { 'content-length': String(11 * 1024 * 1024) } });
      }
      return new Response('x'.repeat(10 * 1024 * 1024 + 1), { status: 200 });
    });

    await expect(provider.exportSpec(byName('http'))).rejects.toThrow('must use HTTPS');
    await expect(provider.exportSpec(byName('valid'))).resolves.toMatchObject({ format: 'openapi-json' });
    await expect(provider.exportSpec(byName('invalid'))).rejects.toThrow();
    await expect(provider.exportSpec(byName('header-large'))).rejects.toThrow('Response too large');
    await expect(provider.exportSpec(byName('body-large'))).rejects.toThrow('Response body too large');
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });
});
