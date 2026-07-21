import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildDefinitionFileInventory,
  serializeDefinitionFileInventory,
  sha256HexOfUtf8
} from '../src/lib/spec/definition-file-inventory.js';
import {
  buildRepoNativeExportBundle,
  NATIVE_CLOSURE_LIMITS,
  resolveNativeClosureLimits,
  resolveRepoNativeDependencyCompanions
} from '../src/lib/repo/native-dependency-bundle.js';
import {
  execute,
  resolveInputs,
  type AzureDependencies,
  type ReporterLike
} from '../src/runtime.js';
import { runCli } from '../src/cli.js';
import type { SpecCandidate, SpecProvider } from '../src/lib/providers/types.js';

async function snapshotTree(rootDir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(current: string, relative: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const childRel = relative ? `${relative}/${entry.name}` : entry.name;
      const childAbs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(childAbs, childRel);
      } else if (entry.isFile()) {
        out.set(childRel.split(path.sep).join('/'), await readFile(childAbs, 'utf8'));
      }
    }
  }
  await walk(rootDir, '');
  return out;
}

async function assertNoStageOrBackupResidue(outputParent: string): Promise<void> {
  const entries = await readdir(outputParent);
  const residue = entries.filter(
    (entry) => entry.includes('.stage-') || entry.includes('.backup-')
  );
  expect(residue).toEqual([]);
}

const PROTO_WITH_IMPORT = `syntax = "proto3";
package demo;
import "common.proto";
service Greeter { rpc Ping (Empty) returns (Empty); }
message Empty {}
`;

const PROTO_COMMON = `syntax = "proto3";
package demo;
message Shared { string id = 1; }
`;

const PROTO_COMMON_TRANSITIVE = `syntax = "proto3";
package demo;
import "shared.proto";
message Shared { string id = 1; }
`;

const PROTO_SHARED = `syntax = "proto3";
package demo;
message SharedLeaf { string id = 1; }
`;

const PROTO_OUTSIDE_SECRET = `syntax = "proto3";
package evil;
message OutsideSecret { string leak = 1; }
`;

/** Circular protobuf: root → dependency → root (each unique member once). */
const PROTO_CIRCULAR_ROOT = `syntax = "proto3";
package demo;
import "common.proto";
service Greeter { rpc Ping (Empty) returns (Empty); }
message Empty {}
`;

const PROTO_CIRCULAR_DEP = `syntax = "proto3";
package demo;
import "service.proto";
message Shared { string id = 1; }
`;

const WSDL_WITH_XSD = `<?xml version="1.0"?>
<definitions xmlns="http://schemas.xmlsoap.org/wsdl/"
             xmlns:xsd="http://www.w3.org/2001/XMLSchema" name="Pay">
  <types>
    <xsd:schema>
      <xsd:import namespace="urn:pay" schemaLocation="types.xsd"/>
    </xsd:schema>
  </types>
  <portType name="PayPort"/>
</definitions>`;

const XSD_TYPES = `<?xml version="1.0"?>
<schema xmlns="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:pay">
  <element name="Amount" type="string"/>
</schema>`;

const XSD_TYPES_TRANSITIVE = `<?xml version="1.0"?>
<schema xmlns="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:pay">
  <include schemaLocation="common.xsd"/>
  <element name="Amount" type="string"/>
</schema>`;

const XSD_COMMON = `<?xml version="1.0"?>
<schema xmlns="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:pay">
  <element name="Currency" type="string"/>
</schema>`;

/** Circular WSDL/XSD: root → types.xsd → root (each unique member once). */
const XSD_CIRCULAR_TYPES = `<?xml version="1.0"?>
<schema xmlns="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:pay">
  <import namespace="urn:pay-wsdl" schemaLocation="service.wsdl"/>
  <element name="Amount" type="string"/>
</schema>`;

const XSD_OUTSIDE_SECRET = `<?xml version="1.0"?>
<schema xmlns="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:evil">
  <element name="OutsideSecret" type="string"/>
</schema>`;

function reporter(): ReporterLike {
  return {
    group: async (_name, fn) => fn(),
    info: () => undefined,
    warning: () => undefined
  };
}

function baseDeps(repoRoot: string, providers: SpecProvider[] = []): AzureDependencies {
  return {
    core: reporter(),
    subscriptions: {
      get: vi.fn(async (subscriptionId: string) => ({ subscriptionId, state: 'Enabled' })),
      list: vi.fn(async () => [{ subscriptionId: 'sub-1', state: 'Enabled' }])
    },
    createApimClient: () => {
      throw new Error('unused');
    },
    createAppServiceClient: () => {
      throw new Error('unused');
    },
    writeSpecFile: async (outputPath, content, rootPath) => {
      const { defaultWriteSpecFile } = await import('../src/runtime.js');
      await defaultWriteSpecFile(outputPath, content, rootPath);
    },
    providers
  };
}

async function writeNativeBinding(repoRoot: string, nativeSpecPath: string): Promise<void> {
  await mkdir(path.join(repoRoot, '.postman'), { recursive: true });
  await writeFile(
    path.join(repoRoot, '.postman', 'resources.yaml'),
    `azure:\n  nativeSpecPath: ${nativeSpecPath}\n`,
    'utf8'
  );
}

describe('definition-file-inventory schema', () => {
  it('builds exact PRD inventory with sorted workspace-relative paths and no content', () => {
    const inventory = buildDefinitionFileInventory({
      rootPath: 'discovered-specs/payments/service.proto',
      format: 'protobuf',
      completeness: 'full',
      members: [
        {
          path: 'discovered-specs/payments/service.proto',
          role: 'root',
          content: PROTO_WITH_IMPORT
        },
        {
          path: 'discovered-specs/payments/common.proto',
          role: 'dependency',
          content: PROTO_COMMON
        }
      ]
    });
    expect(inventory).toBeDefined();
    expect(inventory).toMatchObject({
      schemaVersion: 1,
      root: 'discovered-specs/payments/service.proto',
      format: 'protobuf',
      completeness: 'full',
      provenance: { kind: 'provider', provider: 'azure' }
    });
    expect(inventory!.files.map((file) => file.path)).toEqual([
      'discovered-specs/payments/common.proto',
      'discovered-specs/payments/service.proto'
    ]);
    expect(inventory!.files[0]).toEqual({
      path: 'discovered-specs/payments/common.proto',
      role: 'dependency',
      bytes: Buffer.byteLength(PROTO_COMMON, 'utf8'),
      sha256: sha256HexOfUtf8(PROTO_COMMON)
    });
    const serialized = serializeDefinitionFileInventory(inventory);
    expect(serialized.includes('\n')).toBe(false);
    expect(serialized).not.toContain('syntax =');
    expect(JSON.parse(serialized).files[0].content).toBeUndefined();
  });

  it('returns undefined for single-file and partial sets', () => {
    expect(
      buildDefinitionFileInventory({
        rootPath: 'discovered-specs/payments/service.proto',
        format: 'protobuf',
        completeness: 'full',
        members: [
          { path: 'discovered-specs/payments/service.proto', role: 'root', content: PROTO_COMMON }
        ]
      })
    ).toBeUndefined();
    expect(
      buildDefinitionFileInventory({
        rootPath: 'discovered-specs/payments/service.proto',
        format: 'protobuf',
        completeness: 'partial',
        members: [
          { path: 'discovered-specs/payments/service.proto', role: 'root', content: PROTO_WITH_IMPORT },
          { path: 'discovered-specs/payments/common.proto', role: 'dependency', content: PROTO_COMMON }
        ]
      })
    ).toBeUndefined();
  });
});

