import type { ProviderProbeStatus } from '../../contracts.js';
import type { IacScanResult } from '../repo/azure-iac-scanner.js';
import type { SpecCandidate, SpecExportResult, SpecProvider } from './types.js';

/**
 * IaC-local provider: exposes inline APIM OpenAPI documents already extracted by the
 * confined repo scanner. probe() is always available (no cloud access involved);
 * exports re-emit the validated inline content captured at scan time.
 */
export class IacLocalProvider implements SpecProvider {
  public readonly type = 'iac-local' as const;

  private readonly scan: IacScanResult;

  public constructor(scan: IacScanResult) {
    this.scan = scan;
  }

  public probe(): Promise<ProviderProbeStatus> {
    return Promise.resolve('available');
  }

  public listCandidates(): Promise<SpecCandidate[]> {
    return Promise.resolve(this.scan.candidates);
  }

  public exportSpec(candidate: SpecCandidate): Promise<SpecExportResult> {
    const content = candidate.meta.inlineContent ?? '';
    if (!content) {
      return Promise.reject(new Error('IaC candidate has no inline specification content'));
    }
    const isJson = (candidate.meta.inlineFormat ?? 'openapi-json') === 'openapi-json';
    return Promise.resolve({
      content,
      format: isJson ? 'openapi-json' : 'openapi-yaml',
      filename: isJson ? 'index.json' : 'index.yaml',
      evidence: [`Extracted inline OpenAPI document from ${candidate.meta.relativePath ?? candidate.id}`]
    });
  }
}
