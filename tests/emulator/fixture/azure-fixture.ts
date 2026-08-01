/**
 * Hermetic compound Azure fixture for the emulator lane: Entra ID token
 * endpoint (login.microsoftonline.com), ARM control plane
 * (management.azure.com) with an APIM service + APIs, and the Storage SAS
 * download leg APIM export uses.
 *
 * The product hardcodes public-cloud ARM endpoints (no endpoint-override input
 * exists, deliberately), so the transport seam is the runtime's own env
 * contracts instead: an HTTP CONNECT proxy (`HTTPS_PROXY` for @azure/identity
 * MSAL and the SDK pipeline, `NODE_USE_ENV_PROXY=1` for undici fetch paths)
 * terminating TLS with a run-scoped throwaway CA (`NODE_EXTRA_CA_CERTS`). The
 * SAS leg rides an Azure public IP literal with an IP SAN so the lane needs no
 * DNS at all. The proxy tunnels only the allowlisted hosts and refuses every
 * other CONNECT, so a passing run is proof of zero live Azure traffic.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export interface FixtureRequest {
  host: string;
  method: string;
  path: string;
  search: string;
  hadAuthorization: boolean;
}

export interface AzureFixture {
  /** `http://127.0.0.1:<port>` for HTTPS_PROXY / HTTP_PROXY. */
  proxyUrl: string;
  /** PEM path for NODE_EXTRA_CA_CERTS. */
  caPath: string;
  /** Hosts the proxy tunneled (allowlisted Azure hosts only). */
  connectedHosts: string[];
  /** CONNECT targets the proxy refused. */
  deniedHosts: string[];
  /** Every request served by the TLS fixture. */
  requests: FixtureRequest[];
  close(): Promise<void>;
}

export const FIXTURE_TENANT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
export const FIXTURE_CLIENT_ID = 'cccccccc-1111-2222-3333-444444444444';
export const FIXTURE_SUBSCRIPTION_ID = '11111111-2222-3333-4444-555555555555';
export const RESOURCE_GROUP = 'ws10-rg';
export const APIM_SERVICE = 'ws10-apim';
export const GOOD_API_ID = 'payments';
export const FLAKY_API_ID = 'ledger';
export const EVIL_API_ID = 'exfil';
/**
 * Azure-owned public unicast address used as the SAS host. An IP literal skips
 * DNS entirely (the spec fetcher pins IP literals directly), keeping the lane
 * hermetic with no resolver dependency; the leaf certificate carries it as an
 * IP SAN.
 */
export const SAS_HOST = '20.150.100.10';
/** Public unicast IP outside the proxy allowlist; CONNECT to it must be refused. */
export const EVIL_SAS_HOST = '52.0.0.1';

const APIM_BASE = `/subscriptions/${FIXTURE_SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.ApiManagement/service/${APIM_SERVICE}`;

export const GOOD_API_ARM_ID = `${APIM_BASE}/apis/${GOOD_API_ID}`;
export const FLAKY_API_ARM_ID = `${APIM_BASE}/apis/${FLAKY_API_ID}`;
export const EVIL_API_ARM_ID = `${APIM_BASE}/apis/${EVIL_API_ID}`;

const OPENAPI_JSON = JSON.stringify({
  openapi: '3.0.3',
  info: { title: 'WS10 Azure Emulator Petstore', version: '1.0.0' },
  paths: { '/pets': { get: { responses: { '200': { description: 'ok' } } } } }
});

const ALLOWED_HOSTS = new Set(['login.microsoftonline.com', 'management.azure.com', SAS_HOST]);

