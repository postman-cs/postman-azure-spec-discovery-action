import { createHash } from 'node:crypto';

import type { SpecFormat } from '../../contracts.js';

/**
 * Optional cross-action definition inventory (PRD Wave 1 R2/R4).
 * Emitted only for authoritative multi-file full sets. Never embeds content.
 */

export const DEFINITION_FILE_INVENTORY_SCHEMA_VERSION = 1 as const;

export type DefinitionInventoryCompleteness = 'full';
export type DefinitionInventoryFileRole = 'root' | 'dependency';

export interface DefinitionInventoryFile {
  path: string;
  role: DefinitionInventoryFileRole;
  bytes: number;
  sha256: string;
}

export interface DefinitionInventoryProvenance {
  kind: 'provider';
  provider: 'azure';
}

export interface DefinitionFileInventory {
  schemaVersion: typeof DEFINITION_FILE_INVENTORY_SCHEMA_VERSION;
  root: string;
  format: SpecFormat;
  completeness: DefinitionInventoryCompleteness;
  provenance: DefinitionInventoryProvenance;
  files: DefinitionInventoryFile[];
}

export interface DefinitionInventoryMemberInput {
  /** Workspace-relative POSIX path. */
  path: string;
  role: DefinitionInventoryFileRole;
  content: string;
}

function assertInventoryPath(value: string, fieldName: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '');
  if (
    !normalized ||
    normalized.includes('\0') ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`Invalid ${fieldName} for definition inventory: ${value}`);
  }
  return normalized;
}

export function sha256HexOfUtf8(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function utf8ByteLength(content: string): number {
  return Buffer.byteLength(content, 'utf8');
}

/**
 * Build the exact PRD inventory object. Returns undefined when the set is not a
 * full multi-file inventory (single-file, partial, or empty).
 */
export function buildDefinitionFileInventory(options: {
  rootPath: string;
  format: SpecFormat;
  completeness: 'full' | 'partial';
  members: DefinitionInventoryMemberInput[];
}): DefinitionFileInventory | undefined {
  if (options.completeness !== 'full') return undefined;
  if (options.members.length <= 1) return undefined;

  const root = assertInventoryPath(options.rootPath, 'root');
  const files: DefinitionInventoryFile[] = options.members.map((member) => {
    const path = assertInventoryPath(member.path, 'files.path');
    return {
      path,
      role: member.role,
      bytes: utf8ByteLength(member.content),
      sha256: sha256HexOfUtf8(member.content)
    };
  });

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const roots = files.filter((file) => file.role === 'root');
  if (roots.length !== 1) {
    throw new Error(`Definition inventory requires exactly one root member, got ${roots.length}`);
  }
  if (roots[0]?.path !== root) {
    throw new Error('Definition inventory root path must equal the sole root member path');
  }

  const seen = new Set<string>();
  for (const file of files) {
    const folded = file.path.normalize('NFC').toLowerCase();
    if (seen.has(folded)) {
      throw new Error(`Definition inventory duplicate/case-colliding path: ${file.path}`);
    }
    seen.add(folded);
  }

  return {
    schemaVersion: DEFINITION_FILE_INVENTORY_SCHEMA_VERSION,
    root,
    format: options.format,
    completeness: 'full',
    provenance: { kind: 'provider', provider: 'azure' },
    files
  };
}

/** Single-line JSON for action/CLI output; empty string when inventory is absent. */
export function serializeDefinitionFileInventory(inventory: DefinitionFileInventory | undefined): string {
  if (!inventory) return '';
  return JSON.stringify(inventory);
}

export function emptyDefinitionFileInventoryOutput(): string {
  return '';
}
