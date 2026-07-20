import { describe, expect, it, vi } from 'vitest';

import type { AzureCustomApisClient, CustomApiSummary } from '../src/lib/azure/clients.js';
import { CustomApisProvider } from '../src/lib/providers/custom-apis.js';
import { toSafePublicUrl } from '../src/lib/providers/public-url.js';

const SWAGGER = JSON.stringify({
  swagger: '2.0',
  info: { title: 'payments-connector', version: '1.0' },
  host: 'api.contoso.com',
  basePath: '/payments',
  paths: { '/charges': { get: { responses: { 200: { description: 'ok' } } } } }
});

function connector(overrides: Partial<CustomApiSummary> = {}): CustomApiSummary {
  return {
    id: '/subscriptions/sub-1/resourceGroups/rg-pay/providers/Microsoft.Web/customApis/payments-connector',
    name: 'payments-connector',
    resourceGroup: 'rg-pay',
    tags: { 'postman:repo': 'contoso/payments' },
    hasSwagger: true,
    hasWsdl: false,
    backendServiceUrl: 'https://api.contoso.com/payments',
    ...overrides
  };
}

function client(overrides: Partial<AzureCustomApisClient> = {}): AzureCustomApisClient {
  return {
    listCustomApis: vi.fn(async () => [connector()]),
    getSwagger: vi.fn(async () => `${SWAGGER}\n`),
    getWsdl: vi.fn(async () => ({ content: '' })),
    probeCustomApisReadAccess: vi.fn(async () => undefined),
    ...overrides
  };
}

function credentialedUrl(base: string, query: string, fragment: string): string {
  const url = new URL(base);
  url.username = 'user';
  url.password = 'pass';
  url.search = query;
  url.hash = fragment;
  return url.toString();
}

