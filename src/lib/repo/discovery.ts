import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { SpecCandidate } from '../providers/types.js';
import { parseAndValidateOpenApi } from '../spec/validate-openapi.js';
import type {
  AzureResourceBinding,
  RepositoryDiscoveryDiagnostics,
  RepositoryDiscoveryResult
} from './discovery-types.js';
import {
  parseApiOpsConfig,
  parseArmTemplateJson,
  parseAzureDevOpsPipeline,
  parseAzureEnvFile,
  parseAzureYaml,
  parseBicepSource,
  parseDeploymentArtifact,
  parseGitHubActionsWorkflow,
  parsePulumiSource,
  parsePulumiYaml,
  parseSourceControlDeclaration,
  parseTerraformHcl,
  parseTfvars
} from './parsers/index.js';
import { DEFAULT_MAX_FILE_BYTES, walkRepoFiles } from './scan.js';
import { isSecretPath, isSecretValue } from './secret-hygiene.js';
import { findAllRepoSpecs } from './specs.js';

export interface DiscoverRepositoryOptions {
  repoRoot: string;
  outputDir?: string;
  maxFileBytes?: number;
}

function basename(relativePath: string): string {
  return relativePath.replace(/\\/g, '/').split('/').pop() ?? relativePath;
}

function isAzureYaml(relativePath: string): boolean {
  const name = basename(relativePath).toLowerCase();
  return name === 'azure.yaml' || name === 'azure.yml';
}

function isAzureEnv(relativePath: string): boolean {
  return /(^|\/)\.azure\/[^/]+\/\.env$/i.test(relativePath.replace(/\\/g, '/'));
}

function isBicep(relativePath: string): boolean {
  return relativePath.toLowerCase().endsWith('.bicep');
}

function isTerraform(relativePath: string): boolean {
  const lower = relativePath.toLowerCase();
  return lower.endsWith('.tf') || lower.endsWith('.tf.json');
}

function isTfvars(relativePath: string): boolean {
  const lower = relativePath.toLowerCase();
  return lower.endsWith('.tfvars') || lower.endsWith('.tfvars.json') || lower.endsWith('.auto.tfvars');
}

function isPulumiYaml(relativePath: string): boolean {
  const name = basename(relativePath);
  return /^Pulumi(\.[^./]+)?\.ya?ml$/i.test(name);
}

function isPulumiSource(relativePath: string): boolean {
  return /\.(?:ts|js|py|go|cs)$/i.test(relativePath) && /pulumi/i.test(relativePath);
}

function isApiOps(relativePath: string): boolean {
  const name = basename(relativePath).toLowerCase();
  return (
    /(?:^|\/)(?:extractor|publisher|configuration\.(?:extractor|publisher))\.ya?ml$/i.test(relativePath) ||
    /apiops/i.test(relativePath) ||
    name === 'configuration.extractor.yaml' ||
    name === 'configuration.publisher.yaml'
  );
}

function isGitHubWorkflow(relativePath: string): boolean {
  return /(^|\/)\.github\/workflows\/.+\.ya?ml$/i.test(relativePath.replace(/\\/g, '/'));
}

function isAzureDevOpsPipeline(relativePath: string): boolean {
  const posix = relativePath.replace(/\\/g, '/').toLowerCase();
  const name = basename(posix);
  return (
    name === 'azure-pipelines.yml' ||
    name === 'azure-pipelines.yaml' ||
    /(^|\/)\.azure-pipelines\/.+\.ya?ml$/.test(posix) ||
    /(^|\/)pipelines\/.+\.ya?ml$/.test(posix)
  );
}

function isDeploymentArtifact(relativePath: string): boolean {
  const posix = relativePath.replace(/\\/g, '/').toLowerCase();
  return (
    /(^|\/)(?:deployments?|stacks?|template-?specs?)\/.+\.json$/.test(posix) ||
    /(?:deployment[-_.]?outputs?|stack[-_.]?outputs?|template[-_.]?spec).*\.json$/i.test(basename(posix))
  );
}

function isArmOrCompiledJson(relativePath: string): boolean {
  const lower = relativePath.toLowerCase();
  if (!lower.endsWith('.json')) return false;
  if (isDeploymentArtifact(relativePath)) return true;
  // Broad ARM/compiled-bicep JSON; parsers no-op on unrelated JSON.
  return true;
}

function isSourceControlBearing(relativePath: string): boolean {
  const lower = relativePath.toLowerCase();
  return (
    lower.endsWith('.json') ||
    lower.endsWith('.bicep') ||
    /(^|\/)(?:infra|deploy|bicep|arm)\//.test(lower.replace(/\\/g, '/'))
  );
}

function shouldScanDeclaration(relativePath: string): boolean {
  if (isSecretPath(relativePath)) return false;
  return (
    isAzureYaml(relativePath) ||
    isAzureEnv(relativePath) ||
    isBicep(relativePath) ||
    isTerraform(relativePath) ||
    isTfvars(relativePath) ||
    isPulumiYaml(relativePath) ||
    isPulumiSource(relativePath) ||
    isApiOps(relativePath) ||
    isGitHubWorkflow(relativePath) ||
    isAzureDevOpsPipeline(relativePath) ||
    isDeploymentArtifact(relativePath) ||
    isArmOrCompiledJson(relativePath)
  );
}

