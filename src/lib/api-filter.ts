import { RE2JS } from 're2js';

const MAX_API_FILTER_CHARS = 1_024;

export interface ApiFilter {
  test(value: string): boolean;
}

/** Compile caller-controlled filters with a linear-time regular-expression engine. */
export function compileApiFilter(pattern: string): ApiFilter {
  if (pattern.length > MAX_API_FILTER_CHARS) {
    throw new Error(`api-filter must be at most ${MAX_API_FILTER_CHARS} characters`);
  }
  return RE2JS.compile(pattern);
}
