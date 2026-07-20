export const SUITE_VERSION: string;
export const EVIDENCE_SCHEMA_VERSION: 2;
export const API_CENTER_LOCATION: 'eastus';
export const RUN_MARKER_TAG: string;
export const RESOURCE_RUN_MARKER_TAG: string;
export const PIPELINE_ID: 157;
export const PIPELINE_NAME: string;
export const STUB_HEALTH_TIMEOUT_MS: 120000;
export const STUB_HEALTH_POLL_INTERVAL_MS: 5000;
export const CASE_MATRIX_CONCURRENCY: 4;
export const CUSTOM_CONNECTOR_TIMEOUT_MS: 30000;
export const EXTENDED_DEPLOYMENT_TIMEOUT_MS: 120000;

export interface LiveFlags {
  provision: boolean;
  teardown: boolean;
  dryRun: boolean;
  renderPlan: boolean;
  cancelRecover: boolean;
  keepAlive: boolean;
}

export interface LiveEnv {
  subscriptionId: string;
  location: string;
  resourceGroup: string;
}

export type EvidenceStatus = 'pass' | 'fail' | 'requires-capability' | 'local-only';

export interface EvidenceResult {
  id: string;
  name: string;
  status: EvidenceStatus | string;
  providerType: string;
  sourceType: string;
  specFormat: string;
  contractClass: string;
  reasonCode?: string;
  durationMs?: number;
}

export interface EvidencePhase {
  name: string;
  durationMs: number;
}

export interface Evidence {
  schemaVersion: number;
  suiteVersion: string;
  testedCommitHashPrefix?: string;
  capturedAt: string;
  cases: number;
  passed: number;
  failed: number;
  requiresCapability: number;
  localOnly: number;
  results: EvidenceResult[];
  phases?: EvidencePhase[];
}

export interface CaseCatalogEntry {
  id: string;
  providerType: string;
  sourceType: string;
  specFormat: string;
  contractClass: string;
  lane: string;
  requires?: string[];
  localOnly?: boolean;
  claimFacets?: readonly string[];
}

export const EXPECTED_CASE_CATALOG_SIZE: 31;
export const CASE_CATALOG: readonly CaseCatalogEntry[];
export const PROVISION_FLAGS: Readonly<Record<string, boolean>>;
export const CLEANUP_RESOURCE_ORDER: readonly Array<{ key: string; type: string; nested?: boolean; parentKey?: string; parentType?: string }>;
export const SANITIZED_REASON_CODES: readonly string[];

export function parseFlags(argv: string[]): LiveFlags;
export function parseProvisionFlags(env?: Record<string, string | undefined>): Record<string, boolean>;
export function classifyProbeError(message: string | null | undefined): 'fatal' | 'retryable';
export function isResourceNotFoundError(error: unknown): boolean;
export function requiredEnv(env: Record<string, string | undefined>): LiveEnv;
export function resolveSubscriptionId(
  env: Record<string, string | undefined>,
  runner: (command: string, args: string[], options?: Record<string, unknown>) => string
): string;
export function resolveCommitHashPrefix(
  env?: Record<string, string | undefined>,
  runner?: (command: string, args: string[], options?: Record<string, unknown>) => string
): string;
export function shouldDeleteGroup(input: {
  manifest: { resourceGroup?: string; runMarker?: string } | null | undefined;
  groupShow: { name?: string; id?: string; tags?: Record<string, string> } | null | undefined;
  subscriptionId: string;
}): boolean;
export function shouldDeleteResource(input: {
  manifest: { resourceGroup?: string; runMarker?: string } | null | undefined;
  resourceShow: { name?: string; id?: string; type?: string; tags?: Record<string, string> } | null | undefined;
  subscriptionId: string;
  expectedName: string;
  expectedType: string;
}): boolean;
export function hasExactResourceIdentity(input: {
  manifest: { resourceGroup?: string } | null | undefined;
  resourceShow: { name?: string; id?: string; type?: string } | null | undefined;
  subscriptionId: string;
  expectedName: string;
  expectedType: string;
}): boolean;
export function sanitizeReasonCode(code: string | null | undefined): string | undefined;
export function toEvidenceResult(
  id: string,
  status: string,
  fields?: {
    providerType?: string;
    sourceType?: string;
    specFormat?: string;
    contractClass?: string;
    reasonCode?: string;
    durationMs?: number;
  }
): EvidenceResult;
export function buildEvidence(
  results: EvidenceResult[],
  options?: { suiteVersion?: string; testedCommitHashPrefix?: string; phases?: EvidencePhase[] }
): Evidence;
export function mapPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R> | R
): Promise<R[]>;
export function defaultAsyncRunner(
  command: string,
  args: string[],
  options?: Record<string, unknown>
): Promise<string>;
export function waitForStubHealth(input?: {
  url?: string;
  timeoutMs?: number;
  intervalMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}): Promise<boolean>;
