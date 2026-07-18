#!/usr/bin/env node
/* global console, process */
// Renders the README inputs/outputs tables from action.yml between
// <!-- inputs-table:start --> / <!-- inputs-table:end --> and
// <!-- outputs-table:start --> / <!-- outputs-table:end --> markers.
// Usage: node scripts/render-action-tables.mjs [--check]

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const actionPath = resolve(repoRoot, 'action.yml');
const readmePath = resolve(repoRoot, 'README.md');

const action = parse(readFileSync(actionPath, 'utf8'));

const escapeCell = (value) => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ').trim();

function renderInputsTable(inputs) {
  const lines = ['| Name | Description | Required | Default |', '| --- | --- | --- | --- |'];
  for (const [name, spec] of Object.entries(inputs ?? {})) {
    const required = spec.required ? 'yes' : 'no';
    const def = spec.default === undefined || spec.default === '' ? 'n/a' : `\`${escapeCell(spec.default)}\``;
    lines.push(`| \`${name}\` | ${escapeCell(spec.description)} | ${required} | ${def} |`);
  }
  return lines.join('\n');
}

function renderOutputsTable(outputs) {
  const lines = ['| Name | Description |', '| --- | --- |'];
  for (const [name, spec] of Object.entries(outputs ?? {})) {
    lines.push(`| \`${name}\` | ${escapeCell(spec.description)} |`);
  }
  return lines.join('\n');
}

function replaceBetween(content, marker, table) {
  const start = `<!-- ${marker}:start -->`;
  const end = `<!-- ${marker}:end -->`;
  const startIdx = content.indexOf(start);
  const endIdx = content.indexOf(end);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(`README.md is missing ${start} / ${end} markers`);
  }
  return `${content.slice(0, startIdx + start.length)}\n${table}\n${content.slice(endIdx)}`;
}

const original = readFileSync(readmePath, 'utf8');
let updated = replaceBetween(original, 'inputs-table', renderInputsTable(action.inputs));
updated = replaceBetween(updated, 'outputs-table', renderOutputsTable(action.outputs));

if (process.argv.includes('--check')) {
  if (updated !== original) {
    console.error('README tables are out of date with action.yml. Run: npm run docs:tables');
    process.exit(1);
  }
  console.log('README tables match action.yml.');
} else if (updated !== original) {
  writeFileSync(readmePath, updated);
  console.log('README tables updated from action.yml.');
} else {
  console.log('README tables already up to date.');
}