describe('production-wires repo native bundle', () => {
  it('exports a complete sibling-import proto set with inventory', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'az-inv-proto-'));
    await writeFile(path.join(repoRoot, 'service.proto'), PROTO_WITH_IMPORT);
    await writeFile(path.join(repoRoot, 'common.proto'), PROTO_COMMON);
    await writeNativeBinding(repoRoot, 'service.proto');

    const result = await execute(
      resolveInputs({ INPUT_REPO_ROOT: repoRoot, INPUT_EXPECTED_SERVICE_NAME: 'payments' }),
      baseDeps(repoRoot)
    );

    expect(result.resolution?.status).toBe('resolved');
    expect(result.resolution?.sourceType).toBe('repo-spec');
    expect(result.resolution?.specPath).toBe('discovered-specs/payments/service.proto');
    expect(result.outputs['spec-path']).toBe('discovered-specs/payments/service.proto');
    expect(result.outputs['spec-files-json']).not.toBe('');
    const inventory = JSON.parse(result.outputs['spec-files-json']!) as {
      root: string;
      completeness: string;
      files: Array<{ path: string; role: string; bytes: number; sha256: string }>;
    };
    expect(inventory).toMatchObject({
      schemaVersion: 1,
      root: 'discovered-specs/payments/service.proto',
      format: 'protobuf',
      completeness: 'full',
      provenance: { kind: 'provider', provider: 'azure' }
    });
    expect(inventory.files.map((file) => file.path)).toEqual([
      'discovered-specs/payments/common.proto',
      'discovered-specs/payments/service.proto'
    ]);
    const rootBytes = await readFile(path.join(repoRoot, 'discovered-specs/payments/service.proto'), 'utf8');
    const depBytes = await readFile(path.join(repoRoot, 'discovered-specs/payments/common.proto'), 'utf8');
    expect(rootBytes).toBe(PROTO_WITH_IMPORT);
    expect(depBytes).toBe(PROTO_COMMON);
    expect(inventory.files.find((file) => file.role === 'root')?.sha256).toBe(
      createHash('sha256').update(rootBytes, 'utf8').digest('hex')
    );
  });

  it('exports a complete sibling-import WSDL/XSD set with inventory', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'az-inv-wsdl-'));
    await writeFile(path.join(repoRoot, 'service.wsdl'), WSDL_WITH_XSD);
    await writeFile(path.join(repoRoot, 'types.xsd'), XSD_TYPES);
    await writeNativeBinding(repoRoot, 'service.wsdl');

    const result = await execute(
      resolveInputs({ INPUT_REPO_ROOT: repoRoot, INPUT_EXPECTED_SERVICE_NAME: 'payments' }),
      baseDeps(repoRoot)
    );

    expect(result.resolution?.status).toBe('resolved');
    expect(result.outputs['spec-path']).toBe('discovered-specs/payments/service.wsdl');
    const inventory = JSON.parse(result.outputs['spec-files-json']!);
    expect(inventory.files.map((file: { path: string }) => file.path)).toEqual([
      'discovered-specs/payments/service.wsdl',
      'discovered-specs/payments/types.xsd'
    ]);
    expect(await readFile(path.join(repoRoot, 'discovered-specs/payments/types.xsd'), 'utf8')).toBe(XSD_TYPES);
  });

  it('incomplete blank output for unresolved proto import', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'az-inv-incomplete-'));
    await writeFile(path.join(repoRoot, 'service.proto'), PROTO_WITH_IMPORT);
    await writeNativeBinding(repoRoot, 'service.proto');

    const result = await execute(
      resolveInputs({ INPUT_REPO_ROOT: repoRoot, INPUT_EXPECTED_SERVICE_NAME: 'payments' }),
      baseDeps(repoRoot)
    );

    expect(result.resolution?.status).toBe('unresolved');
    expect(result.resolution?.sourceType).toBe('manual-review');
    expect(result.resolution?.contractClass).toBe('partial');
    expect(result.outputs['spec-path']).toBe('');
    expect(result.outputs['spec-files-json']).toBe('');
  });

  it('dependency-free root over production byte ceiling is unresolved/manual before reading bytes', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'az-inv-root-oversize-'));
    const relativePath = 'service.proto';
    const absolutePath = path.join(repoRoot, relativePath);
    // Sparse truncate: logical size > production ceiling without allocating 25 MiB+.
    const handle = await open(absolutePath, 'w');
    try {
      await handle.truncate(NATIVE_CLOSURE_LIMITS.maxBytesPerFile + 1);
    } finally {
      await handle.close();
    }
    await writeNativeBinding(repoRoot, relativePath);

    const result = await execute(
      resolveInputs({ INPUT_REPO_ROOT: repoRoot, INPUT_EXPECTED_SERVICE_NAME: 'payments' }),
      baseDeps(repoRoot)
    );

    // Pre-read reject: sparse zeros would throw on parse if readFile ran first.
    expect(result.resolution?.status).toBe('unresolved');
    expect(result.resolution?.sourceType).toBe('manual-review');
    expect(result.resolution?.contractClass).toBe('partial');
    expect(result.outputs['spec-path']).toBe('');
    expect(result.outputs['spec-files-json']).toBe('');
    expect((result.resolution?.evidence ?? []).join(' ')).toMatch(/byte ceiling/i);
    const outputDir = path.join(repoRoot, 'discovered-specs');
    const tree = await snapshotTree(outputDir).catch(() => new Map<string, string>());
    expect(tree.size).toBe(0);
  });

  it('rejects root nativeSpecPath symlink escape without reading outside bytes', async () => {
    const sandbox = await mkdtemp(path.join(tmpdir(), 'az-inv-root-symlink-'));
    const repoRoot = path.join(sandbox, 'repo');
    const outside = path.join(sandbox, 'outside');
    await mkdir(repoRoot, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, 'secret.proto'), PROTO_OUTSIDE_SECRET);
    await symlink(path.join(outside, 'secret.proto'), path.join(repoRoot, 'service.proto'));
    await writeNativeBinding(repoRoot, 'service.proto');

    await expect(
      execute(
        resolveInputs({ INPUT_REPO_ROOT: repoRoot, INPUT_EXPECTED_SERVICE_NAME: 'payments' }),
        baseDeps(repoRoot)
      )
    ).rejects.toThrow(/symbolic link/i);

    const outputDir = path.join(repoRoot, 'discovered-specs');
    const tree = await snapshotTree(outputDir).catch(() => new Map<string, string>());
    const joined = [...tree.values()].join('\n');
    expect(joined).not.toContain('OutsideSecret');
    expect(joined).not.toContain(PROTO_OUTSIDE_SECRET);
  });

  it('dependency symlink escape stays partial/manual with blank outputs and no outside bytes', async () => {
    const sandbox = await mkdtemp(path.join(tmpdir(), 'az-inv-dep-symlink-'));
    const repoRoot = path.join(sandbox, 'repo');
    const outside = path.join(sandbox, 'outside');
    await mkdir(repoRoot, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(repoRoot, 'service.proto'), PROTO_WITH_IMPORT);
    await writeFile(path.join(outside, 'secret.proto'), PROTO_OUTSIDE_SECRET);
    await symlink(path.join(outside, 'secret.proto'), path.join(repoRoot, 'common.proto'));
    await writeNativeBinding(repoRoot, 'service.proto');

    const result = await execute(
      resolveInputs({ INPUT_REPO_ROOT: repoRoot, INPUT_EXPECTED_SERVICE_NAME: 'payments' }),
      baseDeps(repoRoot)
    );

    expect(result.resolution?.status).toBe('unresolved');
    expect(result.resolution?.sourceType).toBe('manual-review');
    expect(result.resolution?.contractClass).toBe('partial');
    expect(result.outputs['spec-path']).toBe('');
    expect(result.outputs['spec-files-json']).toBe('');
    const evidence = (result.resolution?.evidence ?? []).join(' ');
    expect(evidence).not.toContain('OutsideSecret');
    const outputDir = path.join(repoRoot, 'discovered-specs');
    const tree = await snapshotTree(outputDir).catch(() => new Map<string, string>());
    expect([...tree.values()].join('\n')).not.toContain('OutsideSecret');
  });

  it('inventories complete transitive protobuf closure', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'az-inv-proto-transitive-'));
    await writeFile(path.join(repoRoot, 'service.proto'), PROTO_WITH_IMPORT);
    await writeFile(path.join(repoRoot, 'common.proto'), PROTO_COMMON_TRANSITIVE);
    await writeFile(path.join(repoRoot, 'shared.proto'), PROTO_SHARED);
    await writeNativeBinding(repoRoot, 'service.proto');

    const result = await execute(
      resolveInputs({ INPUT_REPO_ROOT: repoRoot, INPUT_EXPECTED_SERVICE_NAME: 'payments' }),
      baseDeps(repoRoot)
    );

    expect(result.resolution?.status).toBe('resolved');
    expect(result.outputs['spec-files-json']).not.toBe('');
    const inventory = JSON.parse(result.outputs['spec-files-json']!) as {
      completeness: string;
      files: Array<{ path: string }>;
    };
    expect(inventory.completeness).toBe('full');
    expect(inventory.files.map((file) => file.path).sort()).toEqual([
      'discovered-specs/payments/common.proto',
      'discovered-specs/payments/service.proto',
      'discovered-specs/payments/shared.proto'
    ]);
    expect(await readFile(path.join(repoRoot, 'discovered-specs/payments/shared.proto'), 'utf8')).toBe(
      PROTO_SHARED
    );
    expect(await readFile(path.join(repoRoot, 'discovered-specs/payments/common.proto'), 'utf8')).toBe(
      PROTO_COMMON_TRANSITIVE
    );
  });

  it('missing transitive protobuf ref blanks outputs as partial/manual', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'az-inv-proto-transitive-miss-'));
    await writeFile(path.join(repoRoot, 'service.proto'), PROTO_WITH_IMPORT);
    await writeFile(path.join(repoRoot, 'common.proto'), PROTO_COMMON_TRANSITIVE);
    await writeNativeBinding(repoRoot, 'service.proto');

    const result = await execute(
      resolveInputs({ INPUT_REPO_ROOT: repoRoot, INPUT_EXPECTED_SERVICE_NAME: 'payments' }),
      baseDeps(repoRoot)
    );

    expect(result.resolution?.status).toBe('unresolved');
    expect(result.resolution?.sourceType).toBe('manual-review');
    expect(result.resolution?.contractClass).toBe('partial');
    expect(result.outputs['spec-path']).toBe('');
    expect(result.outputs['spec-files-json']).toBe('');
    expect((result.resolution?.evidence ?? []).join(' ')).toMatch(/shared\.proto|transitive/i);
  });

  it('inventories complete transitive WSDL/XSD closure', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'az-inv-wsdl-transitive-'));
    await writeFile(path.join(repoRoot, 'service.wsdl'), WSDL_WITH_XSD);
    await writeFile(path.join(repoRoot, 'types.xsd'), XSD_TYPES_TRANSITIVE);
    await writeFile(path.join(repoRoot, 'common.xsd'), XSD_COMMON);
    await writeNativeBinding(repoRoot, 'service.wsdl');

    const result = await execute(
      resolveInputs({ INPUT_REPO_ROOT: repoRoot, INPUT_EXPECTED_SERVICE_NAME: 'payments' }),
      baseDeps(repoRoot)
    );

    expect(result.resolution?.status).toBe('resolved');
    const inventory = JSON.parse(result.outputs['spec-files-json']!) as {
      completeness: string;
      files: Array<{ path: string }>;
    };
    expect(inventory.completeness).toBe('full');
    expect(inventory.files.map((file) => file.path).sort()).toEqual([
      'discovered-specs/payments/common.xsd',
      'discovered-specs/payments/service.wsdl',
      'discovered-specs/payments/types.xsd'
    ]);
    expect(await readFile(path.join(repoRoot, 'discovered-specs/payments/common.xsd'), 'utf8')).toBe(
      XSD_COMMON
    );
  });

  it('missing transitive WSDL/XSD ref blanks outputs as partial/manual', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'az-inv-wsdl-transitive-miss-'));
    await writeFile(path.join(repoRoot, 'service.wsdl'), WSDL_WITH_XSD);
    await writeFile(path.join(repoRoot, 'types.xsd'), XSD_TYPES_TRANSITIVE);
    await writeNativeBinding(repoRoot, 'service.wsdl');

    const result = await execute(
      resolveInputs({ INPUT_REPO_ROOT: repoRoot, INPUT_EXPECTED_SERVICE_NAME: 'payments' }),
      baseDeps(repoRoot)
    );

    expect(result.resolution?.status).toBe('unresolved');
    expect(result.resolution?.sourceType).toBe('manual-review');
    expect(result.resolution?.contractClass).toBe('partial');
    expect(result.outputs['spec-path']).toBe('');
    expect(result.outputs['spec-files-json']).toBe('');
  });

  it('WSDL dependency symlink escape stays blank/partial without materializing outside XSD', async () => {
    const sandbox = await mkdtemp(path.join(tmpdir(), 'az-inv-wsdl-dep-symlink-'));
    const repoRoot = path.join(sandbox, 'repo');
    const outside = path.join(sandbox, 'outside');
    await mkdir(repoRoot, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(repoRoot, 'service.wsdl'), WSDL_WITH_XSD);
    await writeFile(path.join(outside, 'secret.xsd'), XSD_OUTSIDE_SECRET);
    await symlink(path.join(outside, 'secret.xsd'), path.join(repoRoot, 'types.xsd'));
    await writeNativeBinding(repoRoot, 'service.wsdl');

    const result = await execute(
      resolveInputs({ INPUT_REPO_ROOT: repoRoot, INPUT_EXPECTED_SERVICE_NAME: 'payments' }),
      baseDeps(repoRoot)
    );

    expect(result.resolution?.status).toBe('unresolved');
    expect(result.outputs['spec-path']).toBe('');
    expect(result.outputs['spec-files-json']).toBe('');
    const outputDir = path.join(repoRoot, 'discovered-specs');
    const tree = await snapshotTree(outputDir).catch(() => new Map<string, string>());
    expect([...tree.values()].join('\n')).not.toContain('OutsideSecret');
  });

  it('circular protobuf root→dep→root inventories each unique member once without duplicating root', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'az-inv-proto-cycle-'));
    await writeFile(path.join(repoRoot, 'service.proto'), PROTO_CIRCULAR_ROOT);
    await writeFile(path.join(repoRoot, 'common.proto'), PROTO_CIRCULAR_DEP);
    await writeNativeBinding(repoRoot, 'service.proto');

    const result = await execute(
      resolveInputs({ INPUT_REPO_ROOT: repoRoot, INPUT_EXPECTED_SERVICE_NAME: 'payments' }),
      baseDeps(repoRoot)
    );

    expect(result.resolution?.status).toBe('resolved');
    expect(result.outputs['spec-files-json']).not.toBe('');
    const inventory = JSON.parse(result.outputs['spec-files-json']!) as {
      completeness: string;
      root: string;
      files: Array<{ path: string; role: string }>;
    };
    expect(inventory.completeness).toBe('full');
    expect(inventory.files.map((file) => file.path).sort()).toEqual([
      'discovered-specs/payments/common.proto',
      'discovered-specs/payments/service.proto'
    ]);
    expect(inventory.files.filter((file) => file.role === 'root')).toEqual([
      expect.objectContaining({ path: 'discovered-specs/payments/service.proto', role: 'root' })
    ]);
    expect(inventory.files.filter((file) => file.role === 'dependency')).toEqual([
      expect.objectContaining({ path: 'discovered-specs/payments/common.proto', role: 'dependency' })
    ]);
    expect(inventory.files.filter((file) => file.path.endsWith('service.proto'))).toHaveLength(1);
    expect(await readFile(path.join(repoRoot, 'discovered-specs/payments/common.proto'), 'utf8')).toBe(
      PROTO_CIRCULAR_DEP
    );
  });

  it('circular WSDL/XSD root→dep→root inventories each unique member once without duplicating root', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'az-inv-wsdl-cycle-'));
    await writeFile(path.join(repoRoot, 'service.wsdl'), WSDL_WITH_XSD);
    await writeFile(path.join(repoRoot, 'types.xsd'), XSD_CIRCULAR_TYPES);
    await writeNativeBinding(repoRoot, 'service.wsdl');

    const result = await execute(
      resolveInputs({ INPUT_REPO_ROOT: repoRoot, INPUT_EXPECTED_SERVICE_NAME: 'payments' }),
      baseDeps(repoRoot)
    );

    expect(result.resolution?.status).toBe('resolved');
    const inventory = JSON.parse(result.outputs['spec-files-json']!) as {
      completeness: string;
      files: Array<{ path: string; role: string }>;
    };
    expect(inventory.completeness).toBe('full');
    expect(inventory.files.map((file) => file.path).sort()).toEqual([
      'discovered-specs/payments/service.wsdl',
      'discovered-specs/payments/types.xsd'
    ]);
    expect(inventory.files.filter((file) => file.role === 'root')).toEqual([
      expect.objectContaining({ path: 'discovered-specs/payments/service.wsdl', role: 'root' })
    ]);
    expect(inventory.files.filter((file) => file.role === 'dependency')).toEqual([
      expect.objectContaining({ path: 'discovered-specs/payments/types.xsd', role: 'dependency' })
    ]);
    expect(inventory.files.filter((file) => file.path.endsWith('service.wsdl'))).toHaveLength(1);
  });
});

