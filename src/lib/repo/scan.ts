import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_MAX_FILES = 200;
export const DEFAULT_MAX_DEPTH = 6;
export const DEFAULT_MAX_FILE_BYTES = 512 * 1024;

export const DEFAULT_SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.terraform',
  'dist',
  'build',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
  '.pulumi',
  'discovered-specs',
  'coverage',
  '.nyc_output',
  'out',
  'bin',
  'obj',
  'target'
]);

export interface WalkRepoOptions {
  root: string;
  /** Extra directory basenames to skip (e.g. configured output dir). */
  extraSkipDirs?: Iterable<string>;
  maxFiles?: number;
  maxDepth?: number;
  /**
   * When provided, only files matching this predicate are counted/returned.
   * Directories are still walked (subject to skip/symlink/depth rules).
   */
  includeFile?: (relativePosix: string, basename: string) => boolean;
}

export interface RepoFileEntry {
  /** Repo-relative POSIX path. */
  relativePath: string;
  absolutePath: string;
  sizeBytes: number;
}

function toPosix(relativePath: string): string {
  return relativePath.split(path.sep).join('/');
}

function isInsideRoot(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

/**
 * Bounded, deterministic, no-exec repository walk.
 * - Lexical entry order
 * - Depth/file caps
 * - Skips build/vendor/output dirs
 * - Never traverses symlinks (even when realpath stays inside root)
 * - Uses lstat + realpath confinement for roots
 */
export async function walkRepoFiles(options: WalkRepoOptions): Promise<{
  files: RepoFileEntry[];
  truncatedByFileCap: boolean;
  truncatedByDepth: boolean;
}> {
  const resolvedRoot = await realpath(path.resolve(options.root)).catch(() => path.resolve(options.root));
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const skip = new Set(DEFAULT_SKIP_DIRS);
  for (const entry of options.extraSkipDirs ?? []) {
    if (entry.trim()) skip.add(entry.trim());
  }

  const files: RepoFileEntry[] = [];
  let truncatedByFileCap = false;
  let truncatedByDepth = false;

  async function walk(current: string, depth: number): Promise<void> {
    if (files.length >= maxFiles) {
      truncatedByFileCap = true;
      return;
    }
    if (depth > maxDepth) {
      truncatedByDepth = true;
      return;
    }

    const entries = (await readdir(current).catch(() => [] as string[])).sort((a, b) => a.localeCompare(b));
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        truncatedByFileCap = true;
        break;
      }
      if (skip.has(entry)) continue;

      const fullPath = path.join(current, entry);
      const link = await lstat(fullPath).catch(() => undefined);
      if (!link) continue;

      if (link.isSymbolicLink()) {
        // Symlinks are never traversed; confinement check is informational only.
        const real = await realpath(fullPath).catch(() => undefined);
        if (!real || !isInsideRoot(resolvedRoot, real)) {
          continue;
        }
        continue;
      }

      if (link.isDirectory()) {
        if (depth + 1 > maxDepth) {
          truncatedByDepth = true;
          continue;
        }
        await walk(fullPath, depth + 1);
        continue;
      }

      if (!link.isFile()) continue;
      const relativePath = toPosix(path.relative(resolvedRoot, fullPath));
      if (options.includeFile && !options.includeFile(relativePath, entry)) continue;

      files.push({
        relativePath,
        absolutePath: fullPath,
        sizeBytes: link.size
      });
    }
  }

  await walk(resolvedRoot, 0);
  return { files, truncatedByFileCap, truncatedByDepth };
}

/**
 * Compatibility helper used by catalog/signals. Upgraded to R3 bounds (depth 6 / 200 files),
 * lexical order, symlink non-traversal, and skipped vendor/build dirs.
 */
export async function findIaCFiles(
  root: string,
  extensions: string[],
  _depth = 0,
  _globalCount = { value: 0 }
): Promise<string[]> {
  void _depth;
  void _globalCount;
  const normalizedExts = extensions.map((ext) => (ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`));
  const { files } = await walkRepoFiles({
    root,
    includeFile: (_relative, basename) => {
      const lower = basename.toLowerCase();
      return normalizedExts.some((ext) => lower.endsWith(ext));
    }
  });
  return files.map((file) => file.absolutePath);
}
