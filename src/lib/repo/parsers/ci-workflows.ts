import { parse } from 'yaml';

import type { AzureResourceBinding } from '../discovery-types.js';
import {
  isFullApiCenterDefinitionId,
  isFullApimApiId,
  parseApiCenterDefinitionArmId,
  parseApimApiArmId,
  resolveStaticIndirection
} from '../arm-ids.js';
import { isSecretKey, isSecretValue, sanitizeEvidenceValue } from '../secret-hygiene.js';

/** Deterministic ceilings for recursive CI workflow object walks. */
export const CI_WALK_MAX_DEPTH = 32;
export const CI_WALK_MAX_NODES = 4000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

interface WalkBudget {
  nodes: number;
  seen: WeakSet<object>;
  truncated: boolean;
}

function createWalkBudget(): WalkBudget {
  return { nodes: 0, seen: new WeakSet<object>(), truncated: false };
}

function enterWalkNode(value: object, budget: WalkBudget, depth: number): boolean {
  if (budget.truncated || depth > CI_WALK_MAX_DEPTH) {
    budget.truncated = true;
    return false;
  }
  if (budget.seen.has(value)) {
    budget.truncated = true;
    return false;
  }
  budget.seen.add(value);
  budget.nodes += 1;
  if (budget.nodes > CI_WALK_MAX_NODES) {
    budget.truncated = true;
    return false;
  }
  return true;
}

function flattenEnv(value: unknown, into: Record<string, string>, budget = createWalkBudget(), depth = 0): void {
  if (!isRecord(value)) return;
  if (!enterWalkNode(value, budget, depth)) return;
  for (const [key, child] of Object.entries(value)) {
    if (isSecretKey(key)) continue;
    const text = asString(child);
    if (!text || isSecretValue(text)) continue;
    if (/\$\{\{\s*secrets\./i.test(text) || /\$\([^)]*[Ss]ecret[^)]*\)/.test(text)) continue;
    into[key] = text;
    into[key.toUpperCase()] = text;
  }
}

function walkSteps(
  node: unknown,
  visit: (step: Record<string, unknown>) => void,
  budget = createWalkBudget(),
  depth = 0
): void {
  if (budget.truncated) return;
  if (Array.isArray(node)) {
    if (!enterWalkNode(node, budget, depth)) return;
    for (const entry of node) walkSteps(entry, visit, budget, depth + 1);
    return;
  }
  if (!isRecord(node)) return;
  if (!enterWalkNode(node, budget, depth)) return;
  if (node.uses !== undefined || node.task !== undefined || node.script !== undefined || node.run !== undefined) {
    visit(node);
  }
  for (const child of Object.values(node)) {
    if (child && typeof child === 'object') walkSteps(child, visit, budget, depth + 1);
  }
}

function collectStringLeaves(
  value: unknown,
  into: string[],
  budget = createWalkBudget(),
  depth = 0
): void {
  if (budget.truncated) return;
  if (typeof value === 'string') {
    into.push(value);
    return;
  }
  if (Array.isArray(value)) {
    if (!enterWalkNode(value, budget, depth)) return;
    for (const entry of value) collectStringLeaves(entry, into, budget, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  if (!enterWalkNode(value, budget, depth)) return;
  for (const [key, child] of Object.entries(value)) {
    if (isSecretKey(key)) continue;
    collectStringLeaves(child, into, budget, depth + 1);
  }
}

function bindingFromResolved(
  relativePath: string,
  family: AzureResourceBinding['family'],
  resolved: string,
  field?: string
): AzureResourceBinding | undefined {
  if (!resolved || isSecretValue(resolved)) return undefined;
  if (/\$\{\{\s*secrets\./i.test(resolved) || /\$\([^)]*[Ss]ecret[^)]*\)/.test(resolved)) return undefined;

  const apim = parseApimApiArmId(resolved);
  if (apim && isFullApimApiId(resolved)) {
    return {
      class: 'exact-binding',
      family,
      apimApiId: apim.fullId,
      subscriptionId: apim.subscriptionId,
      resourceGroup: apim.resourceGroup,
      serviceName: apim.serviceName,
      apiRevision: apim.revision,
      evidence: [{ sourceFile: relativePath, field, note: 'exact APIM API ARM ID in CI workflow' }]
    };
  }
  const center = parseApiCenterDefinitionArmId(resolved);
  if (center && isFullApiCenterDefinitionId(resolved)) {
    return {
      class: 'exact-binding',
      family,
      apiCenterDefinitionId: center.fullId,
      subscriptionId: center.subscriptionId,
      resourceGroup: center.resourceGroup,
      serviceName: center.serviceName,
      apiVersion: center.version,
      evidence: [{ sourceFile: relativePath, field, note: 'exact API Center definition ARM ID in CI workflow' }]
    };
  }
  if (/\.(?:ya?ml|json|wsdl|wadl|xsd|graphql|gql|proto)$/i.test(resolved) || /openapi|swagger|asyncapi/i.test(resolved)) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(resolved)) {
      return {
        class: 'association-only',
        family,
        nativeSpecUrl: resolved,
        evidence: [{ sourceFile: relativePath, field, note: 'CI workflow spec URL evidence only (not fetched)' }]
      };
    }
    return {
      class: 'association-only',
      family,
      nativeSpecPath: resolved,
      evidence: [
        {
          sourceFile: relativePath,
          field,
          note: `CI workflow local spec path ${sanitizeEvidenceValue(resolved)}`
        }
      ]
    };
  }
  return undefined;
}

