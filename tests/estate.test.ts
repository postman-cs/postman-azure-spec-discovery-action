import { describe, expect, it, vi } from 'vitest';

import type { AzureResourceGraphClient, ResourceGraphRow } from '../src/lib/azure/clients.js';
import {
  associationsFromTags,
  buildEstateQuery,
  dedupeEstate,
  enumerateEstate,
  parseRepoSlug
} from '../src/lib/estate/enumerate.js';
import { buildExecutionOutputs, execute, resolveInputs } from '../src/runtime.js';

function row(overrides: Partial<ResourceGraphRow> = {}): ResourceGraphRow {
  return {
    id: '/subscriptions/s/resourceGroups/rg-a/providers/Microsoft.ApiManagement/service/svc',
    name: 'svc',
    type: 'microsoft.apimanagement/service',
    resourceGroup: 'rg-a',
    tags: { 'postman:repo': 'acme/payments' },
    ...overrides
  };
}

describe('estate query', () => {
  it('AZ-EST-001: sweeps Resources and ResourceContainers for every association tag key', () => {
    const kql = buildEstateQuery();
    expect(kql).toContain('Resources');
    expect(kql).toContain('| union ResourceContainers');
    for (const key of ['postman:repo', 'github:repository', 'GithubOrg', 'GithubRepo', 'repo', 'repository']) {
      expect(kql).toContain(`tags['${key}']`);
    }
    expect(kql).toContain('| project id, name, type, resourceGroup, tags');
    expect(kql).not.toContain('properties');
  });

  it('AZ-EST-002: optional resource group scoping escapes KQL string literals', () => {
    expect(buildEstateQuery("rg-o'brien")).toContain("resourceGroup =~ 'rg-o\\'brien'");
    expect(buildEstateQuery('  ')).not.toContain('resourceGroup =~');
  });
});

describe('repo slug parsing', () => {
  it('AZ-EST-003: accepts org/repo, URL, git@ SCP, and .git forms', () => {
    expect(parseRepoSlug('acme/payments')).toEqual({ org: 'acme', repo: 'payments' });
    expect(parseRepoSlug('https://github.com/acme/payments')).toEqual({ org: 'acme', repo: 'payments' });
    expect(parseRepoSlug('https://github.com/acme/payments.git')).toEqual({ org: 'acme', repo: 'payments' });
    expect(parseRepoSlug('git@github.com:acme/payments.git')).toEqual({ org: 'acme', repo: 'payments' });
  });

  it('AZ-EST-004: rejects non-association values so secret-shaped tags never reach the roster', () => {
    expect(parseRepoSlug('')).toBeUndefined();
    expect(parseRepoSlug('just-a-service-name')).toBeUndefined();
    expect(parseRepoSlug('a/b/c')).toBeUndefined();
    expect(parseRepoSlug('Endpoint=sb://ns.servicebus.windows.net/;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=abc123')).toBeUndefined();
    expect(parseRepoSlug('https://github.com/acme')).toBeUndefined();
  });

  it('AZ-EST-005: drops credentials and query strings from URL-form values', () => {
    const parsed = parseRepoSlug('https://token@github.com/acme/payments?ref=main#readme');
    expect(parsed).toEqual({ org: 'acme', repo: 'payments' });
    expect(JSON.stringify(parsed)).not.toContain('token');
    expect(JSON.stringify(parsed)).not.toContain('ref=');
  });
});

describe('association extraction', () => {
  it('AZ-EST-006: reads slug keys case-insensitively and pairs GithubOrg+GithubRepo', () => {
    expect(associationsFromTags({ 'Postman:Repo': 'acme/payments' })).toEqual([
      { org: 'acme', repo: 'payments', tagSource: 'Postman:Repo' }
    ]);
    expect(associationsFromTags({ GithubOrg: 'acme', GithubRepo: 'billing' })).toEqual([
      { org: 'acme', repo: 'billing', tagSource: 'GithubOrg+GithubRepo' }
    ]);
    expect(associationsFromTags({ GithubOrg: 'acme' })).toEqual([]);
  });

  it('AZ-EST-007: one row can yield several associations from distinct tag keys', () => {
    const found = associationsFromTags({ 'postman:repo': 'acme/payments', repository: 'acme/billing' });
    expect(found).toHaveLength(2);
  });
});

