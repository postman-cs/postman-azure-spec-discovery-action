import type { ProviderProbeStatus } from '../../contracts.js';
import type { AzureTemplateSpecsClient, DeploymentSummary } from '../azure/clients.js';
import { parseAndValidateOpenApi } from '../spec/validate-openapi.js';
import type { SpecCandidate, SpecCandidateHeader, SpecExportResult, SpecProvider } from './types.js';
import { listCandidatesViaHydration } from './types.js';

export interface TemplateSpecsProviderOptions {
  resourceGroup?: string;
}

function isAuthorizationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /authorizationfailed|forbidden|401|403/i.test(message);
}

const APIM_API_TYPE = 'microsoft.apimanagement/service/apis';
const DEPLOYMENT_SCRIPTS_TYPE = 'microsoft.resources/deploymentscripts';
const NESTED_DEPLOYMENT_TYPE = 'microsoft.resources/deployments';

interface ArmTemplateResource {
  type?: unknown;
  name?: unknown;
  properties?: { value?: unknown; format?: unknown; template?: unknown; [k: string]: unknown };
  resources?: unknown;
  [k: string]: unknown;
}

interface EmbeddedSpec {
  resourceName: string;
  content: string;
  withheld: boolean;
}

interface TemplateExtraction {
  specs: EmbeddedSpec[];
}

/**
 * Collect the string forms of secure parameter defaults (secureString /
 * secureObject with a defaultValue) so extracted documents that embed one can
 * be withheld instead of exported.
 */
function collectSecureDefaults(template: Record<string, unknown>, into: Set<string>): void {
  const parameters = template.parameters;
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return;
  for (const definition of Object.values(parameters as Record<string, unknown>)) {
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) continue;
    const record = definition as { type?: unknown; defaultValue?: unknown };
    const type = typeof record.type === 'string' ? record.type.toLowerCase() : '';
    if (!type.startsWith('secure')) continue;
    const defaultValue = record.defaultValue;
    if (defaultValue === undefined || defaultValue === null) continue;
    const serialized = typeof defaultValue === 'string' ? defaultValue : JSON.stringify(defaultValue);
    if (serialized && serialized.length > 0) into.add(serialized);
  }
}

