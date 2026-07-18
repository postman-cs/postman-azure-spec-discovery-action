import { realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createTelemetryContext } from '@postman-cse/automation-telemetry-core';

import { resolveActionVersion } from './action-version.js';
import {
  ApimSdkClient,
  AppServiceSdkClient,
  CustomApisSdkClient,
  LogicWorkflowsSdkClient,
  createAzureCredential,
  ResourceGraphSdkClient,
  SubscriptionsSdkClient,
  TemplateSpecsSdkClient,
  EventGridSdkClient,
  ServiceBusSdkClient,
  FunctionsSdkClient
} from './lib/azure/clients.js';
import { formatUserSafeError, sanitizeLogMessage } from './lib/logging/sanitize.js';
import { prepareTelemetryCredentials, resolveTelemetryTeamId } from './lib/postman/telemetry-credentials.js';
import { defaultWriteSpecFile, execute, resolveInputs, type AzureDependencies, type ReporterLike } from './runtime.js';

interface CliConfig {
  inputEnv: NodeJS.ProcessEnv;
  resultJsonPath: string;
  dotenvPath?: string;
}

export type ParsedCliArgs =
  | { kind: 'help' }
  | { kind: 'version' }
  | ({ kind: 'run' } & CliConfig);

export interface CliRuntime {
  env?: NodeJS.ProcessEnv;
  writeStdout?: (chunk: string) => void;
  dependencies?: Omit<AzureDependencies, 'core'>;
}

class ConsoleReporter implements ReporterLike {
  public async group<T>(name: string, fn: () => Promise<T>): Promise<T> {
    console.error(`[group] ${name}`);
    return await fn();
  }

  public info(message: string): void {
    console.error(message);
  }

  public warning(message: string): void {
    console.error(`warning: ${sanitizeLogMessage(message)}`);
  }
}

const CLI_INPUT_NAMES = [
  'mode',
  'subscription-id',
  'resource-group',
  'api-id',
  'repo-url',
  'repo-slug',
  'git-provider',
  'ref',
  'sha',
  'repo-root',
  'expected-service-name',
  'expected-api-ids-json',
  'api-filter',
  'service-mapping-json',
  'output-dir',
  'max-candidates',
  'dry-run',
  'preflight-checks',
  'preflight-permission-probe',
  'request-timeout-ms',
  'max-attempts',
  'postman-api-key',
  'postman-access-token'
] as const;

const META_OPTIONS = new Set(['result-json', 'dotenv-path', 'help', 'version']);

const KNOWN_OPTIONS = new Set<string>([...CLI_INPUT_NAMES, ...META_OPTIONS]);

function normalizeCliFlag(name: string): string {
  return `INPUT_${name.replace(/-/g, '_').toUpperCase()}`;
}

function printHelp(writeStdout: (chunk: string) => void): void {
  writeStdout(`Usage: postman-azure-spec-discovery [options]

Discover Azure-hosted API specs and emit JSON / dotenv artifacts for downstream
Postman onboarding steps.

Options mirror action inputs as --kebab-case flags (for example --subscription-id,
--dry-run, --output-dir). Additional CLI-only options:

  --result-json <path>   Write the full result JSON (default: postman-azure-spec-discovery-result.json)
  --dotenv-path <path>   Optional dotenv export for downstream jobs
  --help                 Show this help text and exit
  --version              Print the package version and exit
`);
}

function printVersion(writeStdout: (chunk: string) => void): void {
  writeStdout(`${resolveActionVersion()}\n`);
}

