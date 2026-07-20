import type { TokenCredential } from '@azure/identity';

import {
  computeBoundedRetryDelayMs,
  isTransientHttpStatus,
  sleep as defaultSleep
} from '../retry.js';
import {
  armManagementUrl,
  assertSafeArmNextLink,
  resolveAzureCloudProfile,
  type AzureCloudProfile
} from './cloud.js';
import type { AzureSdkOptions } from './clients.js';

/** Absolute ceiling on pages consumed from any Azure list/pagination surface. */
export const MAX_ARM_LIST_PAGES = 100;

export interface ArmRestClientOptions {
  maxAttempts: number;
  requestTimeoutMs: number;
  sleep: (delayMs: number) => Promise<void>;
  random: () => number;
  cloud: AzureCloudProfile;
}

export function createArmRestClientOptions(options?: AzureSdkOptions): ArmRestClientOptions {
  return {
    maxAttempts: options?.maxAttempts ?? 3,
    requestTimeoutMs: options?.requestTimeoutMs ?? 30000,
    sleep: options?.sleep ?? defaultSleep,
    random: options?.random ?? Math.random,
    cloud: resolveAzureCloudProfile()
  };
}

export async function getArmAccessToken(credential: TokenCredential, cloud: AzureCloudProfile): Promise<string> {
  const token = await credential.getToken(cloud.armTokenScope);
  if (!token) {
    throw new Error('Azure credential produced no ARM token');
  }
  return token.token;
}

export function extractResourceGroup(resourceId: string | undefined): string {
  const match = /\/resourceGroups\/([^/]+)\//i.exec(resourceId ?? '');
  return match?.[1] ?? '';
}

export function takeNextLink(
  nextLink: string | undefined,
  currentUrl: string,
  seen: Set<string>,
  cloud: AzureCloudProfile,
  operation: string
): string | undefined {
  if (nextLink === undefined) return undefined;
  if (nextLink === currentUrl || seen.has(nextLink)) {
    throw new Error(`${operation} pagination returned a repeated nextLink; aborting`);
  }
  const safe = assertSafeArmNextLink(nextLink, cloud, operation);
  seen.add(currentUrl);
  return safe;
}

export interface ArmRequestOptions {
  maxAttempts: number;
  requestTimeoutMs: number;
  operation: string;
  signal?: AbortSignal;
  sleep?: (delayMs: number) => Promise<void>;
  random?: () => number;
  method?: string;
  body?: string;
  /** When true, throw on non-OK HTTP instead of returning the response. */
  throwOnHttpError?: boolean;
  /** Extra headers (never used to inject caller Authorization — that is set here). */
  headers?: Record<string, string>;
}

export async function armRequest(url: string, token: string, options: ArmRequestOptions): Promise<Response> {
  const sleepFn = options.sleep ?? defaultSleep;
  const randomFn = options.random ?? Math.random;
  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    options.signal?.throwIfAborted();
    const requestSignal = AbortSignal.any([
      AbortSignal.timeout(options.requestTimeoutMs),
      ...(options.signal ? [options.signal] : [])
    ]);
    try {
      const response = await fetch(url, {
        method: options.method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(options.headers ?? {})
        },
        body: options.body,
        signal: requestSignal
      });
      if (response.ok) return response;
      if (!isTransientHttpStatus(response.status)) {
        if (options.throwOnHttpError) {
          throw new Error(`${options.operation} failed with HTTP ${response.status}`);
        }
        return response;
      }
      if (attempt === options.maxAttempts) {
        if (options.throwOnHttpError) {
          throw new Error(`${options.operation} failed with HTTP ${response.status}`);
        }
        return response;
      }
      const delayMs = computeBoundedRetryDelayMs({
        attempt,
        retryAfterHeader: response.headers.get('retry-after'),
        random: randomFn
      });
      await sleepFn(delayMs);
    } catch (error) {
      if (
        error instanceof Error &&
        /failed with HTTP [1-4]/.test(error.message) &&
        !/HTTP (408|429)/.test(error.message)
      ) {
        throw error;
      }
      if (options.signal?.aborted) throw error;
      if (attempt === options.maxAttempts) {
        throw new Error(`${options.operation} failed after ${attempt} attempt(s)`, { cause: error });
      }
      const delayMs = computeBoundedRetryDelayMs({ attempt, random: randomFn });
      await sleepFn(delayMs);
    }
  }
  throw new Error(`${options.operation} exhausted its attempt limit`);
}

export async function listArmPages<T>(
  firstUrl: string,
  token: string,
  operation: string,
  options: ArmRestClientOptions,
  signal?: AbortSignal
): Promise<T[]> {
  let url: string | undefined = firstUrl;
  const entries: T[] = [];
  const seen = new Set<string>();
  let pages = 0;
  while (url) {
    pages += 1;
    if (pages > MAX_ARM_LIST_PAGES) {
      throw new Error(`${operation} pagination exceeded ${MAX_ARM_LIST_PAGES} pages; aborting`);
    }
    const response = await armRequest(url, token, {
      maxAttempts: options.maxAttempts,
      requestTimeoutMs: options.requestTimeoutMs,
      operation,
      signal,
      sleep: options.sleep,
      random: options.random
    });
    if (!response.ok) {
      throw new Error(`${operation} failed with HTTP ${response.status}`);
    }
    const body = (await response.json()) as { value?: T[]; nextLink?: string };
    entries.push(...(body.value ?? []));
    url = takeNextLink(body.nextLink, url, seen, options.cloud, operation);
  }
  return entries;
}

export function armUrl(cloud: AzureCloudProfile, pathAndQuery: string): string {
  return armManagementUrl(cloud, pathAndQuery);
}
