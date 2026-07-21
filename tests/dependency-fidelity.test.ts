import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  applyNativeDependencyFidelity,
  assessNativeDependencyFidelity,
  extractProtobufImports,
  extractXmlSchemaDependencyRefs
} from '../src/lib/spec/dependency-fidelity.js';
import { buildRepoNativeExportBundle } from '../src/lib/repo/native-dependency-bundle.js';
import {
  applyExportContractClass,
  execute,
  resolveInputs,
  type AzureDependencies,
  type ReporterLike
} from '../src/runtime.js';
import type { SpecExportResult, SpecProvider } from '../src/lib/providers/types.js';

const PROTO_CLOSED = `syntax = "proto3";
package demo;
service Greeter { rpc Ping (Empty) returns (Empty); }
message Empty {}
`;

const PROTO_WITH_IMPORT = `syntax = "proto3";
package demo;
import "common.proto";
service Greeter { rpc Ping (Empty) returns (Empty); }
message Empty {}
`;

const WSDL_CLOSED = `<?xml version="1.0"?>
<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" name="Pay">
  <portType name="PayPort"/>
</definitions>`;

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

describe('dependency fidelity helpers', () => {
  it('extracts protobuf imports and XML schema/wsdl dependency locations', () => {
    expect(extractProtobufImports(PROTO_WITH_IMPORT)).toEqual(['common.proto']);
    expect(extractProtobufImports('import public "a.proto";\nimport weak "b.proto";\n')).toEqual([
      'a.proto',
      'b.proto'
    ]);
    expect(extractXmlSchemaDependencyRefs(WSDL_WITH_XSD)).toEqual(['types.xsd']);
    expect(
      extractXmlSchemaDependencyRefs(
        '<definitions xmlns="http://schemas.xmlsoap.org/wsdl/"><import location="other.wsdl"/></definitions>'
      )
    ).toEqual(['other.wsdl']);
  });

  it('marks closed documents authoritative/full and imported cloud primaries partial', () => {
    const closed = assessNativeDependencyFidelity({ content: PROTO_CLOSED, format: 'protobuf' });
    expect(closed).toMatchObject({
      hasUnresolvedDependencies: false,
      contractClass: 'authoritative',
      completeness: 'full'
    });

    const open = assessNativeDependencyFidelity({ content: PROTO_WITH_IMPORT, format: 'protobuf' });
    expect(open).toMatchObject({
      hasUnresolvedDependencies: true,
      contractClass: 'partial',
      completeness: 'partial'
    });
    expect(open.unresolvedRefs).toEqual(['common.proto']);

    const wsdlOpen = assessNativeDependencyFidelity({ content: WSDL_WITH_XSD, format: 'wsdl' });
    expect(wsdlOpen.contractClass).toBe('partial');
  });

  it('treats available companion bytes as closure without concatenation', () => {
    const closed = assessNativeDependencyFidelity({
      content: PROTO_WITH_IMPORT,
      format: 'protobuf',
      availableDependencyKeys: ['common.proto']
    });
    expect(closed.hasUnresolvedDependencies).toBe(false);
    expect(closed.contractClass).toBe('authoritative');
  });

  it('never upgrades reconstructed/partial when applying dependency fidelity', () => {
    const base: SpecExportResult = {
      content: WSDL_WITH_XSD,
      format: 'wsdl',
      filename: 'service.wsdl',
      contractClass: 'reconstructed',
      completeness: 'partial',
      evidence: ['SoapToRest']
    };
    const applied = applyNativeDependencyFidelity(
      base,
      assessNativeDependencyFidelity({ content: WSDL_WITH_XSD, format: 'wsdl' })
    );
    expect(applied.contractClass).toBe('reconstructed');
    expect(applied.completeness).toBe('partial');
  });

  it('registry default never upgrades an explicit partial/reconstructed contract class', () => {
    const partial = applyExportContractClass('apim', {
      content: PROTO_CLOSED,
      format: 'protobuf',
      filename: 'service.proto',
      contractClass: 'partial',
      evidence: []
    });
    expect(partial.contractClass).toBe('partial');

    const reconstructed = applyExportContractClass('custom-apis', {
      content: WSDL_CLOSED,
      format: 'wsdl',
      filename: 'service.wsdl',
      contractClass: 'reconstructed',
      evidence: []
    });
    expect(reconstructed.contractClass).toBe('reconstructed');

    const defaulted = applyExportContractClass('apim', {
      content: PROTO_CLOSED,
      format: 'protobuf',
      filename: 'service.proto',
      evidence: []
    });
    expect(defaulted.contractClass).toBe('authoritative');
  });

  it('bundles path-confined repo companions when exact dependency bytes exist', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'az-dep-bundle-'));
    await writeFile(path.join(repoRoot, 'service.proto'), PROTO_WITH_IMPORT);
    await writeFile(path.join(repoRoot, 'common.proto'), 'syntax = "proto3";\nmessage Shared { string id = 1; }\n');

    const exported = await buildRepoNativeExportBundle({
      repoRoot,
      primaryRelativePath: 'service.proto',
      primaryContent: PROTO_WITH_IMPORT,
      format: 'protobuf'
    });
    expect(exported.contractClass).toBe('authoritative');
    expect(exported.artifacts).toHaveLength(1);
    expect(exported.artifacts?.[0]?.relativePath).toBe('common.proto');
    expect(exported.evidence.join(' ')).toMatch(/Bundled 1 path-confined companion/i);
  });

  it('keeps repo export partial when a relative dependency is missing', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'az-dep-missing-'));
    await mkdir(repoRoot, { recursive: true });
    const exported = await buildRepoNativeExportBundle({
      repoRoot,
      primaryRelativePath: 'service.wsdl',
      primaryContent: WSDL_WITH_XSD,
      format: 'wsdl'
    });
    expect(exported.contractClass).toBe('partial');
    expect(exported.artifacts).toBeUndefined();
    expect(exported.evidence.join(' ')).toMatch(/unresolved dependency/i);
  });

  it('bundles transitive protobuf companions and stays partial when a transitive ref is missing', async () => {
    const closedRoot = await mkdtemp(path.join(tmpdir(), 'az-dep-proto-closure-'));
    await writeFile(path.join(closedRoot, 'service.proto'), PROTO_WITH_IMPORT);
    await writeFile(
      path.join(closedRoot, 'common.proto'),
      'syntax = "proto3";\nimport "shared.proto";\nmessage Shared { string id = 1; }\n'
    );
    await writeFile(
      path.join(closedRoot, 'shared.proto'),
      'syntax = "proto3";\nmessage SharedLeaf { string id = 1; }\n'
    );
    const closed = await buildRepoNativeExportBundle({
      repoRoot: closedRoot,
      primaryRelativePath: 'service.proto',
      primaryContent: PROTO_WITH_IMPORT,
      format: 'protobuf'
    });
    expect(closed.contractClass).toBe('authoritative');
    expect(closed.completeness).toBe('full');
    expect(closed.artifacts?.map((artifact) => artifact.relativePath).sort()).toEqual([
      'common.proto',
      'shared.proto'
    ]);

    const openRoot = await mkdtemp(path.join(tmpdir(), 'az-dep-proto-open-'));
    await writeFile(path.join(openRoot, 'service.proto'), PROTO_WITH_IMPORT);
    await writeFile(
      path.join(openRoot, 'common.proto'),
      'syntax = "proto3";\nimport "shared.proto";\nmessage Shared { string id = 1; }\n'
    );
    const open = await buildRepoNativeExportBundle({
      repoRoot: openRoot,
      primaryRelativePath: 'service.proto',
      primaryContent: PROTO_WITH_IMPORT,
      format: 'protobuf'
    });
    expect(open.contractClass).toBe('partial');
    expect(open.completeness).toBe('partial');
    expect(open.artifacts).toBeUndefined();
    expect(open.evidence.join(' ')).toMatch(/shared\.proto|transitive/i);
  });
});

