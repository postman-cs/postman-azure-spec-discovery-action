export const ADVERTISED_PROVIDERS: readonly string[];
export const CONTRACT_CLASSES: ReadonlySet<string>;
export const VALIDATION_STATES: ReadonlySet<string>;

export interface CoverageVerificationResult {
  ok: boolean;
  errors: string[];
}

export function isRemoteImplementationFile(relPath: string): boolean;
export function verifyCoverageManifest(input: {
  root: string;
  manifest?: unknown;
  evidence?: unknown;
}): CoverageVerificationResult;