export function parseCliArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): ParsedCliArgs {
  const inputEnv: NodeJS.ProcessEnv = { ...env };
  const seen = new Set<string>();
  let command: 'run' | 'help' | 'version' = 'run';
  let resultJsonPath = normalizeInputish(env.INPUT_RESULT_JSON) ?? 'postman-azure-spec-discovery-result.json';
  let dotenvPath = normalizeInputish(env.INPUT_DOTENV_PATH);

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) {
      continue;
    }

    if (!token.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${token}`);
    }

    const raw = token.slice(2);
    const equalsIndex = raw.indexOf('=');
    const optionName = equalsIndex >= 0 ? raw.slice(0, equalsIndex) : raw;

    if (!optionName || !KNOWN_OPTIONS.has(optionName)) {
      throw new Error(`Unknown option: --${optionName || raw}`);
    }

    if (seen.has(optionName)) {
      throw new Error(`Duplicate option: --${optionName}`);
    }
    seen.add(optionName);

    if (optionName === 'help' || optionName === 'version') {
      if (equalsIndex >= 0) {
        throw new Error(`Option --${optionName} does not accept a value`);
      }
      command = optionName;
      continue;
    }

    let rawValue: string | undefined;
    if (equalsIndex >= 0) {
      rawValue = raw.slice(equalsIndex + 1);
    } else {
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        rawValue = next;
        index += 1;
      } else {
        throw new Error(`Missing value for --${optionName}`);
      }
    }
    if (rawValue === '') {
      throw new Error(`Missing value for --${optionName}`);
    }

    if (optionName === 'result-json') {
      resultJsonPath = rawValue;
      continue;
    }
    if (optionName === 'dotenv-path') {
      dotenvPath = rawValue;
      continue;
    }

    const envName = normalizeCliFlag(optionName);
    const runnerEnvName = `INPUT_${optionName.toUpperCase()}`;
    if (runnerEnvName !== envName) {
      delete inputEnv[runnerEnvName];
    }
    inputEnv[envName] = rawValue;
  }

  if (command !== 'run') {
    if (seen.size !== 1) {
      throw new Error(`Option --${command} cannot be combined with other options`);
    }
    return { kind: command };
  }

  return {
    kind: 'run',
    inputEnv,
    resultJsonPath,
    dotenvPath
  };
}

function normalizeInputish(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function toDotenv(outputs: Record<string, string>): string {
  const envPairs = {
    POSTMAN_AZURE_SPEC_RESOLUTION_JSON: outputs['resolution-json'] ?? '',
    POSTMAN_AZURE_SPEC_RESOLUTION_STATUS: outputs['resolution-status'] ?? '',
    POSTMAN_AZURE_SPEC_SOURCE_TYPE: outputs['source-type'] ?? '',
    POSTMAN_AZURE_SPEC_MAPPING_CONFIDENCE: outputs['mapping-confidence'] ?? '',
    POSTMAN_AZURE_SPEC_PATH: outputs['spec-path'] ?? '',
    POSTMAN_AZURE_SPEC_API_ID: outputs['api-id'] ?? '',
    POSTMAN_AZURE_SPEC_SERVICE_NAME: outputs['service-name'] ?? '',
    POSTMAN_AZURE_SPEC_SERVICES_JSON: outputs['services-json'] ?? '',
    POSTMAN_AZURE_SPEC_SERVICE_COUNT: outputs['service-count'] ?? '',
    POSTMAN_AZURE_SPEC_EXPORT_SUMMARY_JSON: outputs['export-summary-json'] ?? '',
    POSTMAN_AZURE_SPEC_CANDIDATES_JSON: outputs['candidates-json'] ?? '',
    POSTMAN_AZURE_SPEC_PROVIDER_TYPE: outputs['provider-type'] ?? '',
    POSTMAN_AZURE_SPEC_FORMAT: outputs['spec-format'] ?? '',
    POSTMAN_AZURE_SPEC_CONTRACT_ORIGIN: outputs['contract-origin'] ?? '',
    POSTMAN_AZURE_SPEC_CONTRACT_METADATA_PATH: outputs['contract-metadata-path'] ?? '',
    POSTMAN_AZURE_SPEC_VARIANT_COUNT: outputs['variant-count'] ?? '',
    POSTMAN_AZURE_SPEC_DERIVED_OPENAPI_PATH: outputs['derived-openapi-path'] ?? '',
    POSTMAN_AZURE_SPEC_DERIVED_OPENAPI_VERSION: outputs['derived-openapi-version'] ?? '',
    POSTMAN_AZURE_SPEC_DERIVED_OPENAPI_COMPLETENESS: outputs['derived-openapi-completeness'] ?? '',
    POSTMAN_AZURE_SPEC_DERIVED_OPENAPI_FORMAT: outputs['derived-openapi-format'] ?? '',
    POSTMAN_AZURE_SPEC_DERIVED_OPENAPI_EVIDENCE_JSON: outputs['derived-openapi-evidence-json'] ?? '',
    POSTMAN_AZURE_SPEC_NARROWING_STRATEGY: outputs['narrowing-strategy'] ?? 'none'
  };

  return Object.entries(envPairs)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join('\n');
}

async function writeOptionalFile(filePath: string | undefined, content: string): Promise<void> {
  if (!filePath) {
    return;
  }
  const workspaceRoot = path.resolve(process.cwd());
  const resolved = path.resolve(workspaceRoot, filePath);
  const relative = path.relative(workspaceRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Output path must stay within workspace: ${filePath}`);
  }
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, content, 'utf8');
}

