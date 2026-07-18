
import { describe, expect, it } from 'vitest';

import { parseCliArgs, toDotenv } from '../src/cli.js';
import { contractOutputNames } from '../src/contracts.js';

describe('CLI argument parsing', () => {
  it('AZ-CLI-001: help/version parse alone; unknown, duplicate, missing-value, positional, and combined flags reject', () => {
    expect(parseCliArgs(['--help'], {})).toEqual({ kind: 'help' });
    expect(parseCliArgs(['--version'], {})).toEqual({ kind: 'version' });

    expect(() => parseCliArgs(['--nope'], {})).toThrow('Unknown option: --nope');
    expect(() => parseCliArgs(['--mode', 'resolve-one', '--mode', 'resolve-one'], {})).toThrow('Duplicate option: --mode');
    expect(() => parseCliArgs(['--mode'], {})).toThrow('Missing value for --mode');
    expect(() => parseCliArgs(['positional'], {})).toThrow('Unexpected positional argument: positional');
    expect(() => parseCliArgs(['--help', '--version'], {})).toThrow('cannot be combined');

    const run = parseCliArgs(['--subscription-id', 'sub-1', '--result-json', 'out/result.json'], {});
    expect(run.kind).toBe('run');
    if (run.kind === 'run') {
      expect(run.inputEnv.INPUT_SUBSCRIPTION_ID).toBe('sub-1');
      expect(run.resultJsonPath).toBe('out/result.json');
    }
  });
});

describe('dotenv serialization', () => {
  it('AZ-CLI-002: all 22 outputs serialize as unique POSTMAN_AZURE_SPEC_* lines with JSON-quoted values', () => {
    const outputs: Record<string, string> = {};
    for (const name of contractOutputNames) {
      outputs[name] = `value-of-${name}`;
    }
    const dotenv = toDotenv(outputs);
    const lines = dotenv.split('\n');

    expect(lines).toHaveLength(22);
    const keys = lines.map((line) => line.split('=')[0]);
    expect(new Set(keys).size).toBe(22);
    for (const key of keys) {
      expect(key).toMatch(/^POSTMAN_AZURE_SPEC_/);
    }
    expect(keys).toContain('POSTMAN_AZURE_SPEC_API_ID');
    expect(dotenv).not.toContain('POSTMAN_AWS_');
    expect(dotenv).not.toContain('GATEWAY_ID');
    for (const line of lines) {
      const value = line.slice(line.indexOf('=') + 1);
      expect(() => JSON.parse(value)).not.toThrow();
    }
  });
});