function serializeSafe(value: unknown): string {
  return JSON.stringify(value, (_key, nested) => {
    if (typeof nested === 'string' && isSecretValue(nested)) return '[redacted]';
    return nested;
  });
}

function partitionBindings(bindings: AzureResourceBinding[]): {
  exactBindings: AzureResourceBinding[];
  associations: AzureResourceBinding[];
} {
  const exactBindings: AzureResourceBinding[] = [];
  const associations: AzureResourceBinding[] = [];
  const seen = new Set<string>();
  for (const binding of bindings) {
    const key = serializeSafe({
      class: binding.class,
      family: binding.family,
      apimApiId: binding.apimApiId,
      apiCenterDefinitionId: binding.apiCenterDefinitionId,
      serviceName: binding.serviceName,
      resourceGroup: binding.resourceGroup,
      nativeSpecPath: binding.nativeSpecPath,
      nativeSpecUrl: binding.nativeSpecUrl,
      templateSpecId: binding.templateSpecId,
      deploymentStackId: binding.deploymentStackId,
      sourceControlRepoUrl: binding.sourceControlRepoUrl,
      sourceControlBranch: binding.sourceControlBranch,
      environment: binding.environment
    });
    if (seen.has(key)) continue;
    seen.add(key);
    if (binding.class === 'exact-binding') exactBindings.push(binding);
    else associations.push(binding);
  }
  return { exactBindings, associations };
}

/**
 * Aggregate local specification + Azure binding discovery.
 * Local-only: no network, no process execution, secret-safe evidence.
 */
