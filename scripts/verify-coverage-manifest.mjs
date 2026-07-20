#!/usr/bin/env node
/**
 * Deterministic coverage claim gate for Azure spec discovery.
 *
 * The committed machine-readable claim manifest under coverage/route-claims.json
 * is the source of truth for every advertised route and every planned explicit
 * unsupported route. This verifier rejects claim drift without network access.
 *
 * Usage: node scripts/verify-coverage-manifest.mjs [repoRoot]
 */
import console from 'node:console';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const ADVERTISED_PROVIDERS = Object.freeze([
  'apim',
  'api-center',
  'app-service',
  'custom-apis',
  'logic-apps',
  'template-specs',
  'event-grid',
  'service-bus',
  'function-bindings',
  'iac-local'
]);

/**
 * Compare provider registration rows (from src/lib/providers/registry.ts) to
 * coverage manifest routes. Invoked from Vitest; the CLI path still validates
 * advertisedProviders against docs + routes.
 *
 * @param {{
 *   registrations: Array<{
 *     providerType: string,
 *     defaultContractClass: string,
 *     nativeFormats: string[],
 *     requiredCapability: string
 *   }>,
 *   manifest: { routes?: unknown }
 * }} input
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function verifyProviderRegistrationsAgainstManifest(input) {
  const errors = [];
  const routes = Array.isArray(input.manifest?.routes) ? input.manifest.routes : null;
  if (!routes) {
    return { ok: false, errors: ['manifest.routes must be an array'] };
  }
  const registrations = Array.isArray(input.registrations) ? input.registrations : [];
  const advertised = registrations.filter((row) => row && row.providerType !== 'runtime-declared');
  for (const expected of ADVERTISED_PROVIDERS) {
    if (!advertised.some((row) => row.providerType === expected)) {
      errors.push(`registration missing advertised provider ${expected}`);
    }
  }
  for (const registration of advertised) {
    const provider = registration.providerType;
    const providerRoutes = routes.filter((route) => route && route.provider === provider);
    if (providerRoutes.length === 0) {
      errors.push(`registration ${provider}: no coverage routes`);
      continue;
    }
    if (!providerRoutes.some((route) => route.contractClass === registration.defaultContractClass)) {
      errors.push(
        `registration ${provider}: defaultContractClass ${JSON.stringify(registration.defaultContractClass)} missing from coverage rows`
      );
    }
    if (!providerRoutes.some((route) => route.requiredCapability === registration.requiredCapability)) {
      errors.push(
        `registration ${provider}: requiredCapability ${JSON.stringify(registration.requiredCapability)} missing from coverage rows`
      );
    }
    const formats = new Set(
      providerRoutes.flatMap((route) => (Array.isArray(route.nativeFormats) ? route.nativeFormats : []))
    );
    if (
      !Array.isArray(registration.nativeFormats) ||
      !registration.nativeFormats.some((format) => formats.has(format))
    ) {
      errors.push(`registration ${provider}: nativeFormats do not intersect coverage rows`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export const CONTRACT_CLASSES = Object.freeze(
  new Set(['authoritative', 'reconstructed', 'partial', 'association-only', 'unsupported'])
);

export const VALIDATION_STATES = Object.freeze(
  new Set(['live', 'local-only', 'unit-only', 'unsupported'])
);

const MANIFEST_REL = path.join('coverage', 'route-claims.json');
const EVIDENCE_REL = path.join('validation', 'evidence', 'live-azure-surfaces.json');
const PROVIDERS_DOC_REL = path.join('docs', 'providers.md');

const REQUIRED_STRING_FIELDS = Object.freeze([
  'id',
  'provider',
  'route',
  'contractClass',
  'requiredCapability',
  'validationState'
]);

const REQUIRED_ARRAY_FIELDS = Object.freeze([
  'implementationFiles',
  'nativeFormats',
  'positiveTests',
  'negativeTests',
  'securityTests',
  'paginationTests'
]);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeRel(relPath) {
  return String(relPath).replace(/\\/g, '/');
}

export function isRemoteImplementationFile(relPath) {
  const n = normalizeRel(relPath);
  if (n === 'src/lib/providers/iac-local.ts') {
    return false;
  }
  if (n.startsWith('src/lib/providers/')) {
    return true;
  }
  if (n.startsWith('src/lib/azure/')) {
    return true;
  }
  if (n.startsWith('src/lib/estate/')) {
    return true;
  }
  if (n.includes('resource-graph')) {
    return true;
  }
  return false;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function pathExists(root, relPath) {
  return existsSync(path.join(root, relPath));
}

function advertisedProvidersFromDocs(root) {
  const docsPath = path.join(root, PROVIDERS_DOC_REL);
  if (!existsSync(docsPath)) {
    return null;
  }
  const text = readFileSync(docsPath, 'utf8');
  // Longer separators first so ", and `name`" is not truncated by ", ".
  const match = text.match(
    /ships ten providers:\s*((?:`[a-z0-9-]+`(?:,\s*and\s*| and |,\s*)?)+)/i
  );
  if (!match) {
    return null;
  }
  return [...match[1].matchAll(/`([a-z0-9-]+)`/g)].map((row) => row[1]);
}

/**
 * @param {{ root: string, manifest?: unknown, evidence?: unknown }} input
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function verifyCoverageManifest(input) {
  const root = path.resolve(input.root);
  const errors = [];

  let manifest = input.manifest;
  if (manifest === undefined) {
    const file = path.join(root, MANIFEST_REL);
    if (!existsSync(file)) {
      return { ok: false, errors: [`missing coverage claim manifest at ${MANIFEST_REL}`] };
    }
    try {
      manifest = readJson(file);
    } catch (error) {
      return {
        ok: false,
        errors: [`unable to parse ${MANIFEST_REL}: ${error instanceof Error ? error.message : error}`]
      };
    }
  }

  let evidence = input.evidence;
  if (evidence === undefined) {
    const file = path.join(root, EVIDENCE_REL);
    if (!existsSync(file)) {
      return { ok: false, errors: [`missing live evidence at ${EVIDENCE_REL}`] };
    }
    try {
      evidence = readJson(file);
    } catch (error) {
      return {
        ok: false,
        errors: [`unable to parse ${EVIDENCE_REL}: ${error instanceof Error ? error.message : error}`]
      };
    }
  }

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, errors: ['manifest root must be an object'] };
  }

  if (manifest.schemaVersion !== 1) {
    errors.push(`schemaVersion must be 1, found ${JSON.stringify(manifest.schemaVersion)}`);
  }

  const advertised = Array.isArray(manifest.advertisedProviders) ? manifest.advertisedProviders : null;
  if (!advertised) {
    errors.push('advertisedProviders must be an array');
  } else {
    if (advertised.length !== ADVERTISED_PROVIDERS.length) {
      errors.push(
        `advertisedProviders length ${advertised.length} does not match expected ${ADVERTISED_PROVIDERS.length}`
      );
    }
    for (let i = 0; i < ADVERTISED_PROVIDERS.length; i += 1) {
      if (advertised[i] !== ADVERTISED_PROVIDERS[i]) {
        errors.push(
          `advertisedProviders[${i}] must be ${ADVERTISED_PROVIDERS[i]}, found ${JSON.stringify(advertised[i])}`
        );
      }
    }
  }

  const docsProviders = advertisedProvidersFromDocs(root);
  if (docsProviders) {
    const expected = ADVERTISED_PROVIDERS.join(',');
    const found = docsProviders.join(',');
    if (found !== expected) {
      errors.push(
        `docs/providers.md advertised provider list drifted (found [${found}], expected [${expected}])`
      );
    }
  }

  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    errors.push('live evidence root must be an object');
    return { ok: false, errors };
  }

  // Evidence schema 1 (legacy) or 2 (R8). Only status=pass backs live claims.
  // requires-capability / local-only / fail never promote validationState=live.
  if (evidence.schemaVersion !== 1 && evidence.schemaVersion !== 2) {
    errors.push(`live evidence schemaVersion must be 1 or 2, found ${JSON.stringify(evidence.schemaVersion)}`);
  }

  const evidenceResults = Array.isArray(evidence.results) ? evidence.results : [];
  const passingEvidence = new Set(
    evidenceResults
      .filter((row) => row && typeof row === 'object' && row.status === 'pass')
      .map((row) => {
        if (isNonEmptyString(row.name)) return row.name;
        if (isNonEmptyString(row.id)) return row.id;
        return '';
      })
      .filter((name) => name.length > 0)
  );

  const routes = Array.isArray(manifest.routes) ? manifest.routes : null;
  if (!routes) {
    errors.push('routes must be an array');
    return { ok: false, errors };
  }

  const seenIds = new Set();
  const providersWithRoutes = new Set();

  for (let index = 0; index < routes.length; index += 1) {
    const route = routes[index];
    const label = route && typeof route === 'object' && isNonEmptyString(route.id) ? route.id : `#${index}`;

    if (!route || typeof route !== 'object' || Array.isArray(route)) {
      errors.push(`route ${label}: must be an object`);
      continue;
    }

    for (const field of REQUIRED_STRING_FIELDS) {
      if (!isNonEmptyString(route[field])) {
        errors.push(`route ${label}: ${field} must be a non-empty string`);
      }
    }

    for (const field of REQUIRED_ARRAY_FIELDS) {
      if (!Array.isArray(route[field])) {
        errors.push(`route ${label}: ${field} must be an array`);
      } else if (route[field].some((entry) => !isNonEmptyString(entry))) {
        errors.push(`route ${label}: ${field} entries must be non-empty strings`);
      }
    }

    if (isNonEmptyString(route.id)) {
      if (seenIds.has(route.id)) {
        errors.push(`duplicate id: ${route.id}`);
      }
      seenIds.add(route.id);
    }

    if (isNonEmptyString(route.provider)) {
      providersWithRoutes.add(route.provider);
    }

    if (isNonEmptyString(route.contractClass) && !CONTRACT_CLASSES.has(route.contractClass)) {
      errors.push(`route ${label}: invalid contract class ${JSON.stringify(route.contractClass)}`);
    }

    if (isNonEmptyString(route.validationState) && !VALIDATION_STATES.has(route.validationState)) {
      errors.push(`route ${label}: invalid validation state ${JSON.stringify(route.validationState)}`);
    }

    const contractClass = route.contractClass;
    const validationState = route.validationState;
    const unsupportedReason =
      typeof route.unsupportedReason === 'string' ? route.unsupportedReason.trim() : route.unsupportedReason;
    const liveEvidenceCase =
      typeof route.liveEvidenceCase === 'string' ? route.liveEvidenceCase.trim() : route.liveEvidenceCase;

    if (contractClass === 'unsupported' && validationState !== 'unsupported') {
      errors.push(
        `route ${label}: unsupported contract class requires validationState unsupported (found ${JSON.stringify(validationState)})`
      );
    }
    if (validationState === 'unsupported' && contractClass !== 'unsupported') {
      errors.push(
        `route ${label}: unsupported validation state requires contract class unsupported (found ${JSON.stringify(contractClass)})`
      );
    }

    if (contractClass === 'unsupported' || validationState === 'unsupported') {
      if (!isNonEmptyString(unsupportedReason)) {
        errors.push(`route ${label}: unsupportedReason is required for unsupported rows`);
      }
    } else if (unsupportedReason !== null && unsupportedReason !== undefined && unsupportedReason !== '') {
      errors.push(`route ${label}: unsupportedReason must be null/empty unless the row is unsupported`);
    }

    const plannedLiveEvidenceCase =
      typeof route.plannedLiveEvidenceCase === 'string'
        ? route.plannedLiveEvidenceCase.trim()
        : route.plannedLiveEvidenceCase;

    if (validationState === 'live') {
      if (!isNonEmptyString(liveEvidenceCase)) {
        errors.push(`route ${label}: liveEvidenceCase is required when validationState is live`);
      } else if (!passingEvidence.has(liveEvidenceCase)) {
        errors.push(
          `route ${label}: live evidence case ${JSON.stringify(liveEvidenceCase)} is missing or not passing in ${EVIDENCE_REL}`
        );
      }
    } else if (isNonEmptyString(liveEvidenceCase)) {
      errors.push(
        `route ${label}: liveEvidenceCase is only allowed when validationState is live (found ${JSON.stringify(liveEvidenceCase)})`
      );
    }

    // plannedLiveEvidenceCase maps harness case ids while status stays unit-only.
    if (plannedLiveEvidenceCase !== null && plannedLiveEvidenceCase !== undefined && plannedLiveEvidenceCase !== '') {
      if (!isNonEmptyString(plannedLiveEvidenceCase)) {
        errors.push(`route ${label}: plannedLiveEvidenceCase must be a non-empty string when set`);
      } else if (validationState === 'live') {
        errors.push(`route ${label}: plannedLiveEvidenceCase is not used when validationState is live (use liveEvidenceCase)`);
      }
    }

    if (Array.isArray(route.implementationFiles)) {
      for (const file of route.implementationFiles) {
        if (!isNonEmptyString(file)) continue;
        if (!pathExists(root, file)) {
          errors.push(`route ${label}: missing implementation file ${file}`);
        }
      }
      if (validationState === 'local-only') {
        const remoteFiles = route.implementationFiles
          .filter((file) => isNonEmptyString(file) && isRemoteImplementationFile(file))
          .map(normalizeRel);
        if (remoteFiles.length > 0) {
          errors.push(
            `route ${label}: local-only rows must not list remote implementation files (${remoteFiles.join(', ')})`
          );
        }
      }
    }

    for (const field of ['positiveTests', 'negativeTests', 'securityTests', 'paginationTests']) {
      if (!Array.isArray(route[field])) continue;
      for (const file of route[field]) {
        if (!isNonEmptyString(file)) continue;
        if (!pathExists(root, file)) {
          errors.push(`route ${label}: missing test file ${file} (${field})`);
        }
      }
    }

    // Implemented (non-unsupported) routes must declare at least one positive test.
    if (contractClass !== 'unsupported' && Array.isArray(route.positiveTests) && route.positiveTests.length === 0) {
      errors.push(`route ${label}: positiveTests must not be empty unless unsupported`);
    }
  }

  for (const provider of ADVERTISED_PROVIDERS) {
    if (!providersWithRoutes.has(provider)) {
      errors.push(`advertised provider route missing from manifest: ${provider}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

function main(argv) {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const defaultRoot = path.resolve(scriptDir, '..');
  const root = path.resolve(argv[2] ?? defaultRoot);
  const result = verifyCoverageManifest({ root });
  if (!result.ok) {
    for (const error of result.errors) {
      console.error(`verify-coverage-manifest: ${error}`);
    }
    process.exit(1);
  }
  console.log('verify-coverage-manifest: ok');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv);
}
