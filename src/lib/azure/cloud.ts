/**
 * Azure cloud profiles for ARM management endpoints, token audiences, and
 * authority hosts. Direct REST clients and SDK wrappers resolve one profile
 * from AZURE_ENVIRONMENT and/or AZURE_AUTHORITY_HOST (public Azure default).
 */

export type AzureCloudName = 'AzureCloud' | 'AzureUSGovernment' | 'AzureChinaCloud';

export interface AzureCloudProfile {
  name: AzureCloudName;
  /** ARM Resource Manager base URL without a trailing slash. */
  managementEndpoint: string;
  /** OAuth scope passed to TokenCredential.getToken for ARM REST. */
  armTokenScope: string;
  /** Microsoft Entra authority host for DefaultAzureCredential / MSAL. */
  authorityHost: string;
}

export const AZURE_CLOUD_PROFILES: Record<AzureCloudName, AzureCloudProfile> = {
  AzureCloud: {
    name: 'AzureCloud',
    managementEndpoint: 'https://management.azure.com',
    armTokenScope: 'https://management.azure.com/.default',
    authorityHost: 'https://login.microsoftonline.com'
  },
  AzureUSGovernment: {
    name: 'AzureUSGovernment',
    managementEndpoint: 'https://management.usgovcloudapi.net',
    armTokenScope: 'https://management.usgovcloudapi.net/.default',
    authorityHost: 'https://login.microsoftonline.us'
  },
  AzureChinaCloud: {
    name: 'AzureChinaCloud',
    managementEndpoint: 'https://management.chinacloudapi.cn',
    armTokenScope: 'https://management.chinacloudapi.cn/.default',
    authorityHost: 'https://login.chinacloudapi.cn'
  }
};

const ENVIRONMENT_ALIASES: Record<string, AzureCloudName> = {
  azurecloud: 'AzureCloud',
  azurepubliccloud: 'AzureCloud',
  azurepublic: 'AzureCloud',
  public: 'AzureCloud',
  azureusgovernment: 'AzureUSGovernment',
  azuregovernment: 'AzureUSGovernment',
  usgovernment: 'AzureUSGovernment',
  azureusgov: 'AzureUSGovernment',
  azurechinacloud: 'AzureChinaCloud',
  azurechina: 'AzureChinaCloud',
  china: 'AzureChinaCloud'
};

function normalizeAuthorityHost(value: string): string {
  return value.trim().replace(/\/+$/, '').toLowerCase();
}

const AUTHORITY_HOST_ALIASES: Record<string, AzureCloudName> = {
  'https://login.microsoftonline.com': 'AzureCloud',
  'https://login.microsoftonline.us': 'AzureUSGovernment',
  'https://login.chinacloudapi.cn': 'AzureChinaCloud'
};

function profileFromEnvironmentName(raw: string): AzureCloudProfile {
  const key = raw.trim().toLowerCase();
  const name = ENVIRONMENT_ALIASES[key];
  if (!name) {
    throw new Error(
      `Unsupported Azure environment "${raw}". Supported values: AzureCloud, AzureUSGovernment, AzureChinaCloud (and documented aliases).`
    );
  }
  return AZURE_CLOUD_PROFILES[name];
}

function profileFromAuthorityHost(raw: string): AzureCloudProfile {
  const key = normalizeAuthorityHost(raw);
  const name = AUTHORITY_HOST_ALIASES[key];
  if (!name) {
    throw new Error(
      `Unsupported Azure authority host "${raw}". Supported hosts: ${Object.keys(AUTHORITY_HOST_ALIASES).join(', ')}.`
    );
  }
  return AZURE_CLOUD_PROFILES[name];
}

/**
 * Resolve the active Azure cloud profile from standard environment variables.
 * Prefer AZURE_ENVIRONMENT when set; otherwise map AZURE_AUTHORITY_HOST; default
 * to public Azure. When both are set they must select the same profile.
 */
export function resolveAzureCloudProfile(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env
): AzureCloudProfile {
  const environment = env.AZURE_ENVIRONMENT?.trim();
  const authorityHost = env.AZURE_AUTHORITY_HOST?.trim();

  if (environment && authorityHost) {
    const fromEnv = profileFromEnvironmentName(environment);
    const fromAuthority = profileFromAuthorityHost(authorityHost);
    if (fromEnv.name !== fromAuthority.name) {
      throw new Error(
        `Azure cloud configuration conflict: AZURE_ENVIRONMENT=${environment} selects ${fromEnv.name} but AZURE_AUTHORITY_HOST=${authorityHost} selects ${fromAuthority.name}.`
      );
    }
    return fromEnv;
  }
  if (environment) {
    return profileFromEnvironmentName(environment);
  }
  if (authorityHost) {
    return profileFromAuthorityHost(authorityHost);
  }
  return AZURE_CLOUD_PROFILES.AzureCloud;
}

/** Join an absolute path onto the profile management endpoint. */
export function armManagementUrl(profile: AzureCloudProfile, path: string): string {
  const base = profile.managementEndpoint.replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
}

/**
 * Validate an opaque ARM nextLink before forwarding credentials: HTTPS only and
 * host must match the configured management endpoint. Returns the link unchanged.
 */
export function assertSafeArmNextLink(
  nextLink: string,
  profile: AzureCloudProfile,
  operation: string
): string {
  let parsed: URL;
  try {
    parsed = new URL(nextLink);
  } catch {
    throw new Error(`${operation} pagination returned a malformed nextLink; aborting`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`${operation} pagination nextLink must be HTTPS; aborting`);
  }
  const expectedHost = new URL(profile.managementEndpoint).host.toLowerCase();
  if (parsed.host.toLowerCase() !== expectedHost) {
    throw new Error(
      `${operation} pagination nextLink host is outside the configured ARM management endpoint; aborting`
    );
  }
  return nextLink;
}