export async function discoverRepository(options: DiscoverRepositoryOptions): Promise<RepositoryDiscoveryResult> {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const outputDirName = options.outputDir ? path.basename(options.outputDir) : undefined;

  const diagnostics: RepositoryDiscoveryDiagnostics = {
    scannedFiles: 0,
    truncatedByFileCap: false,
    truncatedByDepth: false,
    skippedSecretFiles: [],
    messages: []
  };

  const localSpecs = await findAllRepoSpecs(options.repoRoot, {
    outputDirName,
    maxFileBytes
  });

  const walked = await walkRepoFiles({
    root: options.repoRoot,
    extraSkipDirs: outputDirName ? [outputDirName] : [],
    includeFile: (relativePath) => {
      if (isSecretPath(relativePath)) {
        diagnostics.skippedSecretFiles.push(relativePath);
        return false;
      }
      return shouldScanDeclaration(relativePath);
    }
  });

  diagnostics.scannedFiles = walked.files.length;
  diagnostics.truncatedByFileCap = walked.truncatedByFileCap;
  diagnostics.truncatedByDepth = walked.truncatedByDepth;

  const variables: Record<string, string> = {};
  const bindings: AzureResourceBinding[] = [];

  // First pass: tfvars / azure env to feed static indirection.
  for (const file of walked.files) {
    if (file.sizeBytes > maxFileBytes) {
      diagnostics.messages.push(`skipped oversized file ${file.relativePath}`);
      continue;
    }
    if (isTfvars(file.relativePath) || isAzureEnv(file.relativePath)) {
      const content = await readFile(file.absolutePath, 'utf8').catch(() => undefined);
      if (content === undefined) continue;
      if (isTfvars(file.relativePath)) {
        Object.assign(variables, parseTfvars(file.relativePath, content));
      }
      if (isAzureEnv(file.relativePath)) {
        bindings.push(...parseAzureEnvFile(file.relativePath, content));
      }
    }
  }

  for (const file of walked.files) {
    if (file.sizeBytes > maxFileBytes) continue;
    if (isTfvars(file.relativePath) || isAzureEnv(file.relativePath)) continue;

    const content = await readFile(file.absolutePath, 'utf8').catch(() => undefined);
    if (content === undefined) continue;

    try {
      if (isAzureYaml(file.relativePath)) {
        bindings.push(...parseAzureYaml(file.relativePath, content, variables));
      }
      if (isBicep(file.relativePath)) {
        bindings.push(...parseBicepSource(file.relativePath, content, variables));
        bindings.push(...parseSourceControlDeclaration(file.relativePath, content, variables));
      }
      if (isTerraform(file.relativePath)) {
        bindings.push(...parseTerraformHcl(file.relativePath, content, variables));
      }
      if (isPulumiYaml(file.relativePath)) {
        bindings.push(...parsePulumiYaml(file.relativePath, content, variables));
      }
      if (isPulumiSource(file.relativePath)) {
        bindings.push(...parsePulumiSource(file.relativePath, content, variables));
      }
      if (isApiOps(file.relativePath)) {
        bindings.push(...parseApiOpsConfig(file.relativePath, content, variables));
      }
      if (isGitHubWorkflow(file.relativePath)) {
        bindings.push(...parseGitHubActionsWorkflow(file.relativePath, content, variables));
      }
      if (isAzureDevOpsPipeline(file.relativePath)) {
        bindings.push(...parseAzureDevOpsPipeline(file.relativePath, content, variables));
      }
      if (isDeploymentArtifact(file.relativePath)) {
        bindings.push(...parseDeploymentArtifact(file.relativePath, content, variables));
      }
      if (file.relativePath.toLowerCase().endsWith('.json')) {
        const arm = parseArmTemplateJson(file.relativePath, content, variables);
        bindings.push(...arm.bindings);
        if (isSourceControlBearing(file.relativePath)) {
          bindings.push(...parseSourceControlDeclaration(file.relativePath, content, variables));
        }
      }
    } catch (error) {
      diagnostics.messages.push(
        `parser error in ${file.relativePath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const { exactBindings, associations } = partitionBindings(bindings);

  // Ranked ambiguity when multiple local specs exist; exact nativeSpecPath binding narrows but does not hide the inventory.
  if (localSpecs.length > 1) {
    const boundPaths = new Set(
      [...exactBindings, ...associations]
        .map((binding) => binding.nativeSpecPath)
        .filter((value): value is string => Boolean(value))
    );
    const unbound = localSpecs.filter((spec) => !boundPaths.has(spec.path));
    if (unbound.length > 1) {
      diagnostics.messages.push(
        `multiple local specifications detected (${localSpecs.map((spec) => spec.path).join(', ')}); ranked ambiguity until an exact manifest/pipeline binding selects one`
      );
    } else {
      diagnostics.messages.push(
        `multiple local specifications detected (${localSpecs.map((spec) => spec.path).join(', ')}); declaration binding present for ${[...boundPaths].join(', ') || 'none'}`
      );
    }
  }

  // Ensure serialized result never embeds secret-shaped strings.
  const safe: RepositoryDiscoveryResult = JSON.parse(
    serializeSafe({
      localSpecs,
      exactBindings,
      associations,
      diagnostics
    })
  ) as RepositoryDiscoveryResult;

  return safe;
}

/**
 * Compatibility bridge for existing iac-local provider consumers.
 * Maps aggregate discovery inline ARM OpenAPI documents into SpecCandidate[].
 */
export async function scanAzureIacFromDiscovery(
  repoRoot: string,
  outputDir: string
): Promise<{
  candidates: SpecCandidate[];
  discovery: RepositoryDiscoveryResult;
}> {
  const discovery = await discoverRepository({ repoRoot, outputDir });
  const candidates: SpecCandidate[] = [];

  const walked = await walkRepoFiles({
    root: repoRoot,
    extraSkipDirs: [path.basename(outputDir)],
    includeFile: (relativePath) => relativePath.toLowerCase().endsWith('.json') && !isSecretPath(relativePath)
  });

  for (const file of walked.files) {
    if (file.sizeBytes > DEFAULT_MAX_FILE_BYTES) continue;
    const content = await readFile(file.absolutePath, 'utf8').catch(() => undefined);
    if (!content) continue;
    const arm = parseArmTemplateJson(file.relativePath, content);
    for (const inline of arm.inlineDocuments) {
      try {
        const value = inline.value;
        let inlineContent: string;
        let isJson = false;
        if (typeof value === 'string') {
          const validated = parseAndValidateOpenApi(value);
          inlineContent = value.endsWith('\n') ? value : `${value}\n`;
          isJson = validated.isJson;
        } else if (value && typeof value === 'object') {
          inlineContent = `${JSON.stringify(value, null, 2)}\n`;
          parseAndValidateOpenApi(inlineContent);
          isJson = true;
        } else {
          continue;
        }
        candidates.push({
          id: `${file.relativePath}#${inline.resourceName}`,
          name: inline.resourceName,
          providerType: 'iac-local',
          tags: {},
          supported: true,
          evidence: [`Inline OpenAPI document embedded in ${file.relativePath} resource ${inline.resourceName}`],
          meta: {
            relativePath: file.relativePath,
            inlineContent,
            inlineFormat: isJson ? 'openapi-json' : 'openapi-yaml'
          }
        });
      } catch {
        // ignore invalid inline docs
      }
    }
  }

  // azure.yaml local project OpenAPI references
  for (const binding of discovery.associations) {
    if (binding.family !== 'azure-yaml' || !binding.nativeSpecPath) continue;
    const absolute = path.join(repoRoot, binding.nativeSpecPath);
    const content = await readFile(absolute, 'utf8').catch(() => undefined);
    if (!content) continue;
    try {
      const validated = parseAndValidateOpenApi(content);
      candidates.push({
        id: `azure.yaml#${binding.serviceName ?? binding.nativeSpecPath}`,
        name: binding.serviceName ?? binding.nativeSpecPath,
        providerType: 'iac-local',
        tags: {},
        supported: true,
        evidence: binding.evidence.map((item) => item.note),
        meta: {
          relativePath: binding.nativeSpecPath,
          inlineContent: content.endsWith('\n') ? content : `${content}\n`,
          inlineFormat: validated.isJson ? 'openapi-json' : 'openapi-yaml'
        }
      });
    } catch {
      // not openapi
    }
  }

  return { candidates, discovery };
}
