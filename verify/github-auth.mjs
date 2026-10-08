import { createGitHubAuthorization, resolveGitHubAuth, TOKEN_ENV } from '../lib/github-auth.js';
function check(ok, desc) { if (!ok) throw new Error(desc); }
const unset = resolveGitHubAuth();
check(unset.repositories.length === 0 && !unset.allowWrites, 'GitHub auth disabled by default');
for (const value of [{ repositories: ['o/r'], token: 'secret' }, { repositories: ['o/r'], allowWrites: 'yes' }, { repositories: ['a/b', 'A/B'] }, { repositories: ['o/../r'] }, { repositories: [] }]) {
  try { resolveGitHubAuth(value); throw new Error('accepted malformed config'); } catch (error) { check(/githubAuth|duplicate|repositories/.test(error.message), 'invalid GitHub config rejected'); }
}
const repo = { owner: 'Example', repo: 'Private' };
const config = resolveGitHubAuth({ repositories: ['example/private'], allowWrites: false });
const env = { [TOKEN_ENV]: 'host-private-token' };
const auth = createGitHubAuthorization(config, { env });
check(auth(repo, 'GET') === 'host-private-token', 'allowlisted private read receives only host token');
check(auth(repo, 'POST') === null, 'write denied when disabled');
check(auth({ owner: 'Example', repo: 'Other' }) === null, 'token not sent to unapproved repo');
check(createGitHubAuthorization({ ...config, allowWrites: true }, { env })(repo, 'POST') === 'host-private-token', 'explicit write opt-in required');
env[TOKEN_ENV] = 'bad\nheader';
check(auth(repo) === null, 'header injection refused');
console.log('ok   Host-scoped GitHub authorization allowlist and opt-in');
