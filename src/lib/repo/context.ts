export type GitProvider = 'github' | 'gitlab' | 'bitbucket' | 'azure-devops' | 'unknown';

export interface RepoContextInput {
  repoUrl?: string;
  repoSlug?: string;
  gitProvider?: string;
  ref?: string;
  sha?: string;
}

export interface RepoContext {
  provider: GitProvider;
  repoUrl?: string;
  repoSlug?: string;
  ref?: string;
  sha?: string;
}

function normalize(value?: string): string | undefined {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeRepoUrl(url?: string): string | undefined {
  const raw = normalize(url);
  if (!raw) {
    return undefined;
  }

  const sshMatch = raw.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  if (sshMatch) {
    const host = sshMatch[1];
    const path = sshMatch[2];
    return `https://${host}/${path}`;
  }

  return raw.replace(/\.git$/, '');
}

function parseProvider(
  explicitProvider: string | undefined,
  repoUrl: string | undefined,
  env: NodeJS.ProcessEnv
): GitProvider {
  const explicit = normalize(explicitProvider)?.toLowerCase();
  if (explicit === 'github' || explicit === 'gitlab' || explicit === 'bitbucket' || explicit === 'azure-devops') {
    return explicit;
  }

  const url = (repoUrl ?? '').toLowerCase();
  if (url.includes('github')) {
    return 'github';
  }
  if (url.includes('gitlab')) {
    return 'gitlab';
  }
  if (url.includes('bitbucket')) {
    return 'bitbucket';
  }
  if (url.includes('dev.azure.com') || url.includes('visualstudio.com')) {
    return 'azure-devops';
  }

  if (normalize(env.GITHUB_REPOSITORY)) {
    return 'github';
  }
  if (normalize(env.CI_PROJECT_PATH) || normalize(env.GITLAB_CI)) {
    return 'gitlab';
  }
  if (normalize(env.BITBUCKET_REPO_SLUG)) {
    return 'bitbucket';
  }
  if (normalize(env.BUILD_REPOSITORY_URI)) {
    return 'azure-devops';
  }

  return 'unknown';
}

export function detectRepoContext(
  input: RepoContextInput,
  env: NodeJS.ProcessEnv = process.env
): RepoContext {
  const repoUrl =
    normalizeRepoUrl(input.repoUrl) ??
    normalizeRepoUrl(env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}` : undefined) ??
    normalizeRepoUrl(env.CI_PROJECT_URL) ??
    normalizeRepoUrl(env.BITBUCKET_GIT_HTTP_ORIGIN) ??
    normalizeRepoUrl(env.BUILD_REPOSITORY_URI);
  const repoSlug =
    normalize(input.repoSlug) ??
    normalize(env.GITHUB_REPOSITORY) ??
    normalize(env.CI_PROJECT_PATH) ??
    (env.BITBUCKET_WORKSPACE && env.BITBUCKET_REPO_SLUG
      ? normalize(`${env.BITBUCKET_WORKSPACE}/${env.BITBUCKET_REPO_SLUG}`)
      : undefined) ??
    normalize(env.BUILD_REPOSITORY_NAME);
  const ref =
    normalize(input.ref) ??
    normalize(env.GITHUB_REF_NAME) ??
    normalize(env.CI_COMMIT_REF_NAME) ??
    normalize(env.BITBUCKET_BRANCH) ??
    normalize(env.BUILD_SOURCEBRANCHNAME);
  const sha =
    normalize(input.sha) ??
    normalize(env.GITHUB_SHA) ??
    normalize(env.CI_COMMIT_SHA) ??
    normalize(env.BITBUCKET_COMMIT) ??
    normalize(env.BUILD_SOURCEVERSION);
  const provider = parseProvider(input.gitProvider, repoUrl, env);

  return {
    provider,
    repoUrl,
    repoSlug,
    ref,
    sha
  };
}
