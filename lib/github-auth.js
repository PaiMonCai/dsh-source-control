/**
 * Host-only opt-in GitHub authentication.
 * The token is read from the HOST environment at request time, never from
 * profile YAML, Git remotes, browser requests or agent arguments.
 *
 * IMPORTANT: credentials are HOST-scoped, not per DSH user. An approved repo
 * may be accessed by any authenticated DSH Web user who can select it. Do not
 * enable in untrusted multi-user deployments; use per-user OAuth instead.
 */
export const TOKEN_ENV = 'DSH_SOURCE_CONTROL_GITHUB_TOKEN';

const validSlug = (s) => typeof s === 'string' &&
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s) &&
  !s.split('/').some((part) => part === '.' || part === '..');

export function resolveGitHubAuth(raw) {
  if (raw === undefined) return { repositories: [], allowWrites: false };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      Object.keys(raw).some((key) => !['repositories', 'allowWrites'].includes(key))) {
    throw new Error('githubAuth accepts only repositories and allowWrites');
  }
  if (!Array.isArray(raw.repositories) || raw.repositories.length === 0 ||
      raw.repositories.length > 30 || raw.repositories.some((name) => !validSlug(name))) {
    throw new Error('githubAuth.repositories must contain 1–30 explicit GitHub owner/repo names');
  }
  if (raw.allowWrites !== undefined && typeof raw.allowWrites !== 'boolean') {
    throw new Error('githubAuth.allowWrites must be boolean');
  }
  const normalized = raw.repositories.map((name) => name.toLowerCase());
  if (new Set(normalized).size !== normalized.length) throw new Error('duplicate GitHub authorization repositories');
  return { repositories: normalized, allowWrites: raw.allowWrites === true };
}

export function createGitHubAuthorization(config, { env = process.env } = {}) {
  const names = new Set(config.repositories);
  return (repo, method = 'GET') => {
    const key = `${repo.owner}/${repo.repo}`.toLowerCase();
    if (!names.has(key)) return null; // Public anonymous browsing still works.
    const token = env[TOKEN_ENV];
    if (typeof token !== 'string' || token === '' || /[\r\n]/.test(token)) return null;
    if (method !== 'GET' && config.allowWrites !== true) return null;
    return token;
  };
}
