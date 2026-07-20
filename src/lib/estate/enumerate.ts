/**
 * Estate association enumerator (discover-estate mode).
 *
 * One Resource Graph query sweeps Resources and ResourceContainers for
 * repo-association tags and dedupes the hits into an org/repo roster. This is
 * an association-only seam: it never exports specs, never opens PRs, and never
 * writes anything outside the run's own output directory. It is deliberately
 * NOT a SpecProvider -- estate association has its own contract so the export
 * seam never grows enumeration semantics.
 *
 * Reader-boundary note: the query projects id, name, type, resourceGroup, and
 * tags only. Tag VALUES are repo coordinates by convention; anything that does
 * not parse as an org/repo association is dropped, so secret-shaped tag values
 * never reach the roster.
 */

import type { AzureResourceGraphClient, ResourceGraphRow } from '../azure/clients.js';
import { escapeKqlString } from '../resolve/resource-graph-query.js';

/** One deduped repo association across the whole estate. */
export interface EstateRepo {
  org: string;
  repo: string;
  /** Tag keys that produced this association, deduped, sorted. */
  tagSources: string[];
  /** Distinct ARM resource types that carried the association, sorted. */
  resourceTypes: string[];
  /** Full ARM IDs of the resources that carried the association, sorted. */
  resourceIds: string[];
}

/**
 * Association tag keys, checked case-insensitively against each row's tag bag.
 * postman:repo stays the only auto-select signal in resolve-one narrowing;
 * here every key is an equal-weight association hint because estate mode never
 * selects anything -- it only reports.
 */
const SLUG_TAG_KEYS = ['postman:repo', 'github:repository', 'repo', 'repository'];
const ORG_TAG_KEY = 'githuborg';
const REPO_TAG_KEY = 'githubrepo';

const KQL_TAG_KEYS = [
  'postman:repo',
  'github:repository',
  'repo',
  'repository',
  'Repo',
  'Repository',
  'GithubOrg',
  'GithubRepo',
  'githuborg',
  'githubrepo'
];

/**
 * One KQL statement over Resources + ResourceContainers where any known repo
 * tag is nonempty. The client re-issues the same query with each $skipToken;
 * this seam never adds queries per row.
 */
export function buildEstateQuery(resourceGroup?: string): string {
  const tagFilter = KQL_TAG_KEYS.map((key) => `isnotempty(tostring(tags['${key}']))`).join(' or ');
  const lines = ['Resources', '| union ResourceContainers'];
  const trimmedGroup = (resourceGroup ?? '').trim();
  if (trimmedGroup) {
    lines.push(`| where resourceGroup =~ '${escapeKqlString(trimmedGroup)}'`);
  }
  lines.push(`| where ${tagFilter}`, '| project id, name, type, resourceGroup, tags');
  return lines.join('\n');
}

/** Parse an org/repo pair out of a slug-form tag value; undefined when it is not one. */
export function parseRepoSlug(value: string): { org: string; repo: string } | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  // URL form: take the path, ignore credentials/query/fragment entirely.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return undefined;
    }
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length < 2) return undefined;
    const [org, repoRaw] = segments;
    return normalizePair(org ?? '', (repoRaw ?? '').replace(/\.git$/i, ''));
  }

  // git@host:org/repo.git form.
  const scpMatch = /^[^@\s]+@[^:\s]+:(.+)$/.exec(trimmed);
  const pathPart = scpMatch ? scpMatch[1] ?? '' : trimmed;
  const segments = pathPart.split('/').filter(Boolean);
  if (segments.length !== 2) return undefined;
  const [org, repoRaw] = segments;
  return normalizePair(org ?? '', (repoRaw ?? '').replace(/\.git$/i, ''));
}

const COORDINATE_PATTERN = /^[A-Za-z0-9._-]+$/;