export function provisionOptionalApimApis(input: {
  runner: (command: string, args: string[], options?: Record<string, unknown>) => string | Promise<string>;
  log: (line: string) => void;
  manifest: Record<string, unknown>;
  subscriptionId: string;
  provisionFlags: Record<string, boolean>;
  capabilities: Record<string, { ok: boolean; reasonCode?: string }>;
}): Promise<void>;
export function provisionCustomConnectorBounded(input: {
  asyncRunner: (command: string, args: string[], options?: Record<string, unknown>) => Promise<string>;
  log: (line: string) => void;
  manifest: Record<string, unknown> & {
    resourceGroup: string;
    customConnectorName: string;
    runMarker: string;
    resources: Array<Record<string, unknown>>;
  };
  subscriptionId: string;
  location: string;
  provisionFlags: Record<string, boolean>;
  capabilities: Record<string, { ok: boolean; reasonCode?: string }>;
  siteHostname: string;
}): Promise<void>;
export function passingLiveCaseIds(evidence: { results?: Array<{ name?: string; id?: string; status?: string }> }): Set<string>;
export function renderExecutionPlan(input?: {
  provisionFlags?: Record<string, boolean>;
  flags?: LiveFlags;
}): {
  suiteVersion: string;
  pipelineId: number;
  pipelineName: string;
  apiCenterLocation: string;
  flags: LiveFlags;
  provisionFlags: Record<string, boolean>;
  caseCount: number;
  cases: Array<Record<string, unknown>>;
  cleanupOrder: Array<{ key: string; type: string }>;
  notes: string[];
};
export function buildManifestNames(input: {
  suffix: string;
  runMarker: string;
  subscriptionId: string;
  resourceGroup: string;
  ownsResourceGroup: boolean;
  provisionFlags: Record<string, boolean>;
}): Record<string, unknown>;
export function recordManifestResource(
  manifest: { resources: Array<Record<string, unknown>> },
  entry: { type: string; name: string; id?: string | null }
): void;
export function teardownSharedGroupResources(input: {
  runner: (command: string, args: string[], options?: Record<string, unknown>) => string;
  log: (line: string) => void;
  manifest: Record<string, unknown>;
  subscriptionId: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<void>;
export function teardownDedicatedResourceGroup(input: {
  runner: (command: string, args: string[], options?: Record<string, unknown>) => string;
  log: (line: string) => void;
  manifest: Record<string, unknown>;
  subscriptionId: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<void>;
export function assertExpectedResult(
  caseId: string,
  resolution: Record<string, unknown>,
  options?: {
    expectedApiIdSuffix?: string;
    forbiddenApiIdPattern?: string;
    requiredEvidence?: string;
    forbiddenEvidence?: string;
    expectedContractClass?: string;
    assert?: (resolution: Record<string, unknown>, catalog: CaseCatalogEntry) => void;
  }
): Record<string, unknown>;
export function runLiveValidation(options?: {
  argv?: string[];
  env?: Record<string, string | undefined>;
  deps?: Record<string, unknown>;
}): Promise<Evidence>;