describe('estate dedupe', () => {
  it('AZ-EST-008: collapses per-environment duplicates into one org/repo entry', () => {
    const rows = [
      row({ id: '/x/dev', tags: { 'postman:repo': 'acme/payments' } }),
      row({ id: '/x/prod', tags: { GithubOrg: 'ACME', GithubRepo: 'payments' } }),
      row({ id: '/x/other', type: 'microsoft.web/sites', tags: { repo: 'acme/billing' } })
    ];
    const estate = dedupeEstate(rows);
    expect(estate.map((entry) => `${entry.org}/${entry.repo}`)).toEqual(['acme/billing', 'acme/payments']);
    const payments = estate.find((entry) => entry.repo === 'payments');
    expect(payments?.resourceIds).toEqual(['/x/dev', '/x/prod']);
    expect(payments?.tagSources).toEqual(['GithubOrg+GithubRepo', 'postman:repo']);
  });

  it('AZ-EST-009: rows without parseable associations are ignored on purpose', () => {
    expect(dedupeEstate([row({ tags: { team: 'identity' } }), row({ tags: {} })])).toEqual([]);
  });
});

describe('enumerateEstate', () => {
  it('AZ-EST-010: issues exactly one ARG query and returns the deduped roster', async () => {
    const calls: Array<[string, string]> = [];
    const client: AzureResourceGraphClient = {
      queryResources: async (subscriptionId, kql) => {
        calls.push([subscriptionId, kql]);
        return [row()];
      }
    };
    const estate = await enumerateEstate(client, 'sub-1', 'rg-a');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe('sub-1');
    expect(calls[0]?.[1]).toContain('ResourceContainers');
    expect(estate).toEqual([
      {
        org: 'acme',
        repo: 'payments',
        tagSources: ['postman:repo'],
        resourceTypes: ['microsoft.apimanagement/service'],
        resourceIds: ['/subscriptions/s/resourceGroups/rg-a/providers/Microsoft.ApiManagement/service/svc']
      }
    ]);
  });
});

describe('discover-estate mode', () => {
  function estateDependencies(rows: ResourceGraphRow[], writes: Array<{ path: string; content: string }>) {
    return {
      core: {
        info: vi.fn(),
        warning: vi.fn(),
        group: async <T>(_name: string, fn: () => Promise<T>): Promise<T> => fn()
      },
      subscriptions: {
        list: vi.fn(async () => [{ subscriptionId: 'sub-1', state: 'Enabled' }])
      },
      createApimClient: vi.fn(),
      createAppServiceClient: vi.fn(),
      createResourceGraphClient: () => ({ queryResources: vi.fn(async () => rows) }),
      writeSpecFile: async (outputPath: string, content: string) => {
        writes.push({ path: outputPath, content });
      }
    };
  }

  it('AZ-EST-011: execute writes repos.json and emits association-only outputs', async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const inputs = resolveInputs({ GITHUB_WORKSPACE: '/tmp/estate-repo', INPUT_MODE: 'discover-estate' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await execute(inputs, estateDependencies([row()], writes) as any);

    expect(result.mode).toBe('discover-estate');
    expect(result.estate).toHaveLength(1);
    expect(result.discovered).toEqual([]);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path.endsWith('discovered-specs/repos.json')).toBe(true);
    const written = JSON.parse(writes[0]?.content ?? '[]') as unknown[];
    expect(written).toHaveLength(1);

    expect(result.outputs['source-type']).toBe('discover-estate');
    expect(result.outputs['repo-count']).toBe('1');
    expect(JSON.parse(result.outputs['repos-json'] ?? '[]')).toHaveLength(1);
    expect(result.outputs['services-json']).toBe('[]');
    expect(result.outputs['spec-path']).toBe('');
  });

  it('AZ-EST-012: dry-run skips the repos.json write but still reports the roster', async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const inputs = resolveInputs({ GITHUB_WORKSPACE: '/tmp/estate-repo', INPUT_MODE: 'discover-estate', INPUT_DRY_RUN: 'true' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await execute(inputs, estateDependencies([row()], writes) as any);
    expect(writes).toHaveLength(0);
    expect(result.outputs['repo-count']).toBe('1');
  });

  it('AZ-EST-013: buildExecutionOutputs keeps repos keys empty outside estate mode', () => {
    const many = buildExecutionOutputs({ mode: 'discover-many', discovered: [] });
    expect(many['repos-json']).toBe('');
    expect(many['repo-count']).toBe('');
    const one = buildExecutionOutputs({ mode: 'resolve-one', discovered: [] });
    expect(one['repos-json']).toBe('');
    expect(one['repo-count']).toBe('');
  });
});
