import { describe, expect, it } from 'vitest';

import { formatUserSafeError, sanitizeJsonValue, sanitizeLogMessage } from '../src/lib/logging/sanitize.js';

const TENANT_UUID = 'aaaaaaaa-1111-2222-3333-444444444444';
const SUBSCRIPTION_UUID = 'bbbbbbbb-5555-6666-7777-888888888888';
const ARM_ID = `/subscriptions/${SUBSCRIPTION_UUID}/resourceGroups/payments-rg/providers/Microsoft.ApiManagement/service/svc/apis/payments`;
const BEARER = 'Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature';
const SAS_URL = 'https://apimexport.blob.core.windows.net/exports/payments.json?sv=2024-01-01&sig=SECRETSIGVALUE123&se=2026-01-01';

describe('azure log sanitization', () => {
  it('AZ-CLIENT-005: redacts tenant/subscription UUIDs, ARM IDs, bearer tokens, and SAS queries', () => {
    const message = [
      `tenant ${TENANT_UUID} rejected request`,
      `resource ${ARM_ID} not found`,
      `auth header ${BEARER}`,
      `download ${SAS_URL}`
    ].join('; ');

    const sanitized = sanitizeLogMessage(message);

    expect(sanitized).not.toContain(TENANT_UUID);
    expect(sanitized).not.toContain(SUBSCRIPTION_UUID);
    expect(sanitized).not.toContain('eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(sanitized).not.toContain('SECRETSIGVALUE123');
    expect(sanitized).not.toContain('sig=');
    expect(sanitized).toContain('[redacted-azure-id]');
    // Query-free HTTPS origin/path survives so operators can identify the endpoint.
    expect(sanitized).toContain('https://apimexport.blob.core.windows.net/exports/payments.json');
  });

  it('AZ-CLIENT-005: sanitizeJsonValue reaches nested string leaves', () => {
    const value = sanitizeJsonValue({
      evidence: [`selected ${ARM_ID}`],
      nested: { link: SAS_URL }
    });
    expect(JSON.stringify(value)).not.toContain(SUBSCRIPTION_UUID);
    expect(JSON.stringify(value)).not.toContain('SECRETSIGVALUE123');
  });

  it('AZ-CLIENT-005: formatUserSafeError sanitizes unless step debug is enabled', () => {
    const error = new Error(`export failed for ${ARM_ID}`);
    expect(formatUserSafeError(error, {})).not.toContain(SUBSCRIPTION_UUID);
    expect(formatUserSafeError(error, { ACTIONS_STEP_DEBUG: 'true' })).toContain(SUBSCRIPTION_UUID);
  });
});
