import path from 'node:path';

import type { ContractClass, SpecFormat } from '../../contracts.js';
import type { SpecExportResult } from '../providers/types.js';

/**
 * Extract protobuf import targets (`import "…"`, `import public "…"`, `import weak "…"`).
 * Does not fetch or concatenate imported files.
 */
export function extractProtobufImports(content: string): string[] {
  const withoutComments = content.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '');
  const refs: string[] = [];
  const pattern = /^\s*import\s+(?:public\s+|weak\s+)?"([^"]+)"\s*;/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(withoutComments)) !== null) {
    const value = match[1]?.trim();
    if (value) refs.push(value);
  }
  return [...new Set(refs)];
}

/**
 * Extract WSDL/XSD dependency locations: schemaLocation / itemSchemaLocation,
 * xsd:include/import schemaLocation, and wsdl:import location attributes.
 */
export function extractXmlSchemaDependencyRefs(content: string): string[] {
  const refs: string[] = [];
  const patterns = [
    /\b(?:schemaLocation|itemSchemaLocation)\s*=\s*["']([^"']+)["']/gi,
    /<(?:[\w.-]+:)?import\b[^>]*\blocation\s*=\s*["']([^"']+)["']/gi,
    /<(?:[\w.-]+:)?include\b[^>]*\bschemaLocation\s*=\s*["']([^"']+)["']/gi
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const value = match[1]?.trim();
      if (value) refs.push(value);
    }
  }
  return [...new Set(refs)];
}

export function listNativeDependencyRefs(content: string, format: SpecFormat): string[] {
  if (format === 'protobuf') return extractProtobufImports(content);
  if (format === 'wsdl' || format === 'xsd') return extractXmlSchemaDependencyRefs(content);
  return [];
}

function isAbsoluteOrRemoteRef(ref: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('//');
}

/**
 * Normalize a dependency ref into a lookup key for available companion bytes.
 * Absolute/remote refs cannot be satisfied from local companion maps.
 */
export function dependencyRefKey(ref: string): string | undefined {
  if (!ref || isAbsoluteOrRemoteRef(ref)) return undefined;
  const normalized = ref.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.includes('\0') || normalized.split('/').includes('..')) {
    return undefined;
  }
  return normalized;
}

export interface DependencyFidelityAssessment {
  refs: string[];
  unresolvedRefs: string[];
  /** True when the primary has dependency refs that are not covered by available bytes. */
  hasUnresolvedDependencies: boolean;
  contractClass: Extract<ContractClass, 'authoritative' | 'partial'>;
  completeness: 'full' | 'partial';
  evidence: string[];
}

/**
 * Assess whether a validated native primary document has closed dependency fidelity.
 * Available companion keys are exact relative paths and/or basenames already in hand
 * (never fetched). Absolute/remote refs always remain unresolved.
 */
export function assessNativeDependencyFidelity(options: {
  content: string;
  format: SpecFormat;
  availableDependencyKeys?: Iterable<string>;
}): DependencyFidelityAssessment {
  const refs = listNativeDependencyRefs(options.content, options.format);
  if (refs.length === 0) {
    return {
      refs: [],
      unresolvedRefs: [],
      hasUnresolvedDependencies: false,
      contractClass: 'authoritative',
      completeness: 'full',
      evidence: [`No external ${options.format} dependency references; primary document is dependency-closed`]
    };
  }

  const available = new Set<string>();
  for (const key of options.availableDependencyKeys ?? []) {
    const normalized = key.replace(/\\/g, '/');
    available.add(normalized);
    available.add(path.posix.basename(normalized));
  }

  const unresolvedRefs: string[] = [];
  for (const ref of refs) {
    const key = dependencyRefKey(ref);
    if (!key) {
      unresolvedRefs.push(ref);
      continue;
    }
    if (available.has(key) || available.has(path.posix.basename(key))) continue;
    unresolvedRefs.push(ref);
  }

  if (unresolvedRefs.length === 0) {
    return {
      refs,
      unresolvedRefs: [],
      hasUnresolvedDependencies: false,
      contractClass: 'authoritative',
      completeness: 'full',
      evidence: [
        `All ${refs.length} ${options.format} dependency reference(s) are covered by available companion bytes (no concatenation)`
      ]
    };
  }

  return {
    refs,
    unresolvedRefs,
    hasUnresolvedDependencies: true,
    contractClass: 'partial',
    completeness: 'partial',
    evidence: [
      `${options.format} primary is bootstrap-consumable but has unresolved dependency reference(s): ${unresolvedRefs.join(', ')}`,
      'Export fidelity is partial; no authoritative/full closure without dependency bytes (never concatenated or remotely fetched with Azure credentials)'
    ]
  };
}

/**
 * Apply dependency-fidelity assessment onto an export. Never upgrades a stronger
 * downgrade already present (reconstructed/partial/association-only/unsupported).
 */
export function applyNativeDependencyFidelity(
  exportResult: SpecExportResult,
  assessment: DependencyFidelityAssessment
): SpecExportResult {
  const evidence = [...exportResult.evidence, ...assessment.evidence];
  if (!assessment.hasUnresolvedDependencies) {
    return { ...exportResult, evidence };
  }

  const existing = exportResult.contractClass;
  const mustKeepExisting =
    existing === 'reconstructed' ||
    existing === 'partial' ||
    existing === 'association-only' ||
    existing === 'unsupported';

  return {
    ...exportResult,
    completeness: 'partial',
    contractClass: mustKeepExisting ? existing : 'partial',
    evidence
  };
}
