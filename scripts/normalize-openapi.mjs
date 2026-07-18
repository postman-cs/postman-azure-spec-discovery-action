#!/usr/bin/env node
/* global console, process */
// Standalone CLI for the OpenAPI operationId normalizer.
//
// Usage:
//   node scripts/normalize-openapi.mjs <spec.yaml> [more.yaml...]
//
// Exit codes:
//   0  All inputs processed (whether or not any renames were applied).
//   1  At least one input could not be read.
//
// Intended for downstream pipelines that want to apply the same dedupe/
// synthesis logic this action runs during AWS Gateway export, without
// bringing the AWS SDK along. We deliberately import directly from the
// source so dist/ rebuilds aren't required to consume this from a
// `git clone` checkout.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// Load the normalizer from the bundled dist. The dist is checked into
// the repo and built deterministically by `npm run build`, so consumers
// can `git clone` and invoke this script without any install step.
async function loadNormalizer() {
  const distUrl = pathToFileURL(path.join(here, '..', 'dist', 'index.cjs')).href;
  return await import(distUrl);
}

async function main() {
  const inputs = process.argv.slice(2);
  if (inputs.length === 0) {
    console.error('Usage: normalize-openapi.mjs <spec.yaml> [more.yaml...]');
    process.exit(64);
  }

  const { normalizeOpenApiYaml } = await loadNormalizer();
  let errored = false;

  for (const input of inputs) {
    let raw;
    try {
      raw = await readFile(input, 'utf8');
    } catch (error) {
      console.error(`error: could not read ${input}: ${error.message ?? error}`);
      errored = true;
      continue;
    }

    const result = normalizeOpenApiYaml(raw);
    if (!result.normalized) {
      console.error(`skipped: ${input} (not a recognizable OpenAPI YAML document)`);
      continue;
    }
    if (result.renamed.length === 0) {
      console.log(`unchanged: ${input} (operationIds already unique)`);
      continue;
    }

    await writeFile(input, result.content, 'utf8');
    console.log(`rewrote: ${input} (${result.renamed.length} operationId rename(s))`);
    for (const rename of result.renamed) {
      const from = rename.original === null ? '<missing>' : rename.original;
      console.log(`  ${rename.method.toUpperCase()} ${rename.path}: \`${from}\` -> \`${rename.renamed}\``);
    }
  }

  if (errored) process.exit(1);
}

main().catch((error) => {
  console.error(`fatal: ${error?.stack ?? error}`);
  process.exit(1);
});