function extractInlineContent(value: unknown): string | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const serialized = `${JSON.stringify(value, null, 2)}\n`;
    try {
      parseAndValidateOpenApi(serialized);
      return serialized;
    } catch {
      return undefined;
    }
  }
  if (typeof value === 'string' && value.trim()) {
    try {
      parseAndValidateOpenApi(value);
      return value.endsWith('\n') ? value : `${value}\n`;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Walk a template (and templates nested inside Microsoft.Resources/deployments
 * resources) for APIM API resources carrying inline OpenAPI/Swagger documents.
 *
 * Hygiene is structural: Microsoft.Resources/deploymentScripts subtrees are
 * never entered (their properties carry scriptContent and environment
 * variables), and an extracted document that contains a secure parameter
 * default is withheld from export instead of surfaced.
 */
export function extractApimInlineSpecs(template: unknown): TemplateExtraction {
  const specs: EmbeddedSpec[] = [];
  if (!template || typeof template !== 'object' || Array.isArray(template)) {
    return { specs };
  }
  const secureDefaults = new Set<string>();

  const walkTemplate = (doc: Record<string, unknown>): void => {
    collectSecureDefaults(doc, secureDefaults);
    const resources = doc.resources;
    if (!Array.isArray(resources)) return;
    for (const resource of resources) {
      if (resource && typeof resource === 'object' && !Array.isArray(resource)) {
        walkResource(resource as ArmTemplateResource, []);
      }
    }
  };

  const walkResource = (resource: ArmTemplateResource, chain: string[]): void => {
    const type = typeof resource.type === 'string' ? resource.type : '';
    const name = typeof resource.name === 'string' ? resource.name : '';
    const fullType = (chain.length > 0 ? `${chain.join('/')}/${type}` : type).toLowerCase();

    if (fullType === DEPLOYMENT_SCRIPTS_TYPE) {
      return; // deploymentScripts content (scriptContent, env) is never read
    }

    if (fullType === NESTED_DEPLOYMENT_TYPE) {
      const nestedTemplate = resource.properties?.template;
      if (nestedTemplate && typeof nestedTemplate === 'object' && !Array.isArray(nestedTemplate)) {
        walkTemplate(nestedTemplate as Record<string, unknown>);
      }
      return;
    }

    if (fullType === APIM_API_TYPE) {
      const format = typeof resource.properties?.format === 'string' ? resource.properties.format.toLowerCase() : '';
      const value = resource.properties?.value;
      const isInlineFormat = (format.includes('openapi') || format.includes('swagger')) && !format.includes('link');
      if (isInlineFormat && value !== undefined) {
        const content = extractInlineContent(value);
        if (content) {
          specs.push({ resourceName: name || 'apim-api', content, withheld: false });
        }
      }
    }

    const nested = resource.resources;
    if (Array.isArray(nested)) {
      for (const child of nested) {
        if (child && typeof child === 'object' && !Array.isArray(child)) {
          walkResource(child as ArmTemplateResource, [...chain, type]);
        }
      }
    }
  };

  walkTemplate(template as Record<string, unknown>);

  for (const spec of specs) {
    for (const secret of secureDefaults) {
      if (spec.content.includes(secret)) {
        spec.withheld = true;
        spec.content = '';
        break;
      }
    }
  }
  return { specs };
}

/**
 * Template Specs provider (Microsoft.Resources/templateSpecs/versions).
 *
 * Enumerates template spec versions with Reader GETs, walks each version's
 * mainTemplate (including nested deployment templates) for APIM API resources
 * carrying inline OpenAPI documents, and exports those documents. Resource
 * group deployment history (deployments.list, a Reader GET) contributes
 * "referenced by deployment" evidence only; exportTemplate (an action) is
 * never called, and deploymentScripts content is never read.
 *
 * Every export is declared completeness: partial -- an embedded document may
 * carry unresolved ARM template expressions, so it is not guaranteed to equal
 * the deployed literal.
 */
export class TemplateSpecsProvider implements SpecProvider {
  public readonly type = 'template-specs' as const;

  private readonly client: AzureTemplateSpecsClient;
  private readonly options: TemplateSpecsProviderOptions;

  public constructor(client: AzureTemplateSpecsClient, options: TemplateSpecsProviderOptions = {}) {
    this.client = client;
    this.options = options;
  }

  public async probe(signal?: AbortSignal): Promise<ProviderProbeStatus> {
    try {
      await this.client.probeTemplateSpecsReadAccess(this.options.resourceGroup, signal);
      return 'available';
    } catch (error) {
      return isAuthorizationError(error) ? 'skipped:iam' : 'skipped:error';
    }
  }

  public async listCandidateHeaders(): Promise<SpecCandidateHeader[]> {
    const templateSpecs = await this.client.listTemplateSpecs(this.options.resourceGroup);
    const headers: SpecCandidateHeader[] = [];
    for (const templateSpec of templateSpecs) {
      const versions = await this.client.listVersions(templateSpec.resourceGroup, templateSpec.name);
      for (const version of versions) {
        headers.push({
          id: version.id,
          name: `${templateSpec.name}@${version.name}`,
          providerType: 'template-specs',
          resourceGroup: templateSpec.resourceGroup,
          tags: templateSpec.tags,
          supported: true,
          headerHydrated: false,
          evidence: [
            `Template spec ${templateSpec.name} version ${version.name} enumerated; mainTemplate detail deferred until selected`
          ],
          meta: {
            templateSpecName: templateSpec.name,
            versionName: version.name,
            resourceGroup: templateSpec.resourceGroup,
            hydrationPending: 'true'
          }
        });
      }
    }
    return headers;
  }

  public async hydrateCandidates(headers: SpecCandidateHeader[]): Promise<SpecCandidate[]> {
    const deploymentsByGroup = new Map<string, DeploymentSummary[]>();
    const candidates: SpecCandidate[] = [];
    for (const header of headers) {
      const templateSpecName = header.meta.templateSpecName ?? '';
      const versionName = header.meta.versionName ?? '';
      const resourceGroup = header.meta.resourceGroup ?? header.resourceGroup ?? '';
      if (!templateSpecName || !versionName || !resourceGroup) {
        throw new Error('Template spec header is missing resource coordinates');
      }
      const mainTemplate = await this.client.getVersionMainTemplate(resourceGroup, templateSpecName, versionName);
      const extraction = extractApimInlineSpecs(mainTemplate);
      const deployedBy = await this.deploymentsReferencing(resourceGroup, header.id, deploymentsByGroup);
      const deploymentEvidence =
        deployedBy.length > 0 ? [`Referenced by deployment(s): ${deployedBy.join(', ')}`] : [];
      const exportable = extraction.specs.filter((spec) => !spec.withheld);
      const withheldCount = extraction.specs.length - exportable.length;

      if (exportable.length === 0) {
        candidates.push({
          id: header.id,
          name: header.name,
          providerType: 'template-specs',
          resourceGroup,
          tags: header.tags,
          supported: false,
          evidence: [
            withheldCount > 0
              ? `Template spec ${templateSpecName} version ${versionName} embeds ${withheldCount} APIM document(s) withheld for referencing secure parameter defaults`
              : `Template spec ${templateSpecName} version ${versionName} embeds no inline APIM OpenAPI document`,
            ...deploymentEvidence
          ],
          meta: {
            templateSpecName,
            versionName,
            resourceGroup
          }
        });
        continue;
      }

      for (const spec of exportable) {
        candidates.push({
          id: `${header.id}#${spec.resourceName}`,
          name: `${templateSpecName}@${versionName}/${spec.resourceName}`,
          providerType: 'template-specs',
          resourceGroup,
          tags: header.tags,
          supported: true,
          evidence: [
            `Template spec ${templateSpecName} version ${versionName} embeds inline APIM OpenAPI document in resource ${spec.resourceName}`,
            ...(withheldCount > 0
              ? [`${withheldCount} sibling document(s) withheld for referencing secure parameter defaults`]
              : []),
            ...deploymentEvidence
          ],
          meta: {
            templateSpecName,
            versionName,
            resourceGroup,
            resourceName: spec.resourceName,
            inlineContent: spec.content
          }
        });
      }
    }
    return candidates;
  }

  public listCandidates(): Promise<SpecCandidate[]> {
    return listCandidatesViaHydration(this);
  }

  public async exportSpec(candidate: SpecCandidate): Promise<SpecExportResult> {
    if (!candidate.supported) {
      throw new Error(`Template spec version ${candidate.name} has no exportable inline APIM document`);
    }
    const inline = candidate.meta.inlineContent ?? '';
    if (!inline) {
      throw new Error(`Template spec candidate ${candidate.name} is missing its extracted document`);
    }
    const parsed = parseAndValidateOpenApi(inline);
    const normalized = `${JSON.stringify(parsed.document, null, 2)}\n`;
    return {
      content: normalized,
      format: 'openapi-json',
      filename: 'index.json',
      completeness: 'partial',
      evidence: [
        `Extracted inline APIM document ${candidate.meta.resourceName ?? ''} from template spec ${candidate.meta.templateSpecName ?? ''} version ${candidate.meta.versionName ?? ''}`,
        'Declared partial: embedded template documents may carry unresolved ARM template expressions'
      ]
    };
  }

  private async deploymentsReferencing(
    resourceGroup: string,
    versionId: string,
    cache: Map<string, DeploymentSummary[]>
  ): Promise<string[]> {
    let deployments = cache.get(resourceGroup);
    if (!deployments) {
      try {
        deployments = await this.client.listDeployments(resourceGroup);
      } catch {
        deployments = []; // deployment history is evidence only; enumeration stays fail-soft
      }
      cache.set(resourceGroup, deployments);
    }
    const target = versionId.toLowerCase();
    return deployments
      .filter((deployment) => (deployment.templateSpecVersionId ?? '').toLowerCase() === target)
      .map((deployment) => deployment.name);
  }
}