export async function runCli(
  argv: string[] = process.argv.slice(2),
  runtime: CliRuntime = {}
): Promise<void> {
  const env = runtime.env ?? process.env;
  const writeStdout = runtime.writeStdout ?? ((chunk: string) => {
    process.stdout.write(chunk);
  });
  const parsed = parseCliArgs(argv, env);

  if (parsed.kind === 'help') {
    printHelp(writeStdout);
    return;
  }
  if (parsed.kind === 'version') {
    printVersion(writeStdout);
    return;
  }

  const config = parsed;
  const inputs = resolveInputs(config.inputEnv);
  const reporter = new ConsoleReporter();
  const telemetry = createTelemetryContext({
    action: 'azure-spec-discovery',
    actionVersion: resolveActionVersion(),
    logger: reporter
  });
  telemetry.setTeamId(resolveTelemetryTeamId(config.inputEnv));
  const { accountType } = await prepareTelemetryCredentials({
    postmanApiKey: config.inputEnv.INPUT_POSTMAN_API_KEY ?? env.POSTMAN_API_KEY,
    postmanAccessToken: config.inputEnv.INPUT_POSTMAN_ACCESS_TOKEN ?? env.POSTMAN_ACCESS_TOKEN
  });
  try {
    const sdkOptions = { requestTimeoutMs: inputs.requestTimeoutMs, maxAttempts: inputs.maxAttempts };
    const injected = runtime.dependencies;
    const credential = injected ? undefined : createAzureCredential();
    const result = await execute(
      inputs,
      injected
        ? { core: reporter, ...injected }
        : {
            core: reporter,
            subscriptions: new SubscriptionsSdkClient(credential!, sdkOptions),
            createApimClient: (subscriptionId) => new ApimSdkClient(credential!, subscriptionId, sdkOptions),
            createAppServiceClient: (subscriptionId) => new AppServiceSdkClient(credential!, subscriptionId, sdkOptions),
            createCustomApisClient: (subscriptionId) => new CustomApisSdkClient(credential!, subscriptionId, sdkOptions),
            createLogicWorkflowsClient: (subscriptionId) => new LogicWorkflowsSdkClient(credential!, subscriptionId, sdkOptions),
            createTemplateSpecsClient: (subscriptionId) => new TemplateSpecsSdkClient(credential!, subscriptionId, sdkOptions),
            createEventGridClient: (subscriptionId) => new EventGridSdkClient(credential!, subscriptionId, sdkOptions),
            createServiceBusClient: (subscriptionId) => new ServiceBusSdkClient(credential!, subscriptionId, sdkOptions),
            createFunctionsClient: (subscriptionId) => new FunctionsSdkClient(credential!, subscriptionId, sdkOptions),
            createResourceGraphClient: () => new ResourceGraphSdkClient(credential!, sdkOptions),
            writeSpecFile: defaultWriteSpecFile
          }
    );

    await writeOptionalFile(config.resultJsonPath, JSON.stringify(result, null, 2));
    await writeOptionalFile(config.dotenvPath, toDotenv(result.outputs));

    writeStdout(`${JSON.stringify(result, null, 2)}\n`);
    telemetry.setAccountType(accountType);
    telemetry.emitCompletion('success');
  } catch (error) {
    telemetry.setAccountType(accountType);
    telemetry.emitCompletion('failure');
    throw error;
  }
}

function shouldRunMain(): boolean {
  const cjsModule = typeof module !== 'undefined' ? module : undefined;
  const cjsRequire = typeof require !== 'undefined' ? require : undefined;
  if (cjsModule && cjsRequire && cjsRequire.main === cjsModule) {
    return true;
  }

  const currentModulePath = typeof __filename === 'string' ? __filename : '';
  const entrypointPath = process.argv[1];
  if (!currentModulePath || !entrypointPath) {
    return false;
  }
  try {
    return realpathSync(currentModulePath) === realpathSync(entrypointPath);
  } catch {
    return path.resolve(currentModulePath) === path.resolve(entrypointPath);
  }
}

if (shouldRunMain()) {
  runCli().catch((error) => {
    const message = formatUserSafeError(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
