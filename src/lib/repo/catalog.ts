import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseAllDocuments } from 'yaml';
import { findIaCFiles } from './scan.js';

export interface CatalogApiRef {
  name: string;
  type?: string;
  specPath?: string;
  specUrl?: string;
}

interface CatalogEntity {
  apiVersion?: string;
  kind?: string;
  metadata?: { name?: string; [k: string]: unknown };
  spec?: {
    type?: string;
    definition?: string | { $text?: string; $json?: string };
    [k: string]: unknown;
  };
}

export async function detectCatalogApis(repoRoot: string): Promise<CatalogApiRef[] | undefined> {
  const candidates = await catalogCandidates(repoRoot);
  const apis: CatalogApiRef[] = [];

  for (const catalogPath of candidates) {
    const content = await readFile(path.resolve(repoRoot, catalogPath), 'utf8').catch(() => undefined);
    if (!content) continue;
    let docs: CatalogEntity[];
    try {
      docs = parseAllDocuments(content)
        .map((document) => document.toJSON() as CatalogEntity | null)
        .filter((document): document is CatalogEntity => Boolean(document && typeof document === 'object'));
    } catch {
      continue;
    }
    apis.push(...extractCatalogApis(catalogPath, docs));
  }

  return apis.length > 0 ? apis : undefined;
}

async function catalogCandidates(repoRoot: string): Promise<string[]> {
  const discovered = await findIaCFiles(repoRoot, ['.yaml', '.yml']);
  return [...new Set([
    'catalog-info.yaml',
    'catalog-info.yml',
    ...discovered
      .map((filePath) => path.relative(repoRoot, filePath).replace(/\\/g, '/'))
      .filter((filePath) => /(^|\/)catalog-info\.ya?ml$/.test(filePath))
  ])];
}

function extractCatalogApis(catalogPath: string, docs: CatalogEntity[]): CatalogApiRef[] {
  const apis: CatalogApiRef[] = [];
  for (const doc of docs) {
    if (!doc || doc.kind !== 'API') continue;

    const name = doc.metadata?.name ?? '';
    if (!name) continue;
    const type = typeof doc.spec?.type === 'string' ? doc.spec.type : undefined;

    const def = doc.spec?.definition;
    let specPath: string | undefined;
    let specUrl: string | undefined;

    if (typeof def === 'string') {
      if (def.startsWith('http://') || def.startsWith('https://')) {
        specUrl = def;
      } else {
        specPath = resolveCatalogPath(catalogPath, def);
      }
    } else if (def && typeof def === 'object') {
      const ref = typeof def.$text === 'string' ? def.$text : typeof def.$json === 'string' ? def.$json : undefined;
      if (typeof ref === 'string') {
        if (ref.startsWith('http://') || ref.startsWith('https://')) {
          specUrl = ref;
        } else {
          specPath = resolveCatalogPath(catalogPath, ref);
        }
      }
    }

    apis.push({ name, type, specPath, specUrl });
  }

  return apis;
}

function resolveCatalogPath(catalogPath: string, reference: string): string {
  const normalized = reference.replace(/\\/g, '/');
  if (path.posix.isAbsolute(normalized)) {
    return normalized.replace(/^\/+/, '');
  }
  const catalogDir = path.posix.dirname(catalogPath);
  if (catalogDir === '.') {
    return normalized;
  }
  return path.posix.normalize(path.posix.join(catalogDir, normalized));
}