describe('native closure PRD/bootstrap limits', () => {
  it('defaults match bootstrap bundle contract and cannot be raised', () => {
    expect(NATIVE_CLOSURE_LIMITS).toEqual({
      maxFiles: 101,
      maxDepth: 20,
      maxBytesPerFile: 25 * 1024 * 1024,
      maxTotalBytes: 25 * 1024 * 1024
    });
    expect(resolveNativeClosureLimits({ maxFiles: 10_000, maxDepth: 99 })).toEqual(NATIVE_CLOSURE_LIMITS);
    expect(resolveNativeClosureLimits({ maxFiles: 3, maxDepth: 2 })).toMatchObject({
      maxFiles: 3,
      maxDepth: 2
    });
  });

  it('allows exactly maxFiles including root and marks maxFiles+1 partial/blank', async () => {
    const atCapRoot = await mkdtemp(path.join(tmpdir(), 'az-closure-count-cap-'));
    // maxFiles=3 => root + 2 companions; injectable so we avoid allocating 101 fixtures.
    const atCapPrimary =
      'syntax = "proto3";\nimport "a.proto";\nimport "b.proto";\nmessage Root {}\n';
    await writeFile(path.join(atCapRoot, 'service.proto'), atCapPrimary);
    await writeFile(path.join(atCapRoot, 'a.proto'), 'syntax = "proto3";\nmessage A {}\n');
    await writeFile(path.join(atCapRoot, 'b.proto'), 'syntax = "proto3";\nmessage B {}\n');
    const atCap = await buildRepoNativeExportBundle({
      repoRoot: atCapRoot,
      primaryRelativePath: 'service.proto',
      primaryContent: atCapPrimary,
      format: 'protobuf',
      limits: { maxFiles: 3 }
    });
    expect(atCap.completeness).toBe('full');
    expect(atCap.contractClass).toBe('authoritative');
    expect(atCap.artifacts?.map((a) => a.relativePath).sort()).toEqual(['a.proto', 'b.proto']);

    const overRoot = await mkdtemp(path.join(tmpdir(), 'az-closure-count-over-'));
    const overPrimary =
      'syntax = "proto3";\nimport "a.proto";\nimport "b.proto";\nimport "c.proto";\nmessage Root {}\n';
    await writeFile(path.join(overRoot, 'service.proto'), overPrimary);
    await writeFile(path.join(overRoot, 'a.proto'), 'syntax = "proto3";\nmessage A {}\n');
    await writeFile(path.join(overRoot, 'b.proto'), 'syntax = "proto3";\nmessage B {}\n');
    await writeFile(path.join(overRoot, 'c.proto'), 'syntax = "proto3";\nmessage C {}\n');
    const overCompanions = await resolveRepoNativeDependencyCompanions({
      repoRoot: overRoot,
      primaryRelativePath: 'service.proto',
      primaryContent: overPrimary,
      format: 'protobuf',
      limits: { maxFiles: 3 }
    });
    expect(overCompanions.missingRefs.length).toBeGreaterThan(0);
    expect(1 + overCompanions.artifacts.length).toBe(3);

    const overBundle = await buildRepoNativeExportBundle({
      repoRoot: overRoot,
      primaryRelativePath: 'service.proto',
      primaryContent: overPrimary,
      format: 'protobuf',
      limits: { maxFiles: 3 }
    });
    expect(overBundle.completeness).toBe('partial');
    expect(overBundle.contractClass).toBe('partial');
    expect(overBundle.artifacts).toBeUndefined();
  });

  it('cycle/duplicate at exact unique-file cap remains full; true unique over-limit stays partial', async () => {
    // maxFiles=2 => root + 1 companion. Cycle back to root must not consume the cap.
    const cycleCapRoot = await mkdtemp(path.join(tmpdir(), 'az-closure-cycle-cap-'));
    const cyclePrimary = 'syntax = "proto3";\nimport "a.proto";\nmessage Root {}\n';
    const cycleDep =
      'syntax = "proto3";\nimport "service.proto";\nmessage A {}\n';
    await writeFile(path.join(cycleCapRoot, 'service.proto'), cyclePrimary);
    await writeFile(path.join(cycleCapRoot, 'a.proto'), cycleDep);
    const cycleCompanions = await resolveRepoNativeDependencyCompanions({
      repoRoot: cycleCapRoot,
      primaryRelativePath: 'service.proto',
      primaryContent: cyclePrimary,
      format: 'protobuf',
      limits: { maxFiles: 2 }
    });
    expect(cycleCompanions.missingRefs).toEqual([]);
    expect(cycleCompanions.artifacts.map((a) => a.relativePath)).toEqual(['a.proto']);
    const cycleBundle = await buildRepoNativeExportBundle({
      repoRoot: cycleCapRoot,
      primaryRelativePath: 'service.proto',
      primaryContent: cyclePrimary,
      format: 'protobuf',
      limits: { maxFiles: 2 }
    });
    expect(cycleBundle.completeness).toBe('full');
    expect(cycleBundle.contractClass).toBe('authoritative');
    expect(cycleBundle.artifacts?.map((a) => a.relativePath)).toEqual(['a.proto']);

    // Same unique count with an extra duplicate import edge still full under the cap.
    const dupCapRoot = await mkdtemp(path.join(tmpdir(), 'az-closure-dup-cap-'));
    const dupPrimary =
      'syntax = "proto3";\nimport "a.proto";\nimport "a.proto";\nmessage Root {}\n';
    await writeFile(path.join(dupCapRoot, 'service.proto'), dupPrimary);
    await writeFile(
      path.join(dupCapRoot, 'a.proto'),
      'syntax = "proto3";\nimport "service.proto";\nimport "a.proto";\nmessage A {}\n'
    );
    const dupBundle = await buildRepoNativeExportBundle({
      repoRoot: dupCapRoot,
      primaryRelativePath: 'service.proto',
      primaryContent: dupPrimary,
      format: 'protobuf',
      limits: { maxFiles: 2 }
    });
    expect(dupBundle.completeness).toBe('full');
    expect(dupBundle.artifacts?.map((a) => a.relativePath)).toEqual(['a.proto']);

    // Cycle must not false-positive depth either: hop back to root past maxDepth is ignored.
    const depthCycleRoot = await mkdtemp(path.join(tmpdir(), 'az-closure-depth-cycle-'));
    await writeFile(path.join(depthCycleRoot, 'service.proto'), cyclePrimary);
    await writeFile(path.join(depthCycleRoot, 'a.proto'), cycleDep);
    const depthCycleBundle = await buildRepoNativeExportBundle({
      repoRoot: depthCycleRoot,
      primaryRelativePath: 'service.proto',
      primaryContent: cyclePrimary,
      format: 'protobuf',
      limits: { maxDepth: 1 }
    });
    expect(depthCycleBundle.completeness).toBe('full');
    expect(depthCycleBundle.artifacts?.map((a) => a.relativePath)).toEqual(['a.proto']);

    // True 102nd-unique-member behavior (here: 3rd unique under maxFiles=2) stays partial.
    const overUniqueRoot = await mkdtemp(path.join(tmpdir(), 'az-closure-unique-over-'));
    const overPrimary =
      'syntax = "proto3";\nimport "a.proto";\nimport "b.proto";\nmessage Root {}\n';
    await writeFile(path.join(overUniqueRoot, 'service.proto'), overPrimary);
    await writeFile(
      path.join(overUniqueRoot, 'a.proto'),
      'syntax = "proto3";\nimport "service.proto";\nmessage A {}\n'
    );
    await writeFile(path.join(overUniqueRoot, 'b.proto'), 'syntax = "proto3";\nmessage B {}\n');
    const overUnique = await buildRepoNativeExportBundle({
      repoRoot: overUniqueRoot,
      primaryRelativePath: 'service.proto',
      primaryContent: overPrimary,
      format: 'protobuf',
      limits: { maxFiles: 2 }
    });
    expect(overUnique.completeness).toBe('partial');
    expect(overUnique.contractClass).toBe('partial');
    expect(overUnique.artifacts).toBeUndefined();
  });

  it('allows depth maxDepth and marks depth maxDepth+1 partial/blank', async () => {
    const atCapRoot = await mkdtemp(path.join(tmpdir(), 'az-closure-depth-cap-'));
    // depth 2: service -> a (1) -> b (2)
    const atCapPrimary = 'syntax = "proto3";\nimport "a.proto";\nmessage Root {}\n';
    await writeFile(path.join(atCapRoot, 'service.proto'), atCapPrimary);
    await writeFile(
      path.join(atCapRoot, 'a.proto'),
      'syntax = "proto3";\nimport "b.proto";\nmessage A {}\n'
    );
    await writeFile(path.join(atCapRoot, 'b.proto'), 'syntax = "proto3";\nmessage B {}\n');
    const atCap = await buildRepoNativeExportBundle({
      repoRoot: atCapRoot,
      primaryRelativePath: 'service.proto',
      primaryContent: atCapPrimary,
      format: 'protobuf',
      limits: { maxDepth: 2 }
    });
    expect(atCap.completeness).toBe('full');
    expect(atCap.artifacts?.map((a) => a.relativePath).sort()).toEqual(['a.proto', 'b.proto']);

    const overRoot = await mkdtemp(path.join(tmpdir(), 'az-closure-depth-over-'));
    // depth 3: service -> a (1) -> b (2) -> c (3) exceeds maxDepth=2
    const overPrimary = 'syntax = "proto3";\nimport "a.proto";\nmessage Root {}\n';
    await writeFile(path.join(overRoot, 'service.proto'), overPrimary);
    await writeFile(
      path.join(overRoot, 'a.proto'),
      'syntax = "proto3";\nimport "b.proto";\nmessage A {}\n'
    );
    await writeFile(
      path.join(overRoot, 'b.proto'),
      'syntax = "proto3";\nimport "c.proto";\nmessage B {}\n'
    );
    await writeFile(path.join(overRoot, 'c.proto'), 'syntax = "proto3";\nmessage C {}\n');
    const overBundle = await buildRepoNativeExportBundle({
      repoRoot: overRoot,
      primaryRelativePath: 'service.proto',
      primaryContent: overPrimary,
      format: 'protobuf',
      limits: { maxDepth: 2 }
    });
    expect(overBundle.completeness).toBe('partial');
    expect(overBundle.contractClass).toBe('partial');
    expect(overBundle.artifacts).toBeUndefined();
  });

  it('dependency-free protobuf/WSDL roots over per-file or total cap are partial; exact cap remains full', async () => {
    const protoLeaf = 'syntax = "proto3";\nmessage Root {}\n';
    const wsdlLeaf =
      '<?xml version="1.0"?>\n<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" name="Pay">\n  <portType name="PayPort"/>\n</definitions>\n';

    async function assertRootByteCeilings(options: {
      format: 'protobuf' | 'wsdl';
      primaryRelativePath: string;
      primaryContent: string;
    }): Promise<void> {
      const rootBytes = Buffer.byteLength(options.primaryContent, 'utf8');
      const repoRoot = await mkdtemp(path.join(tmpdir(), `az-closure-root-${options.format}-`));
      await writeFile(path.join(repoRoot, options.primaryRelativePath), options.primaryContent);

      for (const ceiling of ['maxBytesPerFile', 'maxTotalBytes'] as const) {
        const overCompanions = await resolveRepoNativeDependencyCompanions({
          repoRoot,
          primaryRelativePath: options.primaryRelativePath,
          primaryContent: options.primaryContent,
          format: options.format,
          limits: { [ceiling]: rootBytes - 1 }
        });
        expect(overCompanions.closureLimitExceeded).toBe(true);
        expect(overCompanions.missingRefs).toEqual([]);
        expect(overCompanions.artifacts).toEqual([]);

        const overBundle = await buildRepoNativeExportBundle({
          repoRoot,
          primaryRelativePath: options.primaryRelativePath,
          primaryContent: options.primaryContent,
          format: options.format,
          limits: { [ceiling]: rootBytes - 1 }
        });
        expect(overBundle.completeness).toBe('partial');
        expect(overBundle.contractClass).toBe('partial');
        expect(overBundle.artifacts).toBeUndefined();
        expect(overBundle.evidence.join(' ')).toMatch(/byte ceiling/i);

        const exactCompanions = await resolveRepoNativeDependencyCompanions({
          repoRoot,
          primaryRelativePath: options.primaryRelativePath,
          primaryContent: options.primaryContent,
          format: options.format,
          limits: { [ceiling]: rootBytes }
        });
        expect(exactCompanions.closureLimitExceeded).toBe(false);
        expect(exactCompanions.missingRefs).toEqual([]);

        const exactBundle = await buildRepoNativeExportBundle({
          repoRoot,
          primaryRelativePath: options.primaryRelativePath,
          primaryContent: options.primaryContent,
          format: options.format,
          limits: { [ceiling]: rootBytes }
        });
        expect(exactBundle.completeness).toBe('full');
        expect(exactBundle.contractClass).toBe('authoritative');
        expect(exactBundle.artifacts).toBeUndefined();
      }
    }

    await assertRootByteCeilings({
      format: 'protobuf',
      primaryRelativePath: 'service.proto',
      primaryContent: protoLeaf
    });
    await assertRootByteCeilings({
      format: 'wsdl',
      primaryRelativePath: 'service.wsdl',
      primaryContent: wsdlLeaf
    });
  });

  it('marks per-member byte overage partial/blank without materializing the oversize companion', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'az-closure-perfile-'));
    const primary = 'syntax = "proto3";\nimport "big.proto";\nmessage Root {}\n';
    const big = `${'x'.repeat(64)}\n`;
    await writeFile(path.join(repoRoot, 'service.proto'), primary);
    await writeFile(path.join(repoRoot, 'big.proto'), big);

    const overBundle = await buildRepoNativeExportBundle({
      repoRoot,
      primaryRelativePath: 'service.proto',
      primaryContent: primary,
      format: 'protobuf',
      limits: { maxBytesPerFile: 32 }
    });
    expect(overBundle.completeness).toBe('partial');
    expect(overBundle.contractClass).toBe('partial');
    expect(overBundle.artifacts).toBeUndefined();

    const companions = await resolveRepoNativeDependencyCompanions({
      repoRoot,
      primaryRelativePath: 'service.proto',
      primaryContent: primary,
      format: 'protobuf',
      limits: { maxBytesPerFile: 32 }
    });
    expect(companions.artifacts).toEqual([]);
    expect(companions.missingRefs).toContain('big.proto');
  });

  it('marks cumulative total-byte overage partial/blank starting from root bytes', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'az-closure-total-'));
    const primary = 'syntax = "proto3";\nimport "a.proto";\nimport "b.proto";\nmessage Root {}\n';
    const a = 'syntax = "proto3";\nmessage A { string pad = 1; }\n';
    const b = 'syntax = "proto3";\nmessage B { string pad = 1; }\n';
    await writeFile(path.join(repoRoot, 'service.proto'), primary);
    await writeFile(path.join(repoRoot, 'a.proto'), a);
    await writeFile(path.join(repoRoot, 'b.proto'), b);

    const rootBytes = Buffer.byteLength(primary, 'utf8');
    const aBytes = Buffer.byteLength(a, 'utf8');
    // Cap admits root + a, but root + a + b exceeds.
    const maxTotalBytes = rootBytes + aBytes + 1;
    const companions = await resolveRepoNativeDependencyCompanions({
      repoRoot,
      primaryRelativePath: 'service.proto',
      primaryContent: primary,
      format: 'protobuf',
      limits: { maxTotalBytes }
    });
    expect(companions.missingRefs.length).toBeGreaterThan(0);
    expect(companions.artifacts.length).toBeLessThan(2);

    const overBundle = await buildRepoNativeExportBundle({
      repoRoot,
      primaryRelativePath: 'service.proto',
      primaryContent: primary,
      format: 'protobuf',
      limits: { maxTotalBytes }
    });
    expect(overBundle.completeness).toBe('partial');
    expect(overBundle.contractClass).toBe('partial');
    expect(overBundle.artifacts).toBeUndefined();

    // Exact cumulative fit (root + a + b) remains complete under a matching inject ceiling.
    const exactTotal = rootBytes + aBytes + Buffer.byteLength(b, 'utf8');
    const atCap = await buildRepoNativeExportBundle({
      repoRoot,
      primaryRelativePath: 'service.proto',
      primaryContent: primary,
      format: 'protobuf',
      limits: { maxTotalBytes: exactTotal }
    });
    expect(atCap.completeness).toBe('full');
    expect(atCap.artifacts?.map((artifact) => artifact.relativePath).sort()).toEqual([
      'a.proto',
      'b.proto'
    ]);
  });
});

