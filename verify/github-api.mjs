import { createGitHubReader, githubIdentity, GitHubReadError } from '../lib/github-api.js';
import { githubRemote } from '../lib/github-remote.js';
const identity = githubRemote('git@github.com:PaiMonCai/dsh-source-control.git');
const seen = [];
let body = null;
function response(value, status = 200) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(value) };
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

// Private reads and mutating endpoint are mock-only: no real account touched.
const privateCalls = [];
const auth = createGitHubReader({ authFor: (repo, method) =>
  repo.owner === 'PaiMonCai' && repo.repo === 'dsh-source-control'
    ? 'mock-host-token' : null,
  fetchImpl: async (url, init) => {
    privateCalls.push({ url, init });
    return response(init.method === 'POST'
      ? { number: 51, title: 'Proposed change', state: 'open' }
      : [{ number: 50, title: 'Private PR', state: 'open' }], init.method === 'POST' ? 201 : 200);
  },
});
check(auth.capabilities(identity).authenticated && auth.capabilities(identity).canCreate, 'approved private repository has capability flags');
const privateList = await auth.pulls(identity);
check(privateList.items[0].number === 50, 'token permits private read');
check(privateCalls[0].init.headers.authorization === 'Bearer mock-host-token', 'host bearer credential included server-side');
try {
  await auth.createPull(identity, { head: 'feature', base: 'main', title: 'Proposed change', confirmed: false });
  throw new Error('creation without confirmation was allowed');
} catch (error) { check(error.code === 'github/confirmation-required', 'PR requires explicit confirmation'); }
check(privateCalls.length === 1, 'unconfirmed PR never reaches network');
const created = await auth.createPull(identity, { head: 'feature', base: 'main', title: 'Proposed change', body: 'test', draft: true, confirmed: true });
check(created.pull.number === 51, 'confirmed PR has normalized result');
check(privateCalls[1].init.method === 'POST' && privateCalls[1].init.redirect === 'error' &&
  privateCalls[1].init.credentials === 'omit', 'GitHub POST is bounded to official API with redirects disabled');
check(JSON.parse(privateCalls[1].init.body).draft === true && JSON.parse(privateCalls[1].init.body).head === 'feature', 'PR create sends approved fields');
for (const head of ['-bad', 'main:evil', '../escape', 'feature..broken']) {
  try { await auth.createPull(identity, { head, base: 'main', title: 'Proposed change', confirmed: true }); throw new Error('unsafe head was accepted'); }
  catch (error) { check(error.code === 'github/invalid-branch', 'unsafe PR branch rejected'); }
}
const anonymous = createGitHubReader({ authFor: () => null, fetchImpl: async () => { throw new Error('not allowed'); } });
check(!anonymous.capabilities(identity).canCreate, 'anonymous user has no PR creation capability');
try { await anonymous.createPull(identity, { head: 'feature', base: 'main', title: 'Proposed change', confirmed: true }); throw new Error('write allowed'); }
catch (error) { check(error.code === 'github/write-disabled', 'unapproved PR write refused before network'); }

// Discussions use independent, bounded GET endpoints (issues/comments,
// pulls/reviews, pulls/comments) with credential-free normalized results.
const discussionCalls = [];
const discussionApi = createGitHubReader({
  authFor: () => 'private-read-credential',
  fetchImpl: async (url, init) => {
    discussionCalls.push({ url, init });
    if (url.includes('/issues/12/comments?')) {
      return response([{ id: 1, body: 'General conversation', user: { login: 'alice' }, created_at: '2026-10-01T08:00:00Z' }]);
    }
    if (url.includes('/pulls/12/reviews?')) {
      return response([{ id: 2, state: 'APPROVED', body: 'Looks good', user: { login: 'reviewer' }, submitted_at: '2026-10-02T09:00:00Z' }]);
    }
    if (url.includes('/pulls/12/comments?')) {
      return response([{ id: 3, body: 'Fix this expression', path: 'src/index.js', line: 27, user: { login: 'bob' }, created_at: '2026-10-03T09:00:00Z' }]);
    }
    throw new Error('unexpected GitHub URL');
  },
});
const discussion = await discussionApi.pullDiscussion(identity, { number: 12 });
check(discussion.number === 12 && discussion.entries.length === 3, 'three review/comment types normalized');
check(discussion.entries.map((x) => x.kind).join(',') === 'comment,review,line-comment', 'discussion sorted chronologically');
check(discussion.entries[1].state === 'APPROVED' && discussion.entries[2].path === 'src/index.js' && discussion.entries[2].line === 27, 'review decision and inline location preserved');
check(discussionCalls.length === 3 && discussionCalls.every((x) => x.init.method === 'GET' && x.init.redirect === 'error' && x.init.credentials === 'omit'), 'discussion performs three GETs with no redirects or cookies');
check(discussionCalls.every((x) => x.init.headers.authorization === 'Bearer private-read-credential'), 'private discussion reads use host token only on the server');
check(!JSON.stringify(discussion).includes('credential'), 'token never appears in browser discussion payload');
try { await discussionApi.pullDiscussion(identity, { number: '12' }); throw new Error('invalid number accepted'); }
catch (error) { check(error.code === 'github/invalid-number', 'discussion rejects invalid PR selector before network'); }
check(discussionCalls.length === 3, 'malformed discussion selector causes no network traffic');
const invalidApi = createGitHubReader({ fetchImpl: async () => response({ unexpected: 'shape' }) });
try { await invalidApi.pullDiscussion(identity, { number: 12 }); throw new Error('invalid discussion shape accepted'); }
catch (error) { check(error.code === 'github/invalid-response', 'invalid discussion payload refused rather than shown as empty'); }
console.log('ok   GitHub PR discussion read-only, sorted and normalized');
console.log('ok   GitHub host credential, explicit write gate, and private repo mocks');
console.log('ok   GitHub public PR / issue / diff / checks reader');
