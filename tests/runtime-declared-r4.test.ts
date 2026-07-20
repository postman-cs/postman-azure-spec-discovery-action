import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { lookupMock } = vi.hoisted(() => ({
  lookupMock: vi.fn(async () => [{ address: '8.8.8.8', family: 4 }])
}));

vi.mock('node:dns/promises', () => ({ lookup: lookupMock }));

import {
  RuntimeDeclaredRoutesProvider,
  type RuntimeDeclaredSpecTarget
} from '../src/lib/providers/runtime-declared-routes.js';

const VALID_OPENAPI = `${JSON.stringify({
  openapi: '3.0.3',
  info: { title: 'RuntimeOrders', version: '1.0.0' },
  paths: { '/orders': { get: { responses: { '200': { description: 'ok' } } } } }
})}\n`;

function target(overrides: Partial<RuntimeDeclaredSpecTarget> = {}): RuntimeDeclaredSpecTarget {
  return {
    id: '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.App/containerApps/orders/spec',
    name: 'orders-ca',
    workloadKind: 'container-apps',
    url: 'https://orders.example.com/openapi.json',
    resourceId: '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.App/containerApps/orders',
    providerResourceType: 'Microsoft.App/containerApps',
    tags: { 'postman:repo': 'contoso/orders' },
    ...overrides
  };
}

describe('R4 runtime-declared specification routes', () => {
  beforeEach(() => {
    lookupMock.mockReset();
    lookupMock.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('AZ-RT-R4-001: disabled by default — lists no candidates and performs no probing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const provider = new RuntimeDeclaredRoutesProvider({
      targets: [target()]
    });
    expect(await provider.listCandidates()).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('AZ-RT-R4-002: explicit HTTPS target exports authoritative validated document', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(VALID_OPENAPI, {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
    const provider = new RuntimeDeclaredRoutesProvider({
      enabled: true,
      targets: [target()]
    });
    const [candidate] = await provider.listCandidates();
    expect(candidate!.providerType).toBe('runtime-declared');
    expect(candidate!.meta.workloadKind).toBe('container-apps');
    expect(candidate!.evidence.join('\n')).toMatch(/No blind common-path probing/i);
    const exported = await provider.exportSpec(candidate!);
    expect(exported.contractClass).toBe('authoritative');
    expect(exported.content).toContain('RuntimeOrders');
  });

  it('AZ-RT-R4-003: rejects blind common-path inventing — only exact declared URLs', async () => {
    const provider = new RuntimeDeclaredRoutesProvider({
      enabled: true,
      targets: []
    });
    expect(await provider.listCandidates()).toEqual([]);
    // Provider has no API to probe /swagger.json across an estate.
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(provider))).not.toContain('probeCommonPaths');
  });

  it('AZ-RT-R4-004: never forwards credentials on public runtime fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(VALID_OPENAPI, {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
    const provider = new RuntimeDeclaredRoutesProvider({
      enabled: true,
      targets: [target({ url: 'https://orders.example.com/openapi.json' })]
    });
    const [candidate] = await provider.listCandidates();
    await provider.exportSpec(candidate!);
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('cookie')).toBeNull();
    expect(headers.get('x-ms-path-query')).toBeNull();
  });

  it('AZ-RT-R4-005: invalid document is not treated as authoritative', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"not":"openapi"}\n', {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
    const provider = new RuntimeDeclaredRoutesProvider({
      enabled: true,
      targets: [target()]
    });
    const [candidate] = await provider.listCandidates();
    await expect(provider.exportSpec(candidate!)).rejects.toThrow(/did not validate|not authoritative/i);
  });

  it('AZ-RT-R4-006: preserves provider/resource identity metadata', async () => {
    const provider = new RuntimeDeclaredRoutesProvider({
      enabled: true,
      targets: [
        target({
          workloadKind: 'aks',
          providerResourceType: 'Microsoft.ContainerService/managedClusters',
          resourceId: '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.ContainerService/managedClusters/k8s'
        })
      ]
    });
    const [candidate] = await provider.listCandidates();
    expect(candidate!.meta.providerResourceType).toBe('Microsoft.ContainerService/managedClusters');
    expect(candidate!.meta.resourceId).toContain('managedClusters/k8s');
    expect(candidate!.meta.workloadKind).toBe('aks');
  });

  it('AZ-RT-R4-007: evidence and errors redact query/SAS while preserving SSRF distinction', async () => {
    const sasUrl = 'https://orders.example.com/openapi.json?sv=2024-01-01&sig=super-secret-sas';
    const provider = new RuntimeDeclaredRoutesProvider({
      enabled: true,
      targets: [target({ url: sasUrl })]
    });
    const [candidate] = await provider.listCandidates();
    expect(candidate!.evidence.join('\n')).toContain('https://orders.example.com/openapi.json');
    expect(candidate!.evidence.join('\n')).not.toMatch(/sig=|super-secret|sv=/);
    // meta retains the fetchable URL (including SAS) for the guarded fetch itself
    expect(candidate!.meta.specUrl).toBe(sasUrl);

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(VALID_OPENAPI, { status: 200, headers: { 'content-type': 'application/json' } })
    );
    const exported = await provider.exportSpec(candidate!);
    expect(exported.evidence.join('\n')).toContain('https://orders.example.com/openapi.json');
    expect(exported.evidence.join('\n')).not.toMatch(/sig=|super-secret/);

    const blockedProvider = new RuntimeDeclaredRoutesProvider({
      enabled: true,
      targets: [target({ url: 'https://127.0.0.1/openapi.json?sig=secret-sas' })]
    });
    const [blocked] = await blockedProvider.listCandidates();
    await expect(blockedProvider.exportSpec(blocked!)).rejects.toThrow(/blocked by SSRF defenses/i);
    try {
      await blockedProvider.exportSpec(blocked!);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain('https://127.0.0.1/openapi.json');
      expect(message).not.toMatch(/sig=|secret-sas/);
      expect(message).not.toMatch(/private-network-unreachable/i);
    }
  });
});
