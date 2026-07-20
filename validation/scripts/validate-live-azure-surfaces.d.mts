export const SUITE_VERSION: string;
export const EVIDENCE_SCHEMA_VERSION: 2;
export const API_CENTER_LOCATION: 'eastus';
export const RUN_MARKER_TAG: string;
export const RESOURCE_RUN_MARKER_TAG: string;
export const PIPELINE_ID: 157;
export const PIPELINE_NAME: string;

export interface LiveFlags {
  provision: boolean;
  teardown: boolean;
  dryRun: boolean;
  renderPlan: boolean;
  cancelRecover: boolean;
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
}

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
  }
): EvidenceResult;
export function buildEvidence(
  results: EvidenceResult[],
  options?: { suiteVersion?: string; testedCommitHashPrefix?: string }
): Evidence;
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
export function runLiveValidation(options?: {
  argv?: string[];
  env?: Record<string, string | undefined>;
  deps?: Record<string, unknown>;
}): Promise<Evidence>;
