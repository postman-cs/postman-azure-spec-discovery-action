export interface ParsedApimApiId {
  subscriptionId?: string;
  resourceGroup?: string;
  serviceName: string;
  apiName: string;
  revision?: string;
  workspace?: string;
  fullId: string;
}

export interface ParsedApiCenterDefinitionId {
  subscriptionId?: string;
  resourceGroup?: string;
  serviceName: string;
  workspace: string;
  apiName: string;
  version: string;
  definitionName: string;
  fullId: string;
}

const APIM_API_ID_RE =
  /\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.ApiManagement\/service\/([^/]+)(?:\/workspaces\/([^/]+))?\/apis\/([^/\s"']+)/i;

const APIM_API_ID_SHORT_RE =
  /\/providers\/Microsoft\.ApiManagement\/service\/([^/]+)(?:\/workspaces\/([^/]+))?\/apis\/([^/\s"']+)/i;

const API_CENTER_DEF_RE =
  /\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.ApiCenter\/services\/([^/]+)\/workspaces\/([^/]+)\/apis\/([^/]+)\/versions\/([^/]+)\/definitions\/([^/\s"']+)/i;

const TEMPLATE_SPEC_RE =
  /\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.Resources\/templateSpecs\/([^/\s"']+)(?:\/versions\/([^/\s"']+))?/i;

const DEPLOYMENT_STACK_RE =
  /\/subscriptions\/([^/]+)\/(?:resourceGroups\/([^/]+)\/)?providers\/Microsoft\.Resources\/deploymentStacks\/([^/\s"']+)/i;

export function parseApimApiArmId(value: string): ParsedApimApiId | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const full = trimmed.match(APIM_API_ID_RE);
  if (full) {
    const apiRaw = full[5]!;
    const [apiName, revPart] = apiRaw.split(';rev=');
    return {
      subscriptionId: full[1],
      resourceGroup: full[2],
      serviceName: full[3]!,
      workspace: full[4] || undefined,
      apiName: apiName!,
      revision: revPart,
      fullId: trimmed
    };
  }
  const short = trimmed.match(APIM_API_ID_SHORT_RE);
  if (!short) return undefined;
  const apiRaw = short[3]!;
  const [apiName, revPart] = apiRaw.split(';rev=');
  return {
    serviceName: short[1]!,
    workspace: short[2] || undefined,
    apiName: apiName!,
    revision: revPart,
    fullId: trimmed
  };
}

export function parseApiCenterDefinitionArmId(value: string): ParsedApiCenterDefinitionId | undefined {
  const trimmed = value.trim();
  const match = trimmed.match(API_CENTER_DEF_RE);
  if (!match) return undefined;
  return {
    subscriptionId: match[1],
    resourceGroup: match[2],
    serviceName: match[3]!,
    workspace: match[4]!,
    apiName: match[5]!,
    version: match[6]!,
    definitionName: match[7]!,
    fullId: trimmed
  };
}

export function parseTemplateSpecId(value: string): { fullId: string; name: string; version?: string } | undefined {
  const match = value.trim().match(TEMPLATE_SPEC_RE);
  if (!match) return undefined;
  return {
    fullId: value.trim(),
    name: match[3]!,
    version: match[4]
  };
}

export function parseDeploymentStackId(value: string): { fullId: string; name: string } | undefined {
  const match = value.trim().match(DEPLOYMENT_STACK_RE);
  if (!match) return undefined;
  return { fullId: value.trim(), name: match[3]! };
}

export function isFullApimApiId(value: string): boolean {
  return Boolean(value.trim().match(APIM_API_ID_RE));
}

export function isFullApiCenterDefinitionId(value: string): boolean {
  return Boolean(value.trim().match(API_CENTER_DEF_RE));
}

/** Extract statically resolvable ${var} / $(var) / env:VAR references when present in a local map. */
export function resolveStaticIndirection(raw: string, variables: Record<string, string>): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (!/[${]/.test(trimmed) && !trimmed.includes('%')) {
    return trimmed;
  }

  let resolved = trimmed;
  resolved = resolved.replace(/\$\{(?:env|var):?([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key: string) => {
    return variables[key] ?? variables[key.toUpperCase()] ?? `\u0000`;
  });
  resolved = resolved.replace(/\$\(([A-Za-z_][A-Za-z0-9_]*)\)/g, (_, key: string) => {
    return variables[key] ?? variables[key.toUpperCase()] ?? `\u0000`;
  });
  resolved = resolved.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_, key: string) => {
    return variables[key] ?? variables[key.toUpperCase()] ?? `\u0000`;
  });
  resolved = resolved.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_, key: string) => {
    return variables[key] ?? variables[key.toUpperCase()] ?? `\u0000`;
  });

  if (resolved.includes('\u0000')) return undefined;
  return resolved;
}