describe('action/CLI inventory parity', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('runtime and CLI emit identical spec-files-json for a full repo proto bundle', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'az-inv-parity-'));
    await writeFile(path.join(repoRoot, 'service.proto'), PROTO_WITH_IMPORT);
    await writeFile(path.join(repoRoot, 'common.proto'), PROTO_COMMON);
    await writeNativeBinding(repoRoot, 'service.proto');
    vi.stubEnv('POSTMAN_ACTIONS_TELEMETRY', 'off');

    const runtimeResult = await execute(
      resolveInputs({
        INPUT_REPO_ROOT: repoRoot,
        INPUT_EXPECTED_SERVICE_NAME: 'payments',
        GITHUB_WORKSPACE: repoRoot
      }),
      baseDeps(repoRoot)
    );

    const deps = baseDeps(repoRoot);
    const runtimeDeps: Omit<AzureDependencies, 'core'> = {
      subscriptions: deps.subscriptions,
      createApimClient: deps.createApimClient,
      createAppServiceClient: deps.createAppServiceClient,
      writeSpecFile: deps.writeSpecFile,
      providers: deps.providers
    };
    const previousCwd = process.cwd();
    process.chdir(repoRoot);
    let stdout = '';
    try {
      await runCli(
        ['--repo-root', repoRoot, '--expected-service-name', 'payments', '--result-json', 'cli-result.json'],
        {
          env: { ...process.env, GITHUB_WORKSPACE: repoRoot, POSTMAN_ACTIONS_TELEMETRY: 'off' },
          writeStdout: (chunk) => {
            stdout += chunk;
          },
          dependencies: runtimeDeps
        }
      );
    } finally {
      process.chdir(previousCwd);
    }
    const cliResult = JSON.parse(stdout) as { outputs: Record<string, string> };
    expect(cliResult.outputs['spec-files-json']).toBe(runtimeResult.outputs['spec-files-json']);
    expect(cliResult.outputs['spec-path']).toBe(runtimeResult.outputs['spec-path']);
    expect(cliResult.outputs['spec-files-json']).toContain('"schemaVersion":1');
  });
});

