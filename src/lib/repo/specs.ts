import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';

import type { SpecFormat } from '../../contracts.js';

const DIRECT_SPEC_CANDIDATES = [
  'openapi.yaml',
  'openapi.yml',
  'openapi.json',
  'api.yaml',
  'api.yml',
  'api.json',
  'oas.yaml',
  'oas.yml',
  'oas.json',
  'swagger.yaml',
  'swagger.yml',
  'swagger.json',
  'spec/openapi.yaml',
  'spec/openapi.yml',
  'spec/openapi.json',
  'api/openapi.yaml',
  'api/openapi.yml',
  'api/openapi.json',
  'docs/openapi.yaml',
  'docs/openapi.yml',
  'docs/openapi.json'
];

const COMMON_SCAN_DIRS = [
  '.',
  'api',
  'apis',
  'api-docs',
  'docs',
  'reference',
  'public',
  'spec',
  'specs',
  'contracts',
  'services',
  'packages',
  'apps'
];

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.terraform',
  'dist',
  'build',
  'discovered-specs',
  'vendor',
  'test',
  'tests',
  '__pycache__',
  '.venv',
  'venv',
  '.pulumi'
]);

const MAX_SPEC_SCAN_FILES = 200;
const MAX_SPEC_SCAN_DEPTH = 6;

function isLikelyOpenApiDocument(content: string): boolean {
  try {
    const parsed = content.trim().startsWith('{') ? JSON.parse(content) : parse(content);
    if (!parsed || typeof parsed !== 'object') {
      return false;
    }
    return Boolean((parsed as Record<string, unknown>).openapi || (parsed as Record<string, unknown>).swagger);
  } catch {
    return false;
  }
}

export interface RepoSpecMatch {
  path: string;
  format: SpecFormat;
  evidence?: string[];
}

function formatFor(candidate: string): SpecFormat {
  return candidate.endsWith('.json') ? 'openapi-json' : 'openapi-yaml';
}

export async function findExistingRepoSpec(repoRoot: string): Promise<string | undefined> {
  const match = await findExistingRepoSpecTyped(repoRoot);
  return match?.path;
}

export async function findExistingRepoSpecTyped(repoRoot: string): Promise<RepoSpecMatch | undefined> {
  const candidates = await collectSpecCandidates(repoRoot);
  for (const candidate of candidates) {
    const fullPath = path.resolve(repoRoot, candidate);
    try {
      const fileStat = await stat(fullPath);
      if (!fileStat.isFile()) {
        continue;
      }
      const content = await readFile(fullPath, 'utf8');
      if (isLikelyOpenApiDocument(content)) {
        const normalized = candidate.replace(/\\/g, '/');
        return {
          path: normalized,
          format: formatFor(normalized.toLowerCase()),
          evidence: [`Resolved from repository specification ${normalized}`]
        };
      }
    } catch {
      // Continue search.
    }
  }

  return undefined;
}

function isSpecLikeFilename(filename: string): boolean {
  const lower = filename.toLowerCase();
  return /^(openapi|swagger|api|oas)(?:[.-]v?\d+(?:\.\d+)*)?\.(?:ya?ml|json)$/.test(lower);
}

async function collectSpecCandidates(repoRoot: string): Promise<string[]> {
  const candidates = new Set<string>();
  for (const candidate of DIRECT_SPEC_CANDIDATES) {
    candidates.add(candidate);
  }

  const count = { value: 0 };
  for (const dir of COMMON_SCAN_DIRS) {
    const root = path.resolve(repoRoot, dir);
    const fileStat = await stat(root).catch(() => undefined);
    if (!fileStat) continue;
    if (fileStat.isFile()) {
      const relative = path.relative(repoRoot, root);
      if (isSpecLikeFilename(path.basename(relative))) {
        candidates.add(relative);
      }
      continue;
    }
    if (!fileStat.isDirectory()) continue;
    for (const file of await walkSpecCandidates(repoRoot, root, count)) {
      candidates.add(file);
    }
    if (count.value >= MAX_SPEC_SCAN_FILES) break;
  }

  return [...candidates].sort((left, right) => specCandidateScore(right) - specCandidateScore(left) || left.localeCompare(right));
}

async function walkSpecCandidates(repoRoot: string, current: string, count: { value: number }, depth = 0): Promise<string[]> {
  if (depth > MAX_SPEC_SCAN_DEPTH || count.value >= MAX_SPEC_SCAN_FILES) return [];
  const results: string[] = [];
  const entries = await readdir(current).catch(() => [] as string[]);
  for (const entry of entries) {
    if (count.value >= MAX_SPEC_SCAN_FILES) break;
    if (SKIP_DIRS.has(entry)) continue;
    const fullPath = path.join(current, entry);
    const info = await stat(fullPath).catch(() => undefined);
    if (!info) continue;
    if (info.isDirectory()) {
      results.push(...await walkSpecCandidates(repoRoot, fullPath, count, depth + 1));
      continue;
    }
    if (info.isFile() && isSpecLikeFilename(entry)) {
      count.value += 1;
      results.push(path.relative(repoRoot, fullPath));
    }
  }
  return results;
}

function specCandidateScore(candidate: string): number {
  const normalized = candidate.replace(/\\/g, '/').toLowerCase();
  const basename = path.basename(normalized);
  let score = 0;
  if (DIRECT_SPEC_CANDIDATES.includes(normalized)) score += 200;
  if (/^(openapi|swagger)(?:[.-]v?\d+(?:\.\d+)*)?\.(?:ya?ml|json)$/.test(basename)) score += 90;
  if (/^(api|oas)(?:[.-]v?\d+(?:\.\d+)*)?\.(?:ya?ml|json)$/.test(basename)) score += 85;
  if (/^(api|apis|spec|specs|contracts|reference|public)\//.test(normalized)) score += 20;
  if (/^(services|packages|apps)\/[^/]+\//.test(normalized)) score += 15;
  return score;
}
