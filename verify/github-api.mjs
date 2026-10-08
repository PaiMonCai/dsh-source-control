import { createGitHubReader, githubIdentity, GitHubReadError } from '../lib/github-api.js';
import { githubRemote } from '../lib/github-remote.js';
const identity = githubRemote('git@github.com:PaiMonCai/dsh-source-control.git');
const seen = [];
let body = null;
function response(value, status = 200) {
  return { ok: status === 200, status, headers: { get: () => null }, text: async () => JSON.stringify(value) };
}
const api = createGitHubReader({ fetchImpl: async (url, init) => {
  seen.push({ url, init }); return typeof body === 'function' ? body(url) : response(body);
}});
function check(value, message) { if (!value) throw new Error(message); }
check(githubIdentity(identity)?.repo === 'dsh-source-control', 'trusted GitHub remote accepted');
check(githubIdentity({ url: 'https://evil.invalid/x/y' }) === null, 'foreign host refused');
check(githubIdentity({ url: 'https://github.com/a/b?c=x' }) === null, 'query refused');
body = [{ number: 12, title: 'Improve UI', state: 'open', draft: true, user: { login: 'dev' }, html_url: 'https://github.com/PaiMonCai/dsh-source-control/pull/12' }];
const pulls = await api.pulls(identity, { state: 'open' });
check(pulls.items[0]?.number === 12 && pulls.items[0].draft, 'PR list normalized');
check(seen[0].url === 'https://api.github.com/repos/PaiMonCai/dsh-source-control/pulls?state=open&sort=updated&direction=desc&per_page=30', 'GitHub API path pinned to repository');
check(seen[0].init.method === 'GET' && seen[0].init.redirect === 'error' && seen[0].init.credentials === 'omit', 'read only and no redirects or cookies');
body = [{ number: 7, title: 'Bug' }, { number: 8, pull_request: { url: 'hidden' } }];
check((await api.issues(identity)).items.length === 1, 'issues exclude Pull Requests');
body = (url) => url.includes('/pulls/12/files') ? response([{ filename: 'src/main.js', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n-old\n+new' }])
  : url.includes('/check-runs') ? response({ check_runs: [{ name: 'test', status: 'completed', conclusion: 'success' }] })
  : response({ number: 12, title: 'PR', head: { sha: 'a'.repeat(40) }, changed_files: 1 });
const detail = await api.pullDetail(identity, { number: 12 });
check(detail.files[0]?.patch.includes('+new') && detail.checks[0]?.conclusion === 'success', 'PR details, patch and checks normalized');
try { await api.pullDetail(identity, { number: -1 }); throw new Error('accepted invalid PR number'); }
catch (error) { check(error instanceof GitHubReadError && error.code === 'github/invalid-number', 'invalid PR number rejected'); }
body = () => response({ message: 'not found' }, 404);
try { await api.pulls(identity); throw new Error('accepted 404'); }
catch (error) { check(error.code === 'github/not-found', 'private/nonpublic GitHub repo has actionable error'); }
console.log('ok   GitHub public PR / issue / diff / checks reader');
