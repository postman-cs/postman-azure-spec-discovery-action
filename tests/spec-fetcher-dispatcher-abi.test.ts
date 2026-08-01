import { Agent } from 'undici';
import { describe, expect, it } from 'vitest';

// Regression: the fetcher pins DNS by handing undici a custom Agent as the request
// dispatcher. That Agent is built from this package's undici, while Node's global fetch is
// backed by Node's own bundled undici. A dispatcher cannot cross that boundary -- undici
// rejects the foreign handler with 'invalid onRequestStart method' before any socket is
// opened, so every remote fetch (APIM export SAS download, App Service apiDefinition,
// Functions OpenAPI, runtime-declared routes) failed at runtime while the mocked unit
// tests stayed green. Reproduced on Node 22, 24, and 25.
//
// The assertions below never depend on reaching the origin. They pin the failure *mode*:
// an argument rejection is the defect, and anything past it (TLS, refusal, timeout) means
// the dispatcher was accepted. 8.8.8.8 is used only because it is a routable public
// address that survives the fetcher's private-address guard; its certificate will not
// match, which is the expected post-handshake failure.

const HOST = 'specs.example.com';
const URL_ = `https://${HOST}/v1/openapi.yaml`;
const PUBLIC_ADDRESS = '8.8.8.8';
const ABI_REJECTION = 'invalid onRequestStart method';

function pinnedAgent(): Agent {
  return new Agent({
    connect: {
      servername: HOST,
      lookup(_hostname, options, callback) {
        if (options.all) callback(null, [{ address: PUBLIC_ADDRESS, family: 4 }]);
        else callback(null, PUBLIC_ADDRESS, 4);
      }
    },
    connectTimeout: 2000
  });
}

// The fetcher wraps failures, so the decisive error is nested several levels down.
// Flatten the whole chain or the assertion reads the wrong level and silently passes.
async function failureChain(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'RESOLVED';
  } catch (error) {
    const messages: string[] = [];
    let current: unknown = error;
    while (current instanceof Error && messages.length < 8) {
      messages.push(current.message);
      current = (current as { cause?: unknown }).cause;
    }
    return messages.join(' | ');
  }
}

describe('pinned dispatcher and fetch come from one undici instance', () => {
  it('is rejected by the global fetch, proving the boundary is real', async () => {
    const agent = pinnedAgent();
    try {
      const chain = await failureChain(() =>
        globalThis.fetch(URL_, { dispatcher: agent } as RequestInit)
      );
      expect(chain).toContain(ABI_REJECTION);
    } finally {
      await agent.close();
    }
  }, 30000);

  it("is accepted by this package's fetch", async () => {
    const { fetch: undiciFetch } = await import('undici');
    const agent = pinnedAgent();
    try {
      const chain = await failureChain(() => undiciFetch(URL_, { dispatcher: agent }));
      expect(chain).not.toContain(ABI_REJECTION);
    } finally {
      await agent.close();
    }
  }, 30000);

  it('defaults fetchSpecFromUrl to an implementation that accepts its own dispatcher', async () => {
    const { fetchSpecFromUrl } = await import('../src/lib/fetch/spec-fetcher.js');

    const chain = await failureChain(() => fetchSpecFromUrl(URL_, { timeoutMs: 5000 }));

    // Must fail on transport (DNS/TLS), never on handler validation.
    expect(chain).not.toContain(ABI_REJECTION);
  }, 30000);
});
