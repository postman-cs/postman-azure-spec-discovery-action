import { describe, expect, it, vi } from 'vitest';

import { resolveSubscriptionId } from '../src/runtime.js';
import type { AzureSubscriptionsClient } from '../src/lib/azure/clients.js';

function clientWith(subscriptions: Array<{ subscriptionId: string; state?: string }>): AzureSubscriptionsClient & {
  listCalls: () => number;
  getCalls: () => number;
} {
  const list = vi.fn(async () => subscriptions);
  const get = vi.fn(async (subscriptionId: string) => ({ subscriptionId, state: 'Enabled' }));
  return {
    get,
    list,
    listCalls: () => list.mock.calls.length,
    getCalls: () => get.mock.calls.length
  };
}

describe('subscription resolution', () => {
  it('AZ-CONTRACT-003: one enabled subscription is selected; zero and multiple reject with exact messages', async () => {
    const single = clientWith([{ subscriptionId: 'aaaaaaaa-0000-0000-0000-000000000001', state: 'Enabled' }]);
    await expect(resolveSubscriptionId(undefined, single)).resolves.toBe('aaaaaaaa-0000-0000-0000-000000000001');

    const none = clientWith([]);
    await expect(resolveSubscriptionId(undefined, none)).rejects.toThrow(
      'No enabled Azure subscriptions were found; pass --subscription-id after authenticating.'
    );
    // Absence is scoped to what the credential can see — never a global Azure claim.
    await expect(resolveSubscriptionId(undefined, none)).rejects.toSatisfy((error: Error) => {
      expect(error.message.toLowerCase()).not.toMatch(/no azure subscriptions exist|across azure|in azure globally/);
      return true;
    });

    const multiple = clientWith([
      { subscriptionId: 'aaaaaaaa-0000-0000-0000-000000000001', state: 'Enabled' },
      { subscriptionId: 'aaaaaaaa-0000-0000-0000-000000000002', state: 'Enabled' }
    ]);
    await expect(resolveSubscriptionId(undefined, multiple)).rejects.toThrow(
      'Multiple enabled Azure subscriptions were found; pass --subscription-id explicitly.'
    );
  });

  it('AZ-CONTRACT-003b: explicit subscription id is validated with get without listing', async () => {
    const client = clientWith([{ subscriptionId: 'ignored', state: 'Enabled' }]);
    await expect(resolveSubscriptionId('bbbbbbbb-0000-0000-0000-000000000009', client)).resolves.toBe(
      'bbbbbbbb-0000-0000-0000-000000000009'
    );
    expect(client.listCalls()).toBe(0);
    expect(client.getCalls()).toBe(1);
  });

  it('AZ-CONTRACT-003c: error messages never contain subscription ids or display names', async () => {
    const multiple = clientWith([
      { subscriptionId: 'aaaaaaaa-1111-2222-3333-444444444444', state: 'Enabled' },
      { subscriptionId: 'bbbbbbbb-5555-6666-7777-888888888888', state: 'Enabled' }
    ]);
    await expect(resolveSubscriptionId(undefined, multiple)).rejects.toSatisfy((error: Error) => {
      expect(error.message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
      return true;
    });
  });
});
