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
