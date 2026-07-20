import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { SpecFormat } from '../../contracts.js';
import { detectNativeFormat, parseAndValidateNativeSpec } from '../spec/native-formats.js';
import type { LocalSpecCandidate } from './discovery-types.js';
import { DEFAULT_MAX_FILE_BYTES, walkRepoFiles } from './scan.js';

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
  'asyncapi.yaml',
  'asyncapi.yml',
  'asyncapi.json',
  'mcp.json',
  'server.json',
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

/** Obvious binary/output extensions skipped during content detection. */
const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.pdf',
  '.zip',
  '.gz',
  '.tgz',
  '.bz2',
  '.7z',
  '.rar',
  '.tar',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.otf',
  '.mp3',
  '.mp4',
  '.webm',
  '.mov',
  '.avi',
  '.class',
  '.o',
  '.a',
  '.so',
  '.dll',
  '.exe',
  '.bin',
  '.wasm',
  '.lock',
  '.sum'
]);

export interface RepoSpecMatch {
  path: string;
  format: SpecFormat;
  evidence?: string[];
}

function isSpecScanCandidate(relativePosix: string, basename: string): boolean {
  void relativePosix;
  const lower = basename.toLowerCase();
  const ext = path.posix.extname(lower);
  // Content-detect regardless of common filename; only skip obvious binaries.
  if (ext && BINARY_EXTENSIONS.has(ext)) return false;
  if (lower.endsWith('.tfstate') || lower.endsWith('.tfstate.backup')) return false;
  return true;
}

export function specCandidateScore(candidate: string): number {
  const normalized = candidate.replace(/\\/g, '/').toLowerCase();
  const basename = path.posix.basename(normalized);
  let score = 0;
  if (DIRECT_SPEC_CANDIDATES.includes(normalized)) score += 200;
  if (/^(openapi|swagger)(?:[.-]v?\d+(?:\.\d+)*)?\.(?:ya?ml|json)$/.test(basename)) score += 90;
  if (/^(asyncapi)(?:[.-]v?\d+(?:\.\d+)*)?\.(?:ya?ml|json)$/.test(basename)) score += 88;
  if (/^(?:\.?mcp(?:[-.]?(?:config|servers?))?|server)\.json$/.test(basename)) score += 88;
  if (/^(api|oas)(?:[.-]v?\d+(?:\.\d+)*)?\.(?:ya?ml|json)$/.test(basename)) score += 85;
  if (/\.(?:wsdl|wadl|xsd|graphql|gql|proto)$/.test(basename)) score += 70;
  if (/^(api|apis|spec|specs|contracts|reference|public)\//.test(normalized)) score += 20;
  if (/^(services|packages|apps)\/[^/]+\//.test(normalized)) score += 15;
  return score;
}

/**
 * Content-detect all supported native formats regardless of common filename.
 * Returns every valid local candidate in stable order (rank score desc, then lexical).
 * Never first-match selects.
 */
export async function findAllRepoSpecs(
  repoRoot: string,
  options: { outputDirName?: string; maxFileBytes?: number } = {}
): Promise<LocalSpecCandidate[]> {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const { files } = await walkRepoFiles({
    root: repoRoot,
    extraSkipDirs: options.outputDirName ? [options.outputDirName] : [],
    includeFile: isSpecScanCandidate
  });

  const matches: LocalSpecCandidate[] = [];
  for (const file of files) {
    if (file.sizeBytes > maxFileBytes) continue;
    const content = await readFile(file.absolutePath, 'utf8').catch(() => undefined);
    if (content === undefined) continue;

    const basename = path.posix.basename(file.relativePath);
    const detected = detectNativeFormat(content, basename);
    if (!detected) continue;
    try {
      const validated = parseAndValidateNativeSpec(content, detected.format, basename);
      const rankScore = specCandidateScore(file.relativePath);
      const evidence = [`Resolved from repository specification ${file.relativePath}`];
      if (rankScore >= 200) {
        evidence.push('common/direct filename ranking evidence');
      } else if (rankScore < 70) {
        evidence.push('content-detected despite unusual filename');
      }
      matches.push({
        path: file.relativePath,
        format: validated.format,
        rankScore,
        evidence
      });
    } catch {
      // Content looked related but failed validation; skip.
    }
  }

  matches.sort(
    (left, right) =>
      right.rankScore - left.rankScore || left.path.localeCompare(right.path)
  );
  return matches;
}

/** @deprecated Prefer findAllRepoSpecs; retained for runtime compatibility (first ranked candidate). */
export async function findExistingRepoSpec(repoRoot: string): Promise<string | undefined> {
  const match = await findExistingRepoSpecTyped(repoRoot);
  return match?.path;
}

/** Compatibility: returns the top-ranked candidate only. */
export async function findExistingRepoSpecTyped(repoRoot: string): Promise<RepoSpecMatch | undefined> {
  const all = await findAllRepoSpecs(repoRoot);
  const top = all[0];
  if (!top) return undefined;
  return {
    path: top.path,
    format: top.format,
    evidence: top.evidence
  };
}
