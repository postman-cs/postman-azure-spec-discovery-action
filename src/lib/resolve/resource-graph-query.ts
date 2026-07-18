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
  'microsoft.web/sites',
  'microsoft.web/customapis',
  'microsoft.logic/workflows',
  'microsoft.resources/templatespecs/versions',
  'microsoft.eventgrid/topics',
  'microsoft.eventgrid/domains',
  'microsoft.eventgrid/systemtopics'
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
  lines.push(
    '| extend apiType=tostring(properties.apiType), isCurrent=tobool(properties.isCurrent), apiRevision=tostring(properties.apiRevision), apiVersionSetId=tostring(properties.apiVersionSetId), apiDefinitionUrl=tostring(properties.siteConfig.apiDefinition.url)',
    '| project id, name, type, resourceGroup, tags, apiType, isCurrent, apiRevision, apiVersionSetId, apiDefinitionUrl'
  );
  return lines.join('\n');
}