describe('staged replacement', () => {
  it('staging failure after member 2 preserves prior tree byte-identical with no residue', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'az-inv-stage-fail-'));
    const serviceDir = path.join(repoRoot, 'discovered-specs', 'payments');
    const outputParent = path.join(repoRoot, 'discovered-specs');
    await mkdir(serviceDir, { recursive: true });
    const priorRoot = 'syntax = "proto3";\nservice Old {}\n';
    const priorDep = 'syntax = "proto3";\nmessage OldShared {}\n';
    const priorSidecar = '{"openapi":"3.0.3","paths":{}}';
    await writeFile(path.join(serviceDir, 'service.proto'), priorRoot);
    await writeFile(path.join(serviceDir, 'common.proto'), priorDep);
    await writeFile(path.join(serviceDir, 'openapi.derived.json'), priorSidecar);
    const priorTree = await snapshotTree(serviceDir);

    await writeFile(path.join(repoRoot, 'service.proto'), PROTO_WITH_IMPORT);
    await writeFile(path.join(repoRoot, 'common.proto'), PROTO_COMMON);
    await writeNativeBinding(repoRoot, 'service.proto');

    const deps = baseDeps(repoRoot);
    deps.afterStageMemberWrite = async ({ index }) => {
      if (index === 2) {
        throw new Error('injected staging failure on member 2');
      }
    };

    await expect(
      execute(
        resolveInputs({ INPUT_REPO_ROOT: repoRoot, INPUT_EXPECTED_SERVICE_NAME: 'payments' }),
        deps
      )
    ).rejects.toThrow(/injected staging failure/i);

    const afterTree = await snapshotTree(serviceDir);
    expect(afterTree).toEqual(priorTree);
    expect(await readFile(path.join(serviceDir, 'service.proto'), 'utf8')).toBe(priorRoot);
    expect(await readFile(path.join(serviceDir, 'common.proto'), 'utf8')).toBe(priorDep);
    expect(await readFile(path.join(serviceDir, 'openapi.derived.json'), 'utf8')).toBe(priorSidecar);
    await assertNoStageOrBackupResidue(outputParent);
  });

  it('failure after stage-to-canonical rename restores prior tree byte-identical with no residue', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'az-inv-swap-fail-'));
    const serviceDir = path.join(repoRoot, 'discovered-specs', 'payments');
    const outputParent = path.join(repoRoot, 'discovered-specs');
    await mkdir(serviceDir, { recursive: true });
    const priorRoot = 'syntax = "proto3";\nservice Old {}\n';
    const priorDep = 'syntax = "proto3";\nmessage OldShared {}\n';
    const priorSidecar = '{"openapi":"3.0.3","info":{"title":"prior"},"paths":{}}';
    await writeFile(path.join(serviceDir, 'service.proto'), priorRoot);
    await writeFile(path.join(serviceDir, 'common.proto'), priorDep);
    await writeFile(path.join(serviceDir, 'openapi.derived.json'), priorSidecar);
    const priorTree = await snapshotTree(serviceDir);

    await writeFile(path.join(repoRoot, 'service.proto'), PROTO_WITH_IMPORT);
    await writeFile(path.join(repoRoot, 'common.proto'), PROTO_COMMON);
    await writeNativeBinding(repoRoot, 'service.proto');

    const deps = baseDeps(repoRoot);
    deps.afterCanonicalSwap = async () => {
      throw new Error('injected failure after stage-to-canonical rename/final verification');
    };

    await expect(
      execute(
        resolveInputs({ INPUT_REPO_ROOT: repoRoot, INPUT_EXPECTED_SERVICE_NAME: 'payments' }),
        deps
      )
    ).rejects.toThrow(/injected failure after stage-to-canonical rename/i);

    const afterTree = await snapshotTree(serviceDir);
    expect(afterTree).toEqual(priorTree);
    expect(await readFile(path.join(serviceDir, 'service.proto'), 'utf8')).toBe(priorRoot);
    expect(await readFile(path.join(serviceDir, 'common.proto'), 'utf8')).toBe(priorDep);
    expect(await readFile(path.join(serviceDir, 'openapi.derived.json'), 'utf8')).toBe(priorSidecar);
    await assertNoStageOrBackupResidue(outputParent);
  });

  it('multi-file success does not call a canonical in-place writer', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'az-inv-no-inplace-'));
    const serviceDir = path.join(repoRoot, 'discovered-specs', 'payments');
    const outputParent = path.join(repoRoot, 'discovered-specs');
    await mkdir(serviceDir, { recursive: true });
    await writeFile(path.join(serviceDir, 'service.proto'), 'syntax = "proto3";\nservice Old {}\n');
    await writeFile(path.join(serviceDir, 'common.proto'), 'syntax = "proto3";\nmessage OldShared {}\n');
    await writeFile(path.join(serviceDir, 'openapi.derived.json'), '{"openapi":"3.0.3","paths":{}}');

    await writeFile(path.join(repoRoot, 'service.proto'), PROTO_WITH_IMPORT);
    await writeFile(path.join(repoRoot, 'common.proto'), PROTO_COMMON);
    await writeNativeBinding(repoRoot, 'service.proto');

    const writeSpecFile = vi.fn(async (outputPath: string, content: string, rootPath: string) => {
      const { defaultWriteSpecFile } = await import('../src/runtime.js');
      await defaultWriteSpecFile(outputPath, content, rootPath);
    });
    const deps = baseDeps(repoRoot);
    deps.writeSpecFile = writeSpecFile;

    const result = await execute(
      resolveInputs({ INPUT_REPO_ROOT: repoRoot, INPUT_EXPECTED_SERVICE_NAME: 'payments' }),
      deps
    );

    expect(result.resolution?.status).toBe('resolved');
    expect(result.outputs['spec-files-json']).toContain('common.proto');
    expect(await readFile(path.join(serviceDir, 'service.proto'), 'utf8')).toBe(PROTO_WITH_IMPORT);
    expect(await readFile(path.join(serviceDir, 'common.proto'), 'utf8')).toBe(PROTO_COMMON);
    expect(await readFile(path.join(serviceDir, 'openapi.derived.json'), 'utf8')).toContain('3.0.3');

    const canonicalMemberPrefix = path.join(repoRoot, 'discovered-specs', 'payments') + path.sep;
    const canonicalInPlaceWrites = writeSpecFile.mock.calls.filter(([outputPath]) => {
      const normalized = String(outputPath);
      if (!normalized.startsWith(canonicalMemberPrefix) && !normalized.includes(`${path.sep}payments${path.sep}`)) {
        return false;
      }
      // Stage writes are allowed; bare canonical member paths are not.
      if (normalized.includes('.stage-') || normalized.includes('.backup-')) return false;
      const base = path.basename(normalized);
      return base === 'service.proto' || base === 'common.proto';
    });
    expect(canonicalInPlaceWrites).toEqual([]);
    expect(writeSpecFile.mock.calls.length).toBeGreaterThan(0);
    expect(
      writeSpecFile.mock.calls.every(([outputPath]) => String(outputPath).includes('.stage-'))
    ).toBe(true);
    await assertNoStageOrBackupResidue(outputParent);
  });

  it('stale member removal keeps non-definition sidecars', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'az-inv-stale-'));
    const serviceDir = path.join(repoRoot, 'discovered-specs', 'payments');
    const outputParent = path.join(repoRoot, 'discovered-specs');
    await mkdir(serviceDir, { recursive: true });
    await writeFile(path.join(serviceDir, 'service.proto'), 'syntax = "proto3";\nservice Old {}\n');
    await writeFile(path.join(serviceDir, 'common.proto'), 'syntax = "proto3";\nmessage OldShared {}\n');
    await writeFile(path.join(serviceDir, 'stale.proto'), 'syntax = "proto3";\nmessage Stale {}\n');
    await writeFile(path.join(serviceDir, 'openapi.derived.json'), '{"openapi":"3.0.3","info":{"title":"sidecar"},"paths":{}}');
    await writeFile(path.join(serviceDir, 'contract.metadata.json'), '{"keep":true}');

    const provider: SpecProvider = {
      type: 'apim',
      probe: async () => 'available',
      listCandidates: async () =>
        [
          {
            id: '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.ApiManagement/service/svc/apis/pay',
            name: 'payments',
            providerType: 'apim',
            resourceGroup: 'rg',
            tags: { 'postman:project-name': 'payments' },
            supported: true,
            evidence: ['fixture'],
            meta: {
              serviceName: 'svc',
              resourceGroup: 'rg',
              apiId: 'pay',
              apiType: 'grpc'
            }
          }
        ] satisfies SpecCandidate[],
      exportSpec: async () => ({
        content: PROTO_WITH_IMPORT,
        format: 'protobuf' as const,
        filename: 'service.proto',
        contractClass: 'authoritative' as const,
        completeness: 'full' as const,
        evidence: ['provider complete source set'],
        artifacts: [{ relativePath: 'common.proto', content: PROTO_COMMON }]
      })
    };

    const result = await execute(
      resolveInputs({ INPUT_REPO_ROOT: repoRoot, INPUT_EXPECTED_SERVICE_NAME: 'payments' }),
      baseDeps(repoRoot, [provider])
    );

    expect(result.resolution?.status).toBe('resolved');
    expect(result.outputs['spec-files-json']).toContain('common.proto');
    expect(result.outputs['spec-files-json']).not.toContain('openapi.derived.json');
    expect(result.outputs['spec-files-json']).not.toContain('contract.metadata.json');
    await expect(readFile(path.join(serviceDir, 'stale.proto'), 'utf8')).rejects.toThrow();
    expect(await readFile(path.join(serviceDir, 'contract.metadata.json'), 'utf8')).toContain('"keep":true');
    expect(await readFile(path.join(serviceDir, 'service.proto'), 'utf8')).toBe(PROTO_WITH_IMPORT);
    expect(await readFile(path.join(serviceDir, 'common.proto'), 'utf8')).toBe(PROTO_COMMON);
    await assertNoStageOrBackupResidue(outputParent);
    await rm(path.join(repoRoot, 'discovered-specs', 'payments', 'stale.proto'), { force: true }).catch(() => undefined);
  });
});