describe('artifact bundle materialization', () => {
  it('writes path-confined companion artifacts beside the primary spec-path', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'az-artifact-mat-'));
    const written = new Map<string, string>();
    const writeSpecFile = vi.fn(async (outputPath: string, content: string) => {
      written.set(outputPath, content);
    });

    // Inject a provider that returns primary + exact companion bytes (no DTO invent).
    const provider: SpecProvider = {
      type: 'apim',
      probe: async () => 'available',
      listCandidates: async () => [
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
      ],
      exportSpec: async () => ({
        content: PROTO_WITH_IMPORT,
        format: 'protobuf',
        filename: 'service.proto',
        contractClass: 'authoritative',
        evidence: ['primary with companion bytes already in hand'],
        artifacts: [{ relativePath: 'common.proto', content: 'syntax = "proto3";\nmessage Shared {}\n' }]
      })
    };

    const reporter: ReporterLike = {
      group: async (_name, fn) => fn(),
      info: () => undefined,
      warning: () => undefined
    };
    const dependencies: AzureDependencies = {
      core: reporter,
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
      writeSpecFile,
      providers: [provider]
    };

    const result = await execute(
      resolveInputs({ INPUT_REPO_ROOT: repoRoot, INPUT_EXPECTED_SERVICE_NAME: 'payments' }),
      dependencies
    );
    expect(result.resolution?.status).toBe('resolved');
    expect(result.resolution?.specPath).toMatch(/service\.proto$/);
    expect(result.resolution?.contractClass).toBe('authoritative');
    expect(result.outputs['spec-files-json']).toContain('common.proto');
    expect(result.outputs['spec-files-json']).toContain('"completeness":"full"');
    expect([...written.keys()].some((key) => key.endsWith('common.proto'))).toBe(true);
    expect([...written.values()].some((value) => value.includes('message Shared'))).toBe(true);
  });

  it('incomplete provider native source set blanks spec-path and inventory', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'az-artifact-incomplete-'));
    const writeSpecFile = vi.fn(async () => undefined);
    const provider: SpecProvider = {
      type: 'apim',
      probe: async () => 'available',
      listCandidates: async () => [
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
      ],
      exportSpec: async () => ({
        content: PROTO_WITH_IMPORT,
        format: 'protobuf',
        filename: 'service.proto',
        contractClass: 'partial',
        completeness: 'partial',
        evidence: ['unresolved dependency reference(s): common.proto']
      })
    };
    const reporter: ReporterLike = {
      group: async (_name, fn) => fn(),
      info: () => undefined,
      warning: () => undefined
    };
    const result = await execute(
      resolveInputs({ INPUT_REPO_ROOT: repoRoot, INPUT_EXPECTED_SERVICE_NAME: 'payments' }),
      {
        core: reporter,
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
        writeSpecFile,
        providers: [provider]
      }
    );
    expect(result.resolution?.status).toBe('unresolved');
    expect(result.resolution?.contractClass).toBe('partial');
    expect(result.outputs['spec-path']).toBe('');
    expect(result.outputs['spec-files-json']).toBe('');
    expect(writeSpecFile).not.toHaveBeenCalled();
  });
});
