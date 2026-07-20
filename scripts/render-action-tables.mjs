#!/usr/bin/env node
/* global console, process */
// Renders README tables from action.yml and coverage/route-claims.json between
// <!-- inputs-table:start --> / <!-- inputs-table:end -->,
// <!-- outputs-table:start --> / <!-- outputs-table:end -->, and
// <!-- coverage-table:start --> / <!-- coverage-table:end --> markers.
// Usage: node scripts/render-action-tables.mjs [--check]

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const actionPath = resolve(repoRoot, 'action.yml');
const readmePath = resolve(repoRoot, 'README.md');
const claimsPath = resolve(repoRoot, 'coverage', 'route-claims.json');

const escapeCell = (value) => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ').trim();

export function renderInputsTable(inputs) {
  const lines = ['| Name | Description | Required | Default |', '| --- | --- | --- | --- |'];
  for (const [name, spec] of Object.entries(inputs ?? {})) {
    const required = spec.required ? 'yes' : 'no';
    const def = spec.default === undefined || spec.default === '' ? 'n/a' : `\`${escapeCell(spec.default)}\``;
    lines.push(`| \`${name}\` | ${escapeCell(spec.description)} | ${required} | ${def} |`);
  }
  return lines.join('\n');
}

export function renderOutputsTable(outputs) {
  const lines = ['| Name | Description |', '| --- | --- |'];
  for (const [name, spec] of Object.entries(outputs ?? {})) {
    lines.push(`| \`${name}\` | ${escapeCell(spec.description)} |`);
  }
  return lines.join('\n');
}

/**
 * Support/validation labels derived only from coverage/route-claims.json.
 * Does not invent live promotions beyond committed validationState values.
 */
export function renderCoverageTable(manifest) {
  const routes = Array.isArray(manifest?.routes) ? manifest.routes : [];
  const lines = [
    '| Route | Provider | Contract | Validation | Evidence mapping |',
    '| --- | --- | --- | --- | --- |'
  ];
  for (const route of routes) {
    const validation = route.validationState ?? '';
    let mapping = '—';
    if (validation === 'live' && route.liveEvidenceCase) {
      mapping = `live:\`${route.liveEvidenceCase}\``;
    } else if (route.plannedLiveEvidenceCase) {
      mapping = `planned:\`${route.plannedLiveEvidenceCase}\``;
    } else if (route.localOnlyRationale) {
      mapping = 'local-only rationale';
    } else if (validation === 'unsupported') {
      mapping = 'unsupported';
    }
    lines.push(
      `| \`${escapeCell(route.id)}\` | \`${escapeCell(route.provider)}\` | ${escapeCell(route.contractClass)} | ${escapeCell(validation)} | ${escapeCell(mapping)} |`
    );
  }
  return lines.join('\n');
}

export function replaceBetween(content, marker, table) {
  const start = `<!-- ${marker}:start -->`;
  const end = `<!-- ${marker}:end -->`;
  const startIdx = content.indexOf(start);
  const endIdx = content.indexOf(end);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(`README.md is missing ${start} / ${end} markers`);
  }
  return `${content.slice(0, startIdx + start.length)}\n${table}\n${content.slice(endIdx)}`;
}

function main(argv) {
  const action = parse(readFileSync(actionPath, 'utf8'));
  const claims = JSON.parse(readFileSync(claimsPath, 'utf8'));
  const original = readFileSync(readmePath, 'utf8');
  let updated = replaceBetween(original, 'inputs-table', renderInputsTable(action.inputs));
  updated = replaceBetween(updated, 'outputs-table', renderOutputsTable(action.outputs));
  updated = replaceBetween(updated, 'coverage-table', renderCoverageTable(claims));

  if (argv.includes('--check')) {
    if (updated !== original) {
      console.error('README tables are out of date with action.yml / coverage/route-claims.json. Run: npm run docs:tables');
      process.exit(1);
    }
    console.log('README tables match action.yml and coverage/route-claims.json.');
  } else if (updated !== original) {
    writeFileSync(readmePath, updated);
    console.log('README tables updated from action.yml and coverage/route-claims.json.');
  } else {
    console.log('README tables already up to date.');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv);
}
