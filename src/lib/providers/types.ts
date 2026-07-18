import type { ProviderType, ProviderProbeStatus, SpecFormat } from '../../contracts.js';

export interface SpecCandidate {
  id: string; // full ARM ID, or stable repo-relative IaC candidate ID
  name: string;
  providerType: ProviderType;
  apiId?: string; // full APIM API ARM ID only
  resourceGroup?: string;
  tags: Record<string, string>;
  supported: boolean;
  evidence: string[];
  meta: Record<string, string>;
}

export interface SpecExportResult {
  content: string;
  format: SpecFormat;
  filename: 'index.json' | 'index.yaml';
  evidence: string[];
  /**
   * Provider-declared completeness of the exported document. Omitted means
   * 'full' (the provider exported a complete authored spec). Derivation may
   * downgrade completeness but must never upgrade a provider-declared
   * 'partial' to 'full'.
   */
  completeness?: 'full' | 'partial';
}

export interface SpecProvider {
  readonly type: ProviderType;
  probe(): Promise<ProviderProbeStatus>;
  listCandidates(): Promise<SpecCandidate[]>;
  exportSpec(candidate: SpecCandidate): Promise<SpecExportResult>;
}
