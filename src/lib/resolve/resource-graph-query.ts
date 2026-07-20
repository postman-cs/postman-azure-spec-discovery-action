/**
 * One Resource Graph query enumerates every candidate type for the selected
 * subscription (and optional exact resource group). The client re-issues the
 * same KQL with each returned $skipToken; narrowing tiers never add queries.
 */

import { registeredResourceGraphTypes } from '../providers/registry.js';

/** Escape a value for embedding inside a single-quoted KQL string literal. */
export function escapeKqlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export function buildCandidateQuery(resourceGroup?: string): string {
  const typeFilter = registeredResourceGraphTypes().map((type) => `'${type}'`).join(', ');
  const lines = [
    'Resources',
    `| where type in~ (${typeFilter})`
  ];
  const trimmedGroup = (resourceGroup ?? '').trim();
  if (trimmedGroup) {
    lines.push(`| where resourceGroup =~ '${escapeKqlString(trimmedGroup)}'`);
  }
  lines.push(
    '| extend apiType=tostring(properties.apiType), isCurrent=tobool(properties.isCurrent), apiRevision=tostring(properties.apiRevision), apiVersionSetId=tostring(properties.apiVersionSetId), apiDefinitionUrl=tostring(properties.siteConfig.apiDefinition.url)',
    '| project id, name, type, resourceGroup, tags, apiType, isCurrent, apiRevision, apiVersionSetId, apiDefinitionUrl'
  );
  return lines.join('\n');
}

/**
 * Case variants of a tag key as they commonly appear in ARM tag bags. KQL bag
 * lookups are key-case-sensitive, so the query enumerates the usual casings
 * while value comparison stays case-insensitive via =~.
 */
function tagKeyCaseVariants(key: string): string[] {
  const lower = key.toLowerCase();
  const upperFirst = lower.charAt(0).toUpperCase() + lower.slice(1);
  const pascalized = lower
    .split(/[:_-]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  return [...new Set([key, lower, upperFirst, pascalized])];
}

/** Fox pair tag-key casings mirrored from estate enumeration's KQL key list. */
const FOX_ORG_KEY_VARIANTS = ['GithubOrg', 'githuborg', 'Githuborg', 'GitHubOrg'];
const FOX_REPO_KEY_VARIANTS = ['GithubRepo', 'githubrepo', 'Githubrepo', 'GitHubRepo'];

/**
 * Targeted tag-association lookup for the narrowing tag-prefilter fallback.
 * Matches resources whose select-grade repo tag equals the repo slug
 * (canonical postman:repo plus any caller-supplied keys), or whose Fox-style
 * GithubOrg/GithubRepo pair composes to the slug. Values compare
 * case-insensitively; a trailing .git on the tag value is tolerated.
 */
export function buildRepoTagLookupQuery(repoSlug: string, repoTagKeys: string[] = [], resourceGroup?: string): string {
  const slug = repoSlug.trim().replace(/\.git$/i, '');
  const slugEscaped = escapeKqlString(slug);
  const clauses: string[] = [];
  for (const key of ['postman:repo', ...repoTagKeys]) {
    for (const variant of tagKeyCaseVariants(key)) {
      clauses.push(`tostring(tags['${escapeKqlString(variant)}']) =~ '${slugEscaped}'`);
      clauses.push(`tostring(tags['${escapeKqlString(variant)}']) =~ '${slugEscaped}.git'`);
    }
  }
  const [org, ...repoParts] = slug.split('/');
  const repoName = repoParts.join('/');
  if (org && repoName) {
    const orgEscaped = escapeKqlString(org);
    const repoEscaped = escapeKqlString(repoName);
    for (const orgVariant of FOX_ORG_KEY_VARIANTS) {
      for (const repoVariant of FOX_REPO_KEY_VARIANTS) {
        clauses.push(
          `(tostring(tags['${orgVariant}']) =~ '${orgEscaped}' and tostring(tags['${repoVariant}']) =~ '${repoEscaped}')`
        );
      }
    }
  }
  const lines = ['Resources', `| where ${clauses.join(' or ')}`];
  const trimmedGroup = (resourceGroup ?? '').trim();
  if (trimmedGroup) {
    lines.push(`| where resourceGroup =~ '${escapeKqlString(trimmedGroup)}'`);
  }
  lines.push('| project id, name, type, resourceGroup, tags');
  return lines.join('\n');
}