function normalizePair(org: string, repo: string): { org: string; repo: string } | undefined {
  const cleanOrg = org.trim();
  const cleanRepo = repo.trim();
  if (!cleanOrg || !cleanRepo) return undefined;
  if (!COORDINATE_PATTERN.test(cleanOrg) || !COORDINATE_PATTERN.test(cleanRepo)) return undefined;
  return { org: cleanOrg, repo: cleanRepo };
}

interface Association {
  org: string;
  repo: string;
  tagSource: string;
}

/** Extract every association a single row's tag bag yields. */
export function associationsFromTags(tags: Record<string, string>): Association[] {
  const byKey = new Map<string, { key: string; value: string }>();
  for (const [key, value] of Object.entries(tags ?? {})) {
    if (typeof value !== 'string') continue;
    byKey.set(key.toLowerCase(), { key, value });
  }

  const found: Association[] = [];

  for (const slugKey of SLUG_TAG_KEYS) {
    const entry = byKey.get(slugKey);
    if (!entry) continue;
    const pair = parseRepoSlug(entry.value);
    if (pair) {
      found.push({ ...pair, tagSource: entry.key });
    }
  }

  const orgEntry = byKey.get(ORG_TAG_KEY);
  const repoEntry = byKey.get(REPO_TAG_KEY);
  if (orgEntry && repoEntry) {
    const pair = normalizePair(orgEntry.value, repoEntry.value);
    if (pair) {
      found.push({ ...pair, tagSource: `${orgEntry.key}+${repoEntry.key}` });
    }
  }

  return found;
}

/** Dedupe row-level associations into a sorted org/repo roster. */
export function dedupeEstate(rows: ResourceGraphRow[]): EstateRepo[] {
  const roster = new Map<string, { org: string; repo: string; tagSources: Set<string>; resourceTypes: Set<string>; resourceIds: Set<string> }>();

  for (const row of rows) {
    for (const association of associationsFromTags(row.tags)) {
      const key = `${association.org.toLowerCase()}/${association.repo.toLowerCase()}`;
      let entry = roster.get(key);
      if (!entry) {
        entry = {
          org: association.org,
          repo: association.repo,
          tagSources: new Set(),
          resourceTypes: new Set(),
          resourceIds: new Set()
        };
        roster.set(key, entry);
      }
      entry.tagSources.add(association.tagSource);
      if (row.type) entry.resourceTypes.add(row.type.toLowerCase());
      if (row.id) entry.resourceIds.add(row.id);
    }
  }

  return [...roster.values()]
    .map((entry) => ({
      org: entry.org,
      repo: entry.repo,
      tagSources: [...entry.tagSources].sort(),
      resourceTypes: [...entry.resourceTypes].sort(),
      resourceIds: [...entry.resourceIds].sort()
    }))
    .sort((a, b) => `${a.org}/${a.repo}`.localeCompare(`${b.org}/${b.repo}`));
}

/**
 * Run the estate sweep with one multi-scope ARG request when possible. If ARG
 * rejects that aggregate request, retry each explicit scope so a visibility
 * failure in one subscription cannot discard associations visible in another.
 * If every fallback scope fails, preserve the failure rather than reporting an
 * empty roster as though it were an absence result.
 */
export async function enumerateEstate(
  client: AzureResourceGraphClient,
  subscriptionIds: string | readonly string[],
  resourceGroup?: string
): Promise<EstateRepo[]> {
  const scopes = Array.isArray(subscriptionIds) ? [...subscriptionIds] : [subscriptionIds];
  const query = buildEstateQuery(resourceGroup);
  let rows: ResourceGraphRow[];
  try {
    rows = await client.queryResources(subscriptionIds, query);
  } catch (error) {
    if (scopes.length <= 1) throw error;
    const settled = await Promise.allSettled(scopes.map((scope) => client.queryResources(scope, query)));
    const successful = settled.filter(
      (result): result is PromiseFulfilledResult<ResourceGraphRow[]> => result.status === 'fulfilled'
    );
    if (successful.length === 0) throw error;
    rows = successful.flatMap((result) => result.value);
  }
  return dedupeEstate(rows);
}
