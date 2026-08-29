import { constants } from 'node:fs';
import { lstat, mkdir, open, stat } from 'node:fs/promises';
import path from 'node:path';

export function resolvePathWithinRoot(rootPath: string, targetPath: string, fieldName: string): string {
  const base = path.resolve(rootPath);
  const resolved = path.resolve(base, targetPath);
  const relative = path.relative(base, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${fieldName} must stay within repo-root/workspace; received ${targetPath}`);
  }
  return resolved;
}

export async function assertNoSymlinkEscape(rootPath: string, targetPath: string, fieldName: string): Promise<string> {
  const root = path.resolve(rootPath);
  const resolved = resolvePathWithinRoot(root, targetPath, fieldName);
  const relativeTarget = path.relative(root, resolved);
  let current = root;
  for (const component of relativeTarget.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error(
          `${fieldName} must stay within repo-root/workspace and must not traverse symbolic links; received ${targetPath}`
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
  }
  return resolved;
}

/**
 * Open and bind a repository read to the checked regular file. Re-validating
 * the path against the open handle closes final-component swaps and detects an
 * intermediate-directory swap before any bytes are consumed.
 */
export async function readUtf8FileWithinRoot(
  rootPath: string,
  targetPath: string,
  fieldName: string,
  maxBytes?: number
): Promise<string> {
  const resolved = await assertNoSymlinkEscape(rootPath, targetPath, fieldName);
  const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const openedStat = await handle.stat();
    if (!openedStat.isFile()) {
      throw new Error(`${fieldName} must identify a regular file; received ${targetPath}`);
    }
    if (maxBytes !== undefined && openedStat.size > maxBytes) {
      throw new Error(`${fieldName} exceeds the ${maxBytes}-byte read limit`);
    }

    await assertNoSymlinkEscape(rootPath, targetPath, fieldName);
    const currentStat = await stat(resolved);
    if (openedStat.dev !== currentStat.dev || openedStat.ino !== currentStat.ino) {
      throw new Error(`${fieldName} changed while its confined path was being opened`);
    }

    if (maxBytes === undefined) {
      return await handle.readFile({ encoding: 'utf8' });
    }
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - totalBytes));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      totalBytes += bytesRead;
    }
    if (totalBytes > maxBytes) {
      throw new Error(`${fieldName} exceeds the ${maxBytes}-byte read limit`);
    }
    return Buffer.concat(chunks, totalBytes).toString('utf8');
  } finally {
    await handle.close();
  }
}

export async function writeFileWithinRoot(
  rootPath: string,
  targetPath: string,
  content: string,
  fieldName: string
): Promise<void> {
  const resolved = resolvePathWithinRoot(rootPath, targetPath, fieldName);
  await assertNoSymlinkEscape(rootPath, targetPath, fieldName);
  await mkdir(path.dirname(resolved), { recursive: true });
  await assertNoSymlinkEscape(rootPath, targetPath, fieldName);
  const handle = await open(
    resolved,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o666
  );
  try {
    await handle.writeFile(content, 'utf8');
  } finally {
    await handle.close();
  }
}