/** Throwaway CA + leaf covering both DNS hosts and the SAS IP, minted per run via openssl. */
function mintCertificates(dir: string): { caPath: string; serverKey: string; serverCert: string } {
  const caKey = path.join(dir, 'ca.key');
  const caPem = path.join(dir, 'ca.pem');
  const serverKey = path.join(dir, 'server.key');
  const serverCsr = path.join(dir, 'server.csr');
  const serverPem = path.join(dir, 'server.pem');
  const extFile = path.join(dir, 'san.cnf');
  writeFileSync(
    extFile,
    `subjectAltName=DNS:login.microsoftonline.com,DNS:management.azure.com,IP:${SAS_HOST}\n`
  );
  const openssl = (args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
  openssl(['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '2', '-nodes', '-keyout', caKey, '-out', caPem, '-subj', '/CN=ws10-azure-emulator-ca']);
  openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', serverKey, '-out', serverCsr, '-subj', '/CN=management.azure.com']);
  openssl(['x509', '-req', '-in', serverCsr, '-CA', caPem, '-CAkey', caKey, '-CAcreateserial', '-days', '2', '-sha256', '-extfile', extFile, '-out', serverPem]);
  return { caPath: caPem, serverKey, serverCert: serverPem };
}

function json(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function apiEnvelope(apiId: string, displayName: string): Record<string, unknown> {
  return {
    id: `${APIM_BASE}/apis/${apiId}`,
    name: apiId,
    properties: { displayName, path: apiId, apiType: 'http', isCurrent: true, apiRevision: '1' }
  };
}

export async function startAzureFixture(): Promise<AzureFixture> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ws10-azure-fixture-'));
  const { caPath, serverKey, serverCert } = mintCertificates(dir);
  const connectedHosts: string[] = [];
  const deniedHosts: string[] = [];
  const requests: FixtureRequest[] = [];
  /** Per-API export call counter driving the flaky SAS 403-then-fresh-link protocol. */
  const exportCalls = new Map<string, number>();

  const tls = https.createServer(
    { key: readFileSync(serverKey), cert: readFileSync(serverCert) },
    (req, res) => {
      const host = (req.headers.host ?? '').replace(/:443$/, '');
      const url = new URL(req.url ?? '/', `https://${host}`);
      requests.push({
        host,
        method: req.method ?? '',
        path: url.pathname,
        search: url.search,
        hadAuthorization: typeof req.headers.authorization === 'string'
      });

      if (host === 'login.microsoftonline.com') {
        if (url.pathname === '/common/discovery/instance') {
          json(res, 200, {
            tenant_discovery_endpoint: `https://login.microsoftonline.com/${FIXTURE_TENANT_ID}/v2.0/.well-known/openid-configuration`,
            'api-version': '1.1',
            metadata: [
              {
                preferred_network: 'login.microsoftonline.com',
                preferred_cache: 'login.microsoftonline.com',
                aliases: ['login.microsoftonline.com']
              }
            ]
          });
          return;
        }
        if (url.pathname.endsWith('/.well-known/openid-configuration')) {
          json(res, 200, {
            token_endpoint: `https://login.microsoftonline.com/${FIXTURE_TENANT_ID}/oauth2/v2.0/token`,
            authorization_endpoint: `https://login.microsoftonline.com/${FIXTURE_TENANT_ID}/oauth2/v2.0/authorize`,
            issuer: `https://login.microsoftonline.com/${FIXTURE_TENANT_ID}/v2.0`,
            jwks_uri: `https://login.microsoftonline.com/${FIXTURE_TENANT_ID}/discovery/v2.0/keys`
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === `/${FIXTURE_TENANT_ID}/oauth2/v2.0/token`) {
          json(res, 200, {
            token_type: 'Bearer',
            expires_in: 3600,
            ext_expires_in: 3600,
            access_token: 'ws10-azure-emulator-token'
          });
          return;
        }
      }

      if (host === 'management.azure.com') {
        if (url.pathname === `/subscriptions/${FIXTURE_SUBSCRIPTION_ID}`) {
          json(res, 200, {
            subscriptionId: FIXTURE_SUBSCRIPTION_ID,
            displayName: 'WS10 Emulator',
            state: 'Enabled'
          });
          return;
        }
        if (url.pathname === '/subscriptions') {
          json(res, 200, {
            value: [{ subscriptionId: FIXTURE_SUBSCRIPTION_ID, displayName: 'WS10 Emulator', state: 'Enabled' }]
          });
          return;
        }
        if (
          url.pathname === APIM_BASE ||
          url.pathname === `/subscriptions/${FIXTURE_SUBSCRIPTION_ID}/providers/Microsoft.ApiManagement/service`
        ) {
          json(res, 200, {
            value: [
              {
                id: APIM_BASE,
                name: APIM_SERVICE,
                location: 'eastus',
                tags: {},
                properties: { gatewayUrl: `https://${APIM_SERVICE}.azure-api.net` }
              }
            ]
          });
          return;
        }
        if (
          url.pathname === `${APIM_BASE}/gateways` ||
          url.pathname === `${APIM_BASE}/workspaceLinks` ||
          url.pathname === `${APIM_BASE}/workspaces`
        ) {
          json(res, 200, { value: [] });
          return;
        }
        const apiMatch = new RegExp(`^${APIM_BASE}/apis/([^/]+)$`).exec(url.pathname);
        if (apiMatch && url.searchParams.get('export') === 'true') {
          const apiId = apiMatch[1]!;
          const calls = (exportCalls.get(apiId) ?? 0) + 1;
          exportCalls.set(apiId, calls);
          // Two-step APIM export protocol: ARM returns a short-TTL Storage SAS
          // link; bytes are fetched from that link. The flaky API expires its
          // first SAS (403) so the client must discard it and re-export; the
          // evil API points its SAS at a host outside the proxy allowlist.
          const sasPath =
            apiId === EVIL_API_ID
              ? `https://${EVIL_SAS_HOST}/apim-export/${apiId}.json`
              : apiId === FLAKY_API_ID
                ? `https://${SAS_HOST}/apim-export/${apiId}-${calls}.json`
                : `https://${SAS_HOST}/apim-export/${apiId}.json`;
          json(res, 200, {
            id: `${APIM_BASE}/apis/${apiId}`,
            format: 'openapi-link',
            value: { link: `${sasPath}?sv=2022-11-02&sig=ws10sig&se=2026-08-02` }
          });
          return;
        }
        if (apiMatch) {
          const apiId = apiMatch[1]!;
          json(res, 200, apiEnvelope(apiId, apiId === GOOD_API_ID ? 'Payments' : apiId));
          return;
        }
        if (url.pathname === `${APIM_BASE}/apis`) {
          json(res, 200, {
            value: [
              apiEnvelope(GOOD_API_ID, 'Payments'),
              apiEnvelope(FLAKY_API_ID, 'Ledger'),
              apiEnvelope(EVIL_API_ID, 'Exfil')
            ]
          });
          return;
        }
        // Every other ARM surface (provider probes, Resource Graph) is
        // IAM-denied, matching a locked-down service principal.
        json(res, 403, {
          error: { code: 'AuthorizationFailed', message: `PERMISSION_DENIED (emulator default) for ${url.pathname}` }
        });
        return;
      }

      if (host === SAS_HOST) {
        const sasMatch = /^\/apim-export\/([^/]+)\.json$/.exec(url.pathname);
        if (sasMatch) {
          // First flaky SAS link is expired; only the re-exported link serves bytes.
          if (sasMatch[1] === `${FLAKY_API_ID}-1`) {
            json(res, 403, { error: { code: 'AuthenticationFailed', message: 'SAS expired (emulator)' } });
            return;
          }
          res.writeHead(200, {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(OPENAPI_JSON)
          });
          res.end(OPENAPI_JSON);
          return;
        }
      }

      json(res, 404, { error: { code: 'NotFound', message: `no fixture route for ${host}${url.pathname}` } });
    }
  );
  const openSockets = new Set<net.Socket>();
  const track = (socket: net.Socket) => {
    openSockets.add(socket);
    socket.on('close', () => openSockets.delete(socket));
  };
  tls.on('connection', track);
  await new Promise<void>((resolve) => tls.listen(0, '127.0.0.1', resolve));
  const tlsPort = (tls.address() as net.AddressInfo).port;

  const proxy = net.createServer((socket) => {
    socket.once('data', (chunk) => {
      const head = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const text = head.toString('latin1');
      const line = text.split('\r\n')[0] ?? '';
      const match = /^CONNECT ([^ :]+):(\d+) /.exec(line);
      if (!match || !ALLOWED_HOSTS.has(match[1]!)) {
        deniedHosts.push(match?.[1] ?? line);
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      connectedHosts.push(match[1]!);
      // Bytes past the CONNECT header (a TLS ClientHello often rides the same
      // packet) must reach the upstream or the handshake stalls forever.
      const headerEnd = text.indexOf('\r\n\r\n');
      const remainder = headerEnd >= 0 ? head.subarray(headerEnd + 4) : Buffer.alloc(0);
      const upstream = net.connect(tlsPort, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (remainder.length > 0) upstream.write(remainder);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      upstream.on('error', () => socket.destroy());
      socket.on('error', () => upstream.destroy());
    });
    socket.on('error', () => socket.destroy());
  });
  proxy.on('connection', track);
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const proxyPort = (proxy.address() as net.AddressInfo).port;

  return {
    proxyUrl: `http://127.0.0.1:${proxyPort}`,
    caPath,
    connectedHosts,
    deniedHosts,
    requests,
    close: async () => {
      // Keep-alive sockets would hold close() open past the hook timeout.
      for (const socket of openSockets) socket.destroy();
      await Promise.all([
        new Promise<void>((resolve) => proxy.close(() => resolve())),
        new Promise<void>((resolve) => tls.close(() => resolve()))
      ]);
    }
  };
}
