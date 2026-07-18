import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
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
