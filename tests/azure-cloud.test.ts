import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  resolveAzureCloudProfile,
  AZURE_CLOUD_PROFILES
} from '../src/lib/azure/cloud.js';
import {
  computeBoundedRetryDelayMs,
  parseRetryAfterMs
} from '../src/lib/retry.js';

describe('Azure cloud profiles', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('AZ-CLOUD-001: defaults to Azure Public when no environment is set', () => {
    const profile = resolveAzureCloudProfile({});
    expect(profile.name).toBe('AzureCloud');
    expect(profile.managementEndpoint).toBe('https://management.azure.com');
    expect(profile.armTokenScope).toBe('https://management.azure.com/.default');
    expect(profile.authorityHost).toBe('https://login.microsoftonline.com');
  });

  it.each([
    ['AzureCloud', 'https://management.azure.com', 'https://login.microsoftonline.com'],
    ['AzurePublicCloud', 'https://management.azure.com', 'https://login.microsoftonline.com'],
    ['AzureUSGovernment', 'https://management.usgovcloudapi.net', 'https://login.microsoftonline.us'],
    ['AzureGovernment', 'https://management.usgovcloudapi.net', 'https://login.microsoftonline.us'],
    ['AzureChinaCloud', 'https://management.chinacloudapi.cn', 'https://login.chinacloudapi.cn'],
    ['AzureChina', 'https://management.chinacloudapi.cn', 'https://login.chinacloudapi.cn']
  ] as const)('AZ-CLOUD-002: AZURE_ENVIRONMENT=%s resolves the sovereign profile', (alias, management, authority) => {
    const profile = resolveAzureCloudProfile({ AZURE_ENVIRONMENT: alias });
    expect(profile.managementEndpoint).toBe(management);
    expect(profile.armTokenScope).toBe(`${management}/.default`);
    expect(profile.authorityHost).toBe(authority);
  });

  it.each([
    ['https://login.microsoftonline.com', 'AzureCloud', 'https://management.azure.com'],
    ['https://login.microsoftonline.us/', 'AzureUSGovernment', 'https://management.usgovcloudapi.net'],
    ['https://login.chinacloudapi.cn', 'AzureChinaCloud', 'https://management.chinacloudapi.cn']
  ] as const)('AZ-CLOUD-003: AZURE_AUTHORITY_HOST=%s selects the matching cloud', (host, name, management) => {
    const profile = resolveAzureCloudProfile({ AZURE_AUTHORITY_HOST: host });
    expect(profile.name).toBe(name);
    expect(profile.managementEndpoint).toBe(management);
  });

  it('AZ-CLOUD-004: unsupported AZURE_ENVIRONMENT fails closed', () => {
    expect(() => resolveAzureCloudProfile({ AZURE_ENVIRONMENT: 'AzureGermanCloud' })).toThrow(
      /unsupported Azure environment/i
    );
    expect(() => resolveAzureCloudProfile({ AZURE_ENVIRONMENT: 'not-a-cloud' })).toThrow(
      /unsupported Azure environment/i
    );
  });

  it('AZ-CLOUD-004b: unsupported AZURE_AUTHORITY_HOST fails closed', () => {
    expect(() =>
      resolveAzureCloudProfile({ AZURE_AUTHORITY_HOST: 'https://login.microsoftonline.de' })
    ).toThrow(/unsupported Azure authority host/i);
  });

  it('AZ-CLOUD-005: conflicting AZURE_ENVIRONMENT and AZURE_AUTHORITY_HOST fail closed', () => {
    expect(() =>
      resolveAzureCloudProfile({
        AZURE_ENVIRONMENT: 'AzureUSGovernment',
        AZURE_AUTHORITY_HOST: 'https://login.microsoftonline.com'
      })
    ).toThrow(/conflict/i);
  });

  it('AZ-CLOUD-006: profile table exposes exactly Public, US Government, and China', () => {
    expect(Object.keys(AZURE_CLOUD_PROFILES).sort()).toEqual(
      ['AzureChinaCloud', 'AzureCloud', 'AzureUSGovernment'].sort()
    );
  });
});

describe('bounded Retry-After and full jitter', () => {
  it('AZ-RETRY-001: parseRetryAfterMs accepts delta-seconds and HTTP-date', () => {
    expect(parseRetryAfterMs('2')).toBe(2000);
    const future = new Date(Date.UTC(2030, 0, 1, 0, 0, 5)).toUTCString();
    const now = Date.UTC(2030, 0, 1, 0, 0, 0);
    expect(parseRetryAfterMs(future, now)).toBe(5000);
    expect(parseRetryAfterMs('not-a-delay')).toBeUndefined();
    expect(parseRetryAfterMs(null)).toBeUndefined();
  });

  it('AZ-RETRY-002: Retry-After is preferred and capped', () => {
    expect(
      computeBoundedRetryDelayMs({
        attempt: 1,
        retryAfterHeader: '120',
        maxDelayMs: 8000,
        random: () => 1
      })
    ).toBe(8000);
  });

  it('AZ-RETRY-003: full jitter is deterministic with injectable random', () => {
    const delay = computeBoundedRetryDelayMs({
      attempt: 3,
      baseDelayMs: 500,
      maxDelayMs: 8000,
      random: () => 0.5
    });
    // ceiling = min(8000, 500 * 2^2) = 2000; 0.5 * 2000 = 1000
    expect(delay).toBe(1000);
  });

  it('AZ-RETRY-004: past Retry-After date clamps to zero', () => {
    const past = new Date(Date.UTC(2020, 0, 1)).toUTCString();
    expect(parseRetryAfterMs(past, Date.UTC(2026, 0, 1))).toBe(0);
    expect(
      computeBoundedRetryDelayMs({
        attempt: 1,
        retryAfterHeader: past,
        nowMs: Date.UTC(2026, 0, 1),
        random: () => 1
      })
    ).toBe(0);
  });
});
