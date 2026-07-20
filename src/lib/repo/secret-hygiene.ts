/** Filenames that must never be read for discovery content. */
const SECRET_BASENAME_RE =
  /(?:^|\.)(?:tfstate(?:\..+)?|pulumi(\.[^.]+)?\.(?:json|yaml|yml)|secrets?\.(?:json|ya?ml|env)|credentials?\.(?:json|ya?ml|env)|.*\.tfstate)$/i;

const SECRET_PATH_SEGMENT_RE = /(^|\/)(?:\.pulumi|terraform\.tfstate\.d)(\/|$)/i;

/** Strict allowlist of non-secret Azure coordinate keys permitted from .env-like files. */
const AZURE_ENV_ALLOWLIST = new Set([
  'AZURE_SUBSCRIPTION_ID',
  'AZURE_RESOURCE_GROUP',
  'AZURE_RESOURCE_GROUP_NAME',
  'AZURE_LOCATION',
  'AZURE_ENV_NAME',
  'AZURE_PRINCIPAL_ID',
  'AZURE_TENANT_ID',
  'APIM_SERVICE_NAME',
  'APIM_API_ID',
  'AZURE_APIM_API_ID',
  'API_MANAGEMENT_API_ID',
  'APIM_API_PATH',
  'APIM_GATEWAY_URL',
  'API_CENTER_SERVICE_NAME',
  'API_CENTER_DEFINITION_ID',
  'AZURE_API_CENTER_DEFINITION_ID',
  'SERVICE_NAME',
  'RESOURCE_GROUP',
  'SUBSCRIPTION_ID',
  'OPENAPI_PATH',
  'SPEC_PATH',
  'NATIVE_SPEC_PATH',
  'API_SPEC_PATH',
  'API_VERSION',
  'API_REVISION'
]);

const SECRET_KEY_RE =
  /(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|connectionstring|connection_string|clientsecret|client_secret|sas|sharedaccess|instrumentationkey|accountkey|storagekey|authorization|bearer)/i;

const SECRET_VALUE_RE =
  /(?:AccountKey=|SharedAccessSignature=|sig=[A-Za-z0-9%]+|Password=|(?:postgres|mysql|mongodb|redis|amqp|EventHub|ServiceBus):\/\/\S+:\S+@|\/\/[^/\s]+:[^@/\s]+@)/i;

const GITHUB_SECRET_EXPR_RE = /\$\{\{\s*secrets\.[^}]+\}\}/i;
const ADO_SECRET_EXPR_RE = /\$\((?:[^)]*[Ss]ecret[^)]*|.*Password.*)\)/;

export function isSecretPath(relativePath: string): boolean {
  const posix = relativePath.replace(/\\/g, '/');
  const base = posix.split('/').pop() ?? posix;
  if (SECRET_BASENAME_RE.test(base)) return true;
  if (SECRET_PATH_SEGMENT_RE.test(posix)) return true;
  // Skip Pulumi passphrase / stack secret sidecars.
  if (/(^|\/)Pulumi\.[^/]+\.yaml$/i.test(posix) && /secretsprovider|encryptionsalt|secure:/i.test(base)) {
    return true;
  }
  return false;
}

export function isAllowlistedEnvKey(key: string): boolean {
  return AZURE_ENV_ALLOWLIST.has(key.trim().toUpperCase());
}

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key);
}

export function isSecretValue(value: string): boolean {
  if (!value || !value.trim()) return false;
  if (GITHUB_SECRET_EXPR_RE.test(value) || ADO_SECRET_EXPR_RE.test(value)) return true;
  if (SECRET_VALUE_RE.test(value)) return true;
  // Userinfo in URLs.
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      const url = new URL(value);
      if (url.username || url.password) return true;
      if ([...url.searchParams.keys()].some((key) => /^(sig|se|sv|spr|srt|ss|sp|sip|sr)$/i.test(key))) {
        return true;
      }
    }
  } catch {
    // not a URL
  }
  return false;
}

export function sanitizeEvidenceValue(value: string): string {
  if (isSecretValue(value)) return '[redacted]';
  if (value.length > 240) return `${value.slice(0, 240)}…`;
  return value;
}

export function parseAllowlistedEnvContent(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const key = match[1]!;
    if (!isAllowlistedEnvKey(key) || isSecretKey(key)) continue;
    let value = match[2] ?? '';
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!value || isSecretValue(value)) continue;
    result[key.toUpperCase()] = value.trim();
  }
  return result;
}

/** True when an ARM parameter/property looks secure and should not contribute evidence values. */
export function isSecureArmParameter(name: string, definition: unknown): boolean {
  if (isSecretKey(name)) return true;
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) return false;
  const typed = definition as Record<string, unknown>;
  if (typed.type === 'secureString' || typed.type === 'secureObject') return true;
  if (typed.visibility === 'secure') return true;
  return false;
}
