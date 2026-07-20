export function renderInputsTable(inputs: Record<string, { description?: string; required?: boolean; default?: unknown }>): string;
export function renderOutputsTable(outputs: Record<string, { description?: string }>): string;
export function renderCoverageTable(manifest: {
  routes?: Array<{
    id?: string;
    provider?: string;
    contractClass?: string;
    validationState?: string;
    liveEvidenceCase?: string | null;
    plannedLiveEvidenceCase?: string | null;
    localOnlyRationale?: string | null;
  }>;
}): string;
export function replaceBetween(content: string, marker: string, table: string): string;