function parseCiDocument(
  relativePath: string,
  content: string,
  family: 'github-actions' | 'azure-devops',
  variables: Record<string, string>
): AzureResourceBinding[] {
  let parsed: unknown;
  try {
    parsed = parse(content);
  } catch {
    return [];
  }
  if (!isRecord(parsed)) return [];

  const localVars = { ...variables };
  flattenEnv(parsed.env, localVars);
  flattenEnv(parsed.variables, localVars);
  if (Array.isArray(parsed.variables)) {
    for (const entry of parsed.variables) {
      if (!isRecord(entry)) continue;
      const name = asString(entry.name);
      const value = asString(entry.value);
      if (!name || !value || isSecretKey(name) || isSecretValue(value)) continue;
      localVars[name] = value;
      localVars[name.toUpperCase()] = value;
    }
  }
  if (isRecord(parsed.jobs)) {
    for (const job of Object.values(parsed.jobs)) {
      if (isRecord(job)) flattenEnv(job.env, localVars);
    }
  }

  const bindings: AzureResourceBinding[] = [];
  const leaves: string[] = [];
  collectStringLeaves(parsed, leaves);

  for (const leaf of leaves) {
    if (isSecretValue(leaf)) continue;
    const resolved = resolveStaticIndirection(leaf, localVars);
    if (!resolved) continue;
    const binding = bindingFromResolved(relativePath, family, resolved);
    if (binding) bindings.push(binding);
  }

  walkSteps(parsed, (step) => {
    flattenEnv(step.env, localVars);
    const withBlock = isRecord(step.with) ? step.with : isRecord(step.inputs) ? step.inputs : {};
    for (const [key, value] of Object.entries(withBlock)) {
      if (isSecretKey(key)) continue;
      const text = asString(value);
      if (!text || isSecretValue(text)) continue;
      const resolved = resolveStaticIndirection(text, localVars);
      if (!resolved) continue;
      const binding = bindingFromResolved(relativePath, family, resolved, key);
      if (binding) bindings.push(binding);
    }

    const uses = asString(step.uses) ?? asString(step.task) ?? '';
    if (/azure\/|apimanagement|api.?center|openapi|swagger/i.test(uses)) {
      bindings.push({
        class: 'association-only',
        family,
        evidence: [
          {
            sourceFile: relativePath,
            note: `${family} step ${sanitizeEvidenceValue(uses)} is association evidence`
          }
        ]
      });
    }
  });

  return bindings;
}

export function parseGitHubActionsWorkflow(
  relativePath: string,
  content: string,
  variables: Record<string, string> = {}
): AzureResourceBinding[] {
  return parseCiDocument(relativePath, content, 'github-actions', variables);
}

export function parseAzureDevOpsPipeline(
  relativePath: string,
  content: string,
  variables: Record<string, string> = {}
): AzureResourceBinding[] {
  return parseCiDocument(relativePath, content, 'azure-devops', variables);
}
