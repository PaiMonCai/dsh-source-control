/**
 * Verification for the HTTP route layer.
 *
 * Drives every route handler with real `Request` objects against a scratch
 * repository, over a fake Host context. This exercises the whole surface the
 * browser calls: the JSON envelope, the request selector, the path guard, and
 * each git operation — everything except Connection's authentication, which is
 * verified separately against the running server (an unauthenticated request
 * must be 401 and an untrusted Host must be 403).
 *
 * Run with:
 *
 *     node verify/routes.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ROUTE_PREFIX, routeTable } from '../lib/routes.js';
import { SourceControlService } from '../lib/service.js';

let failures = 0;
let checks = 0;

/**
 * Assert one condition.
 * @param {boolean} condition - the condition.
 * @param {string} label - what is being asserted.
 * @param {unknown} [detail] - extra context on failure.
 */
function check(condition, label, detail = undefined) {
  checks += 1;
  if (condition) {
    console.log(`ok   ${label}`);
    return;
  }
  failures += 1;
  console.log(`FAIL ${label}${detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`);
}

/**
 * Run one command through node's child_process.
 * @param {string} command - executable.
 * @param {string[]} args - argv.
 * @param {string} cwd - working directory.
 * @returns {Promise<void>} settles when the command exits.
 */
async function sh(command, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'ignore' });
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited ${code}`))));
    child.on('error', reject);
  });
}

/** A `ctx.subprocess` adapter over node's child_process. */
const subprocess = {
  /**
   * @param {string} command - bare command name.
   * @returns {Promise<string>} the command as given.
   */
  async resolveExecutable(command) {
    return command;
  },
  /**
   * @param {object} spec - the spawn spec.
   * @returns {object} a handle with `done` and collected readers.
   */
  spawn(spec) {
    const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env: { ...process.env, ...(spec.env ?? {}) } });
    if (spec.stdio?.stdin !== undefined && typeof spec.stdio.stdin === 'object') child.stdin.end(spec.stdio.stdin.data);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    return {
      done: new Promise((resolve) => child.on('close', (exitCode, signal) => resolve({ exitCode, signal }))),
      collected: {
        stdout: { readFrom: () => ({ text: stdout, lossy: false }) },
        stderr: { readFrom: () => ({ text: stderr, lossy: false }) },
      },
    };
  },
};

const scratch = await realpath(await mkdtemp(join(tmpdir(), 'dsh-source-control-routes-')));
const repo = join(scratch, 'repo');
const other = join(scratch, 'other');
await mkdir(repo);
await mkdir(other);
await writeFile(join(other, 'outside.txt'), 'outside\n');

await sh('git', ['init', '-q', '.'], repo);
await sh('git', ['config', 'user.email', 'verify@example.com'], repo);
await sh('git', ['config', 'user.name', 'Verify'], repo);
await writeFile(join(repo, 'tracked.txt'), 'one\n');
await sh('git', ['add', '-A'], repo);
await sh('git', ['commit', '-qm', 'initial'], repo);
await writeFile(join(repo, 'tracked.txt'), 'one\ntwo\n');
await writeFile(join(repo, 'fresh.txt'), 'fresh\n');

const SESSION_ID = 'session-verify-1';
const sessions = [
  { id: SESSION_ID, header: { cwd: repo } },
  { id: 'session-verify-2', header: { cwd: other } },
  { id: 'session-no-cwd', header: {} },
];
const logger = { info() {}, warn() {}, error() {} };
const ctx = {
  subprocess,
  logger,
  sessions: {
    /**
     * @param {string} id - session id.
     * @returns {object|undefined} the session.
     */
    get: (id) => sessions.find((session) => session.id === id),
    /** @returns {object[]} every session. */
    list: () => sessions,
  },
};

const config = { timeoutMs: 30000, maxOutputBytes: 8 * 1024 * 1024, maxDiffLines: 20000, maxLogEntries: 50 };
const service = new SourceControlService(ctx, config);
const routes = new Map(routeTable(service).map((route) => [route.path, route]));

/**
 * Invoke one route as the browser would.
 * @param {string} operation - suffix after the route prefix.
 * @param {object} [options] - `{query, body}`.
 * @returns {Promise<{status: number, payload: object}>} the decoded response.
 */
async function invoke(operation, options = {}) {
  const route = routes.get(`${ROUTE_PREFIX}/${operation}`);
  if (route === undefined) throw new Error(`no route ${operation}`);
  const url = new URL(`http://localhost${ROUTE_PREFIX}/${operation}`);
  for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, String(value));
  const request = new Request(url.href, {
    method: route.methods[0],
    headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  try {
    // Mirror the route wrapper: a write route reads its JSON body, a read route
    // receives an empty one.
    const body = options.body ?? {};
    const value = await route.handle({ url, body, signal: undefined });
    return { status: 200, payload: { ok: true, value } };
  } catch (error) {
    return { status: 200, payload: { ok: false, error: { code: error.code, message: error.message, details: error.details ?? {} } } };
  }
}

console.log(`# scratch repository: ${repo}\n`);

// ---------------------------------------------------------------------------
console.log('## route table shape');
check(routes.size === 24, 'twenty-four routes are registered', routes.size);
check([...routes.keys()].every((path) => path.startsWith('/api/')), 'every route lives below /api');
check(
  [...routes.keys()].every((path) => path.split('/').every((segment) => segment === '' || /^[A-Za-z0-9_$.-]+$/.test(segment))),
  'every path segment satisfies Connection endpoint grammar',
);
const reads = routeTable(service).filter((route) => route.read);
const writes = routeTable(service).filter((route) => !route.read);
check(reads.length === 11, 'eleven routes are read-only', reads.map((route) => route.path));
check(writes.length === 13, 'thirteen routes mutate the repository', writes.map((route) => route.path));
check(writes.some((route) => route.path === `${ROUTE_PREFIX}/github-create-pull` && route.methods[0] === 'POST'), 'GitHub PR creation is a separate explicit POST route');
check(['github-pulls', 'github-issues', 'github-pull-detail'].every((operation) =>
  reads.some((route) => route.path === `${ROUTE_PREFIX}/${operation}`)), 'GitHub review routes are GET-only');
const badPullId = await invoke('github-pull-detail', { query: { sessionId: SESSION_ID, number: '-2' } });
check(badPullId.payload.error?.code === 'request/invalid-argument', 'invalid PR number refused without GitHub network');
const noGithub = await invoke('github-pulls', { query: { sessionId: SESSION_ID } });
check(noGithub.payload.error?.code === 'github/not-configured', 'a repository with no GitHub remote fails before network');
const noHostedWrite = await invoke('github-create-pull', { query: { sessionId: SESSION_ID }, body: { title: 'Create PR', base: 'main', confirmed: true } });
check(noHostedWrite.payload.error?.code === 'github/not-configured', 'PR creation refuses repositories without GitHub remotes');
check(
  writes.every((route) => route.methods[0] === 'POST'),
  'every mutating route requires POST',
);
check(
  ['fetch', 'pull', 'push'].every((operation) => writes.some((route) => route.path === `${ROUTE_PREFIX}/${operation}`)),
  'remote operations are explicit POST mutations, never read-side effects',
);
check(![...routes.keys()].some((path) => /clone|reset|force/.test(path)), 'clone, reset and force operations remain unavailable');

// ---------------------------------------------------------------------------
console.log('\n## discovery');
const discovery = await invoke('git');
check(discovery.payload.ok === true, 'GET git succeeds');
check(discovery.payload.value.available === true, 'git reports as available');
const repoRow = discovery.payload.value.repositories.find((row) => row.root === repo);
check(repoRow !== undefined, 'the repository of a live Session is listed');
check(repoRow?.sessionIds.includes(SESSION_ID), 'the listing names the Session that owns it');
check(repoRow?.isRepository === true, 'the listing marks it as a repository');
const nonRepo = discovery.payload.value.repositories.find((row) => row.cwd === other);
check(nonRepo?.isRepository === false, 'a Session outside any repository is listed without a root');

// ---------------------------------------------------------------------------
console.log('\n## status');
const status = await invoke('status', { query: { sessionId: SESSION_ID } });
check(status.payload.ok === true, 'GET status succeeds for a session selector');
check(status.payload.value.repository.root === repo, 'status reports the repository root');
check(['master', 'main'].includes(status.payload.value.repository.branch), 'status reports the branch', status.payload.value.repository.branch);
const changePaths = status.payload.value.status.changes.map((row) => row.path);
const untrackedPaths = status.payload.value.status.untracked.map((row) => row.path);
check(changePaths.includes('tracked.txt'), 'a modified file appears in changes', changePaths);
check(untrackedPaths.includes('fresh.txt'), 'an untracked file appears in untracked', untrackedPaths);

const byRepo = await invoke('status', { query: { repo } });
check(byRepo.payload.ok === true && byRepo.payload.value.repository.root === repo, 'GET status succeeds for a repo selector');

// ---------------------------------------------------------------------------
console.log('\n## selectors and failures');
const noSelector = await invoke('status');
check(noSelector.payload.ok === false && noSelector.payload.error.code === 'request/invalid-selector', 'a request with no selector fails cleanly', noSelector.payload);
const unknownSession = await invoke('status', { query: { sessionId: 'nope' } });
check(unknownSession.payload.error?.code === 'session/unknown', 'an unknown session is reported', unknownSession.payload);
const noWorkspace = await invoke('status', { query: { sessionId: 'session-no-cwd' } });
check(noWorkspace.payload.error?.code === 'session/no-workspace', 'a session without a cwd is reported', noWorkspace.payload);
const outsideRepo = await invoke('status', { query: { sessionId: 'session-verify-2' } });
check(outsideRepo.payload.error?.code === 'repo/not-a-repository', 'a non-repository cwd is reported as such', outsideRepo.payload);

// ---------------------------------------------------------------------------
console.log('\n## path authority');
const escape = await invoke('stage', { query: { sessionId: SESSION_ID }, body: { paths: ['../other/outside.txt'] } });
check(escape.payload.ok === false && escape.payload.error.code === 'path/outside-repository', 'a `..` escape is refused', escape.payload);
const absolute = await invoke('stage', { query: { sessionId: SESSION_ID }, body: { paths: [join(other, 'outside.txt')] } });
check(absolute.payload.ok === false && absolute.payload.error.code === 'path/outside-repository', 'an absolute outside path is refused', absolute.payload);
const empty = await invoke('stage', { query: { sessionId: SESSION_ID }, body: { paths: [] } });
check(empty.payload.ok === false && empty.payload.error.code === 'path/invalid', 'an empty path list is refused', empty.payload);
const missingBody = await invoke('stage', { query: { sessionId: SESSION_ID }, body: { nope: true } });
check(missingBody.payload.ok === false && missingBody.payload.error.code === 'path/invalid', 'a write without paths is refused', missingBody.payload);
check((await readFile(join(other, 'outside.txt'), 'utf8')) === 'outside\n', 'no refused request touched the outside file');

// ---------------------------------------------------------------------------
console.log('\n## diff');
const diff = await invoke('diff', { query: { sessionId: SESSION_ID, path: 'tracked.txt' } });
check(diff.payload.ok === true, 'GET diff succeeds');
check(diff.payload.value.added === 1, 'the diff reports one added line', diff.payload.value.added);
check(diff.payload.value.hunks.length === 1, 'the diff has one hunk', diff.payload.value.hunks.length);
const untrackedDiff = await invoke('diff', { query: { sessionId: SESSION_ID, path: 'fresh.txt', untracked: true } });
check(untrackedDiff.payload.value.added === 1, 'an untracked file diffs as added content', untrackedDiff.payload.value);
const diffEscape = await invoke('diff', { query: { sessionId: SESSION_ID, path: '../other/outside.txt' } });
check(diffEscape.payload.ok === false && diffEscape.payload.error.code === 'path/outside-repository', 'diff refuses an escaping path', diffEscape.payload);

// ---------------------------------------------------------------------------
console.log('\n## stage, unstage, commit over the wire');
const staged = await invoke('stage', { query: { sessionId: SESSION_ID }, body: { paths: ['tracked.txt', 'fresh.txt'] } });
check(staged.payload.ok === true, 'POST stage succeeds', staged.payload);
const afterStage = await invoke('status', { query: { sessionId: SESSION_ID } });
const stagedPaths = afterStage.payload.value.status.staged.map((row) => row.path);
check(stagedPaths.includes('tracked.txt') && stagedPaths.includes('fresh.txt'), 'both paths are staged', stagedPaths);
const unstaged = await invoke('unstage', { query: { sessionId: SESSION_ID }, body: { paths: ['fresh.txt'] } });
check(unstaged.payload.ok === true, 'POST unstage succeeds', unstaged.payload);
const afterUnstage = await invoke('status', { query: { sessionId: SESSION_ID } });
check(afterUnstage.payload.value.status.untracked.some((row) => row.path === 'fresh.txt'), 'unstage returned the file to untracked');

const emptyCommit = await invoke('commit', { query: { sessionId: SESSION_ID }, body: { message: '   ' } });
check(emptyCommit.payload.error?.code === 'git/empty-message', 'a blank message is refused', emptyCommit.payload);
const committed = await invoke('commit', { query: { sessionId: SESSION_ID }, body: { message: 'via route\n\nbody\n' } });
check(committed.payload.ok === true, 'POST commit succeeds', committed.payload);
check(/^[0-9a-f]{40}$/.test(committed.payload.value.hash ?? ''), 'commit returns the new hash');
const afterCommit = await invoke('status', { query: { sessionId: SESSION_ID } });
check(
  afterCommit.payload.value.status.staged.length === 0 && afterCommit.payload.value.status.changes.length === 0,
  'the working tree is clean after committing everything staged',
  afterCommit.payload.value.status,
);
const nothingStaged = await invoke('commit', { query: { sessionId: SESSION_ID }, body: { message: 'again' } });
check(nothingStaged.payload.error?.code === 'git/nothing-staged', 'committing an empty index is refused', nothingStaged.payload);

// ---------------------------------------------------------------------------
console.log('\n## log');
const log = await invoke('log', { query: { sessionId: SESSION_ID } });
check(log.payload.ok === true, 'GET log succeeds');
check(log.payload.value.commits.length === 2, 'log lists both commits', log.payload.value.commits.length);
check(log.payload.value.commits[0].subject === 'via route', 'log is newest first', log.payload.value.commits[0].subject);
const paged = await invoke('log', { query: { sessionId: SESSION_ID, skip: 1 } });
check(paged.payload.value.commits.length === 1 && paged.payload.value.commits[0].subject === 'initial', 'log honours skip', paged.payload.value.commits);

// ---------------------------------------------------------------------------
console.log('\n## discard');
await writeFile(join(repo, 'tracked.txt'), 'thrown away\n');
const discarded = await invoke('discard', { query: { sessionId: SESSION_ID }, body: { paths: ['tracked.txt'] } });
check(discarded.payload.ok === true, 'POST discard succeeds', discarded.payload);
check((await readFile(join(repo, 'tracked.txt'), 'utf8')) === 'one\ntwo\n', 'discard restored the committed content');
await writeFile(join(repo, 'doomed.txt'), 'remove me\n');
const cleaned = await invoke('discard', { query: { sessionId: SESSION_ID }, body: { paths: ['doomed.txt'] } });
check(cleaned.payload.ok === true && cleaned.payload.value.removed.includes('doomed.txt'), 'discard deletes an untracked file', cleaned.payload.value);

// ---------------------------------------------------------------------------
console.log('\n## discard validates positively');
// The route must not hand git a path that is not a current change: before the
// fix the split was a negative test, so an ignored path reached `git restore`
// and the client received a raw git pathspec error.
await writeFile(join(repo, '.gitignore'), '*.log\n');
await writeFile(join(repo, 'ignored.log'), 'ignored\n');
const ignoredDiscard = await invoke('discard', { query: { sessionId: SESSION_ID }, body: { paths: ['ignored.log', '.gitignore'] } });
check(ignoredDiscard.payload.ok === true, 'discarding an ignored path is not an error', ignoredDiscard.payload);
check(
  ignoredDiscard.payload.value.unchanged.includes('ignored.log'),
  'the ignored path is reported as unchanged',
  ignoredDiscard.payload.value,
);
check((await readFile(join(repo, 'ignored.log'), 'utf8')) === 'ignored\n', 'the ignored file still exists');
const unmodifiedDiscard = await invoke('discard', { query: { sessionId: SESSION_ID }, body: { paths: ['tracked.txt'] } });
check(
  unmodifiedDiscard.payload.value.unchanged.includes('tracked.txt'),
  'an unmodified tracked file is reported as unchanged',
  unmodifiedDiscard.payload.value,
);
check((await readFile(join(repo, 'tracked.txt'), 'utf8')) === 'one\ntwo\n', 'the unmodified file is untouched');
// ---------------------------------------------------------------------------
console.log('\n## envelope shape');
for (const [operation, options] of [
  ['git', {}],
  ['status', { query: { sessionId: SESSION_ID } }],
  ['log', { query: { sessionId: SESSION_ID } }],
  ['status', {}],
]) {
  const response = await invoke(operation, options);
  const shape =
    response.status === 200 &&
    typeof response.payload === 'object' &&
    (response.payload.ok === true ? 'value' in response.payload : typeof response.payload.error?.code === 'string' && typeof response.payload.error?.message === 'string');
  check(shape, `${operation} answers a well-formed 200 envelope`, response.payload);
}

await rm(scratch, { recursive: true, force: true });
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
