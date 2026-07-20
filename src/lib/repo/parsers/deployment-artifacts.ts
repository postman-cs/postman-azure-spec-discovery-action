import type { AzureResourceBinding } from '../discovery-types.js';
import {
  isFullApiCenterDefinitionId,
  isFullApimApiId,
  parseApiCenterDefinitionArmId,
  parseApimApiArmId,
  parseDeploymentStackId,
  parseTemplateSpecId,
  resolveStaticIndirection
} from '../arm-ids.js';
import { isSecretKey, isSecretValue } from '../secret-hygiene.js';

/** Deterministic ceilings for recursive deployment-artifact object walks. */
export const DEPLOYMENT_WALK_MAX_DEPTH = 32;
export const DEPLOYMENT_WALK_MAX_NODES = 4000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  if (budget.truncated || depth > DEPLOYMENT_WALK_MAX_DEPTH) {
    budget.truncated = true;
    return false;
  }
  if (budget.seen.has(value)) {
    budget.truncated = true;
    return false;
  }
  budget.seen.add(value);
  budget.nodes += 1;
  if (budget.nodes > DEPLOYMENT_WALK_MAX_NODES) {
    budget.truncated = true;
    return false;
  }
  return true;
}

function pushFromString(
  relativePath: string,
  field: string,
  value: string,
  variables: Record<string, string>,
  bindings: AzureResourceBinding[]
): void {
  if (!value || isSecretKey(field) || isSecretValue(value)) return;
  const resolved = resolveStaticIndirection(value, variables) ?? value;
  if (isSecretValue(resolved)) return;

  const apim = parseApimApiArmId(resolved);
  if (apim && isFullApimApiId(resolved)) {
    bindings.push({
      class: 'exact-binding',
      family: 'deployment-artifact',
      apimApiId: apim.fullId,
      subscriptionId: apim.subscriptionId,
      resourceGroup: apim.resourceGroup,
      serviceName: apim.serviceName,
      apiRevision: apim.revision,
      evidence: [{ sourceFile: relativePath, field, note: 'deployment artifact exact APIM API ARM ID' }]
    });
  }

  const center = parseApiCenterDefinitionArmId(resolved);
  if (center && isFullApiCenterDefinitionId(resolved)) {
    bindings.push({
      class: 'exact-binding',
      family: 'deployment-artifact',
      apiCenterDefinitionId: center.fullId,
      subscriptionId: center.subscriptionId,
      resourceGroup: center.resourceGroup,
      serviceName: center.serviceName,
      apiVersion: center.version,
      evidence: [{ sourceFile: relativePath, field, note: 'deployment artifact exact API Center definition ARM ID' }]
    });
  }

  const templateSpec = parseTemplateSpecId(resolved);
  if (templateSpec) {
    bindings.push({
      class: 'exact-binding',
      family: 'deployment-artifact',
      templateSpecId: templateSpec.fullId,
      evidence: [{ sourceFile: relativePath, field, note: `Template Spec ID ${templateSpec.name}` }]
    });
  }

  const stack = parseDeploymentStackId(resolved);
  if (stack) {
    bindings.push({
      class: 'exact-binding',
      family: 'deployment-artifact',
      deploymentStackId: stack.fullId,
      evidence: [{ sourceFile: relativePath, field, note: `Deployment stack ID ${stack.name}` }]
    });
  }
}

function walk(
  value: unknown,
  relativePath: string,
  field: string,
  variables: Record<string, string>,
  bindings: AzureResourceBinding[],
  budget = createWalkBudget(),
  depth = 0
): void {
  if (budget.truncated) return;
  if (typeof value === 'string') {
    pushFromString(relativePath, field, value, variables, bindings);
    return;
  }
  if (Array.isArray(value)) {
    if (!enterWalkNode(value, budget, depth)) return;
    value.forEach((entry, index) =>
      walk(entry, relativePath, `${field}[${index}]`, variables, bindings, budget, depth + 1)
    );
    return;
  }
  if (!isRecord(value)) return;
  if (!enterWalkNode(value, budget, depth)) return;

  // ARM deployment outputs shape: { outputs: { name: { value: '...' } } } or flattened outputs.
  if (isRecord(value.outputs)) {
    for (const [name, output] of Object.entries(value.outputs)) {
      if (isSecretKey(name)) continue;
      if (isRecord(output)) {
        if (output.type === 'secureString' || output.type === 'secureObject') continue;
        walk(output.value ?? output, relativePath, `outputs.${name}`, variables, bindings, budget, depth + 1);
      } else {
        walk(output, relativePath, `outputs.${name}`, variables, bindings, budget, depth + 1);
      }
    }
  }

  for (const [key, child] of Object.entries(value)) {
    if (key === 'outputs') continue;
    if (isSecretKey(key)) continue;
    walk(child, relativePath, field ? `${field}.${key}` : key, variables, bindings, budget, depth + 1);
  }
}

/**
 * Parse committed deployment outputs / stacks / Template Spec ID artifacts.
 */
export function parseDeploymentArtifact(
  relativePath: string,
  content: string,
  variables: Record<string, string> = {}
): AzureResourceBinding[] {
  const trimmed = content.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Also accept raw ID text files.
    const bindings: AzureResourceBinding[] = [];
    pushFromString(relativePath, 'text', trimmed, variables, bindings);
    return bindings;
  }
  const bindings: AzureResourceBinding[] = [];
  walk(parsed, relativePath, '', variables, bindings);
  return bindings;
}
