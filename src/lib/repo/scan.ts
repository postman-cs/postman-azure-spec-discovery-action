import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const SKIP_DIRS = new Set([
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
]);

const MAX_FILES = 50;
const MAX_DEPTH = 4;

export async function findIaCFiles(
  root: string,
  extensions: string[],
  depth = 0,
  globalCount = { value: 0 },
): Promise<string[]> {
  if (depth > MAX_DEPTH || globalCount.value >= MAX_FILES) return [];
  const results: string[] = [];

  const entries = await readdir(root).catch(() => [] as string[]);

  for (const entry of entries) {
    if (globalCount.value >= MAX_FILES) break;
    if (SKIP_DIRS.has(entry)) continue;

    const fullPath = path.join(root, entry);
    const info = await stat(fullPath).catch(() => null);
    if (!info) continue;

    if (info.isDirectory()) {
      const sub = await findIaCFiles(fullPath, extensions, depth + 1, globalCount);
      results.push(...sub);
    } else if (extensions.some((ext) => entry.endsWith(ext))) {
      results.push(fullPath);
      globalCount.value++;
    }
  }

  return results;
}