describe('CustomApisProvider', () => {
  it('AZ-CAPI-001: probe maps authorization failures to skipped:iam and other failures to skipped:error', async () => {
    const authDenied = new CustomApisProvider(
      client({ probeCustomApisReadAccess: vi.fn(async () => { throw new Error('AuthorizationFailed: custom API probe returned HTTP 403'); }) })
    );
    expect(await authDenied.probe()).toBe('skipped:iam');

    const broken = new CustomApisProvider(
      client({ probeCustomApisReadAccess: vi.fn(async () => { throw new Error('ECONNRESET'); }) })
    );
    expect(await broken.probe()).toBe('skipped:error');

    const healthy = new CustomApisProvider(client());
    expect(await healthy.probe()).toBe('available');
  });

  it('AZ-CAPI-002: connectors with inline swagger are supported candidates carrying resource coordinates', async () => {
    const provider = new CustomApisProvider(client());
    const candidates = await provider.listCandidates();
    expect(candidates).toHaveLength(1);
    const candidate = candidates[0]!;
    expect(candidate.providerType).toBe('custom-apis');
    expect(candidate.supported).toBe(true);
    expect(candidate.tags['postman:repo']).toBe('contoso/payments');
    expect(candidate.meta.resourceGroup).toBe('rg-pay');
    expect(candidate.meta.connectorName).toBe('payments-connector');
    expect(candidate.evidence.join(' ')).toContain('inline swagger');
  });

  it('AZ-CAPI-003: connectors without inline swagger or WSDL stay visible as unsupported, never exported', async () => {
    const provider = new CustomApisProvider(
      client({
        listCustomApis: vi.fn(async () => [
          connector({ hasSwagger: false, hasWsdl: false, originalSwaggerUrl: 'https://example.com/swagger.json' })
        ])
      })
    );
    const candidates = await provider.listCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.supported).toBe(false);
    expect(candidates[0]!.evidence.join(' ')).toContain('not auto-fetched');
    await expect(provider.exportSpec(candidates[0]!)).rejects.toThrow(/no inline swagger or WSDL/i);
  });

  it('AZ-CAPI-004: exportSpec validates and normalizes the inline swagger document', async () => {
    const provider = new CustomApisProvider(client());
    const [candidate] = await provider.listCandidates();
    const exported = await provider.exportSpec(candidate!);
    expect(exported.format).toBe('openapi-json');
    expect(exported.filename).toBe('index.json');
    const parsed = JSON.parse(exported.content) as { swagger?: string; info?: { title?: string } };
    expect(parsed.swagger).toBe('2.0');
    expect(parsed.info?.title).toBe('payments-connector');
    expect(exported.evidence.join(' ')).toContain('payments-connector');
  });

  it('AZ-CAPI-005: exportSpec rejects invalid inline documents instead of exporting garbage', async () => {
    const provider = new CustomApisProvider(
      client({ getSwagger: vi.fn(async () => '{"not": "a spec"}') })
    );
    const [candidate] = await provider.listCandidates();
    await expect(provider.exportSpec(candidate!)).rejects.toThrow();
  });

  it('AZ-CAPI-006: candidate metadata never carries connectionParameters or secret-adjacent fields', async () => {
    const provider = new CustomApisProvider(client({
      listCustomApis: vi.fn(async () => [connector({
        backendServiceUrl: credentialedUrl('https://api.contoso.com:8443/payments', 'code=secret', 'fragment'),
        originalSwaggerUrl: credentialedUrl('https://example.com/swagger.json', 'sig=secret', 'fragment')
      })])
    }));
    const [candidate] = await provider.listCandidates();
    const serialized = JSON.stringify(candidate);
    expect(serialized).not.toContain('connectionParameters');
    expect(serialized).not.toContain('clientSecret');
    expect(serialized).not.toContain('oAuthSettings');
    expect(serialized).not.toContain('user');
    expect(serialized).not.toContain('pass');
    expect(serialized).not.toContain('code=');
    expect(serialized).not.toContain('fragment');
    expect(serialized).toContain('https://api.contoso.com:8443/payments');
  });

  it('omits malformed public URL fields without failing discovery', async () => {
    const provider = new CustomApisProvider(client({
      listCustomApis: vi.fn(async () => [connector({ backendServiceUrl: 'not a URL', originalSwaggerUrl: 'ftp://example.com/spec' })])
    }));
    const [candidate] = await provider.listCandidates();
    expect(candidate?.meta.backendServiceUrl).toBeUndefined();
    expect(JSON.stringify(candidate)).not.toContain('not a URL');
  });

  const VALID_WSDL = `<?xml version="1.0"?>
<definitions xmlns="http://schemas.xmlsoap.org/wsdl/"
             xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
             xmlns:tns="http://postman.example/payments"
             name="PaymentsSoap"
             targetNamespace="http://postman.example/payments">
  <types/>
  <message name="GetHealthRequest"/>
  <message name="GetHealthResponse"/>
  <portType name="PaymentsPortType">
    <operation name="GetHealth">
      <input message="tns:GetHealthRequest"/>
      <output message="tns:GetHealthResponse"/>
    </operation>
  </portType>
  <binding name="PaymentsBinding" type="tns:PaymentsPortType">
    <soap:binding transport="http://schemas.xmlsoap.org/soap/http" style="document"/>
  </binding>
  <service name="PaymentsService">
    <port name="PaymentsPort" binding="tns:PaymentsBinding"/>
  </service>
</definitions>`;

  it('AZ-CAPI-014: WSDL-only connector exports authoritative service.wsdl', async () => {
    const provider = new CustomApisProvider(
      client({
        listCustomApis: vi.fn(async () => [
          connector({ hasSwagger: false, hasWsdl: true, wsdlImportMethod: 'SoapPassThrough' })
        ]),
        getWsdl: vi.fn(async () => ({ content: VALID_WSDL, importMethod: 'SoapPassThrough' }))
      })
    );
    const [candidate] = await provider.listCandidates();
    expect(candidate!.supported).toBe(true);
    expect(candidate!.meta.preferredFormat).toBe('wsdl');
    const exported = await provider.exportSpec(candidate!);
    expect(exported).toMatchObject({
      format: 'wsdl',
      filename: 'service.wsdl',
      contractClass: 'authoritative',
      completeness: 'full'
    });
    expect(exported.content).toContain('PaymentsSoap');
  });

  it('AZ-CAPI-015: when both swagger and WSDL exist, swagger wins and WSDL is demoted', async () => {
    const getWsdl = vi.fn(async () => ({ content: VALID_WSDL }));
    const provider = new CustomApisProvider(
      client({
        listCustomApis: vi.fn(async () => [connector({ hasSwagger: true, hasWsdl: true })]),
        getWsdl
      })
    );
    const [candidate] = await provider.listCandidates();
    expect(candidate!.meta.preferredFormat).toBe('swagger');
    expect(candidate!.evidence.join(' ')).toMatch(/demoted/i);
    const exported = await provider.exportSpec(candidate!);
    expect(exported.format).toBe('openapi-json');
    expect(exported.contractClass).toBe('authoritative');
    expect(exported.evidence.join(' ')).toMatch(/demoted/i);
    expect(getWsdl).not.toHaveBeenCalled();
  });

  it('AZ-CAPI-016: SoapToRest WSDL is reconstructed/partial, never authoritative', async () => {
    const provider = new CustomApisProvider(
      client({
        listCustomApis: vi.fn(async () => [
          connector({ hasSwagger: false, hasWsdl: true, wsdlImportMethod: 'SoapToRest' })
        ]),
        getWsdl: vi.fn(async () => ({ content: VALID_WSDL, importMethod: 'SoapToRest' }))
      })
    );
    const [candidate] = await provider.listCandidates();
    expect(candidate!.evidence.join(' ')).toMatch(/SoapToRest|reconstructed/i);
    const exported = await provider.exportSpec(candidate!);
    expect(exported.contractClass).toBe('reconstructed');
    expect(exported.completeness).toBe('partial');
  });
});

describe('toSafePublicUrl', () => {
  it('retains protocol, host, port, and path while stripping userinfo, query, and fragment', () => {
    expect(toSafePublicUrl(credentialedUrl('https://example.com:8443/api/v1', 'token=secret', 'section'))).toBe(
      'https://example.com:8443/api/v1'
    );
  });

  it('rejects malformed and non-http(s) URLs', () => {
    expect(toSafePublicUrl('not a URL')).toBeUndefined();
    expect(toSafePublicUrl('ftp://example.com/spec')).toBeUndefined();
  });
});
