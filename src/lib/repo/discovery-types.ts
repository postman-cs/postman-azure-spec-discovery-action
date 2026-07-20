import type { SpecFormat } from '../../contracts.js';

/** Exact deployed identity vs association-only narrowing evidence. */
export type BindingClass = 'exact-binding' | 'association-only';

export type BindingFamily =
  | 'azure-yaml'
  | 'azure-env'
  | 'arm'
  | 'bicep'
  | 'terraform'
  | 'pulumi'
  | 'apiops'
  | 'github-actions'
  | 'azure-devops'
  | 'deployment-artifact'
  | 'source-control'
  | 'apim-inline'
  | 'api-center'
  | 'catalog';

export interface BindingEvidence {
  sourceFile: string;
  field?: string;
  /** Sanitized note; never includes raw secret-shaped values. */
  note: string;
}

export interface AzureResourceBinding {
  class: BindingClass;
  family: BindingFamily;
  apimApiId?: string;
  apiCenterDefinitionId?: string;
  serviceName?: string;
  resourceGroup?: string;
  subscriptionId?: string;
  environment?: string;
  gatewayHostname?: string;
  gatewayBasePath?: string;
  apiVersion?: string;
  apiRevision?: string;
  nativeSpecPath?: string;
  nativeSpecUrl?: string;
  sourceControlRepoUrl?: string;
  sourceControlBranch?: string;
  templateSpecId?: string;
  deploymentStackId?: string;
  evidence: BindingEvidence[];
}

export interface LocalSpecCandidate {
  path: string;
  format: SpecFormat;
  /** Higher means stronger filename/path ranking evidence; order is still stable lexical after score. */
  rankScore: number;
  evidence: string[];
}

export interface RepositoryDiscoveryDiagnostics {
  scannedFiles: number;
  truncatedByFileCap: boolean;
  truncatedByDepth: boolean;
  skippedSecretFiles: string[];
  messages: string[];
}

/**
 * Aggregate local discovery result for later runtime integration.
 * Local-only: no network, no process execution, no secret values in evidence.
 */
export interface RepositoryDiscoveryResult {
  localSpecs: LocalSpecCandidate[];
  exactBindings: AzureResourceBinding[];
  associations: AzureResourceBinding[];
  diagnostics: RepositoryDiscoveryDiagnostics;
}
