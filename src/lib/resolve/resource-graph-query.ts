/**
 * One Resource Graph query enumerates every candidate type for the selected
 * subscription (and optional exact resource group). The client re-issues the
 * same KQL with each returned $skipToken; narrowing tiers never add queries.
 */

/** Escape a value for embedding inside a single-quoted KQL string literal. */
export function escapeKqlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

const CANDIDATE_TYPES = [
  'microsoft.apimanagement/service/apis',
  'microsoft.apimanagement/service/workspaces/apis',
  'microsoft.web/sites'
];

export function buildCandidateQuery(resourceGroup?: string): string {
  const typeFilter = CANDIDATE_TYPES.map((type) => `'${type}'`).join(', ');
  const lines = [
    'Resources',
    `| where type in~ (${typeFilter})`
  ];
  const trimmedGroup = (resourceGroup ?? '').trim();
  if (trimmedGroup) {
    lines.push(`| where resourceGroup =~ '${escapeKqlString(trimmedGroup)}'`);
  }
  lines.push('| project id, name, type, resourceGroup, tags');
  return lines.join('\n');
}
