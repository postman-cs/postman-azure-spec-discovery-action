export interface LiveFlags {
  provision: boolean;
  teardown: boolean;
}

export interface LiveEnv {
  subscriptionId: string;
  location: string;
}

export interface EvidenceResult {
  name: string;
  status: string;
  sourceType: string;
  providerType: string;
  specFormat: string;
}

export interface Evidence {
  schemaVersion: number;
  capturedAt: string;
  cases: number;
  passed: number;
  failed: number;
  results: EvidenceResult[];
}

export function parseFlags(argv: string[]): LiveFlags;
export function classifyProbeError(message: string | null | undefined): 'fatal' | 'retryable';
export function requiredEnv(env: Record<string, string | undefined>): LiveEnv;
export function resolveSubscriptionId(
  env: Record<string, string | undefined>,
  runner: (command: string, args: string[], options?: Record<string, unknown>) => string
): string;
export function shouldDeleteGroup(input: {
  manifest: { resourceGroup?: string; runMarker?: string } | null | undefined;
  groupShow: { name?: string; id?: string; tags?: Record<string, string> } | null | undefined;
  subscriptionId: string;
}): boolean;
export function toEvidenceResult(
  name: string,
  status: string,
  resolution?: { sourceType?: string; providerType?: string; specFormat?: string }
): EvidenceResult;
export function buildEvidence(results: EvidenceResult[]): Evidence;
export function runLiveValidation(options?: {
  argv?: string[];
  env?: Record<string, string | undefined>;
  deps?: Record<string, unknown>;
}): Promise<Evidence>;
