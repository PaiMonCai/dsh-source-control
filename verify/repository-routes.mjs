/** Service/HTTP regression for repository expansion. Only scratch repositories. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitError } from '../lib/git.js';
import { SourceControlService } from '../lib/service.js';
import { registerRoutes, routeTable, ROUTE_PREFIX } from '../lib/routes.js';

let checks = 0;
let failures = 0;
function check(value, label) {
  checks++;
  if (value) console.log(`ok   ${label}`);
  else { failures++; console.error(`FAIL ${label}`); }
}
function equal(actual, expected, label) {
  try { assert.deepEqual(actual, expected); check(true, label); }
  catch (error) { check(false, label); console.error(error.message); }
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
/**
 * Wait for a real-time condition.
 *
 * The condition becomes true only after a child git process has run, and a git
 * round trip is milliseconds while a spin of microtasks is microseconds — a
 * bounded microtask loop is a race that fails on a loaded host. This waits on
 * the wall clock and keeps the microtask yield so the event loop can progress.
 *
 * @param {() => boolean} predicate - the condition to observe.
 * @param {string} [what] - description used in the timeout error.
 * @param {number} [timeoutMs] - how long to wait before failing.
 * @returns {Promise<void>} resolves once the condition holds.
 */
async function until(predicate, what = 'queue condition', timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`${what} did not become ready within ${timeoutMs}ms`);
}
async function command(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    let output = '', error = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { error += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(output.trim()) : reject(new Error(`git ${args.join(' ')}: ${error}`)));
  });
}
const subprocess = {
  async resolveExecutable(name) { return name; },
  spawn(spec) {
    const child = spawn(spec.argv[0], spec.argv.slice(1), {
      cwd: spec.cwd, env: { ...process.env, ...spec.env }, signal: spec.signal,
    });
    if (typeof spec.stdio?.stdin === 'object') child.stdin.end(spec.stdio.stdin.data);
    else child.stdin.end();
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', () => {}); // cancellation is reported by GitRunner's signal check
    return {
      done: new Promise((resolve) => child.on('close', (exitCode, signal) => resolve({ exitCode, signal }))),
      collected: {
        stdout: { readFrom: () => ({ text: stdout, lossy: false }) },
        stderr: { readFrom: () => ({ text: stderr, lossy: false }) },
      },
    };
  },
};
const scratch = await realpath(await mkdtemp(join(tmpdir(), 'scm-repository-routes-')));
const repo = join(scratch, 'repo'), second = join(scratch, 'second');
const nested = join(repo, 'nested'), alias = join(scratch, 'alias');
const config = { timeoutMs: 30000, maxOutputBytes: 8 * 1024 * 1024, maxDiffLines: 20000, maxLogEntries: 2 };
try {
  for (const root of [repo, second]) {
    await mkdir(root);
    await command(['init', '-q', '-b', 'main'], root);
    await command(['config', 'user.name', 'Verify'], root);
    await command(['config', 'user.email', 'verify@example.com'], root);
    await writeFile(join(root, 'tracked.txt'), 'initial\n');
    await command(['add', '--', 'tracked.txt'], root);
    await command(['commit', '-qm', 'initial'], root);
  }
  await mkdir(nested);
  await symlink(repo, alias, 'dir');
  const sessions = [{ id: 'root-session', header: { cwd: repo } }, { id: 'nested-session', header: { cwd: nested } }];
  const registrations = new Map();
  const ctx = {
    subprocess,
    sessions: { get: (id) => sessions.find((row) => row.id === id), list: () => sessions },
    connection: { fetch: { async register(route) {
      registrations.set(route.path, route);
      return () => { registrations.delete(route.path); };
    } } },
  };
  class FakeService extends SourceControlService {
    get operations() { return this.fake; }
  }
  const service = new FakeService(ctx, config);
  const calls = [];
  const mutationNames = ['stage', 'unstage', 'discard', 'stageHunk', 'unstageHunk', 'discardHunk', 'commit', 'switchBranch', 'createBranch', 'fetch', 'pull', 'push'];
  service.fake = Object.fromEntries([...mutationNames, 'branches', 'graph', 'commitDetails', 'commitDiff'].map((name) => [name, async (request) => {
    calls.push({ name, request });
    return { method: name, root: request.root };
  }]));
  const dispose = await registerRoutes(ctx, service);
  async function invoke(segment, { query = {}, body, raw, signal } = {}) {
    const registration = registrations.get(`${ROUTE_PREFIX}/${segment}`);
    const url = new URL(`http://localhost${registration.path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const method = registration.methods[0];
    const response = await registration.fetch(new Request(url, {
      method, signal,
      ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: raw ?? JSON.stringify(body ?? {}) } : {}),
    }));
    check(response.status === 200 && response.headers.get('cache-control') === 'no-store', `${segment} preserves HTTP envelope transport`);
    return response.json();
  }
  const table = routeTable(service);
  equal(table.length, 23, 'twenty-three authenticated Connection registrations');
  equal(table.filter((row) => row.read).length, 11, 'eleven read-only routes');
  equal(table.filter((row) => !row.read).length, 12, 'twelve explicit mutation routes');
  check(table.every((row) => row.methods[0] === (row.read ? 'GET' : 'POST')), 'all mutation routes remain POST-only');
  check(['github-pulls', 'github-issues', 'github-pull-detail'].every((name) => table.some((route) => route.path === `${ROUTE_PREFIX}/${name}` && route.read)), 'GitHub review endpoints never register as mutations');
  check(table.every((row) => registrations.has(row.path)), 'all descriptors registered through Connection');

  for (const [segment, query, name] of [
    ['branches', { sessionId: 'nested-session' }, 'branches'],
    ['graph', { repo: alias, skip: '1' }, 'graph'],
    ['commit-details', { repo, hash: 'a'.repeat(40) }, 'commitDetails'],
    ['commit-diff', { repo, hash: 'a'.repeat(40), path: 'deleted/old.txt' }, 'commitDiff'],
  ]) {
    const result = await invoke(segment, { query });
    check(result.ok && calls.at(-1).name === name && calls.at(-1).request.root === repo, `${segment} resolves selector and canonical repository scope`);
  }
  check(calls.every((call) => !['fetch', 'pull', 'push'].includes(call.name)), 'new reads never trigger automatic network operations');
  const historicGuard = service.withPaths;
  service.withPaths = () => { throw new Error('current filesystem guard must not run'); };
  const historic = await invoke('commit-diff', { query: { repo, hash: 'a'.repeat(64), path: 'deleted/old.txt' } });
  check(historic.ok, 'historic diff does not consult current filesystem containment');
  service.withPaths = historicGuard;

  const invalidGet = [
    ['branches', {}, 'request/invalid-selector'],
    ['branches', { sessionId: 'unknown' }, 'session/unknown'],
    ['graph', { repo, skip: '-1' }, 'request/invalid-argument'],
    ['graph', { repo, skip: '1.5' }, 'request/invalid-argument'],
    ['graph', { repo, skip: 'Infinity' }, 'request/invalid-argument'],
    ['graph', { repo, skip: '' }, 'request/invalid-argument'],
    ['graph', { repo, skip: '1000001' }, 'request/invalid-argument'],
    ['commit-details', { repo, hash: 'HEAD' }, 'request/invalid-argument'],
    ['commit-details', { repo, hash: 'a'.repeat(39) }, 'request/invalid-argument'],
    ['commit-diff', { repo, hash: 'a'.repeat(40), path: '../outside' }, 'path/invalid'],
    ['commit-diff', { repo, hash: 'a'.repeat(40), path: '/absolute' }, 'path/invalid'],
    ['commit-diff', { repo, hash: 'a'.repeat(40), path: '.git/config' }, 'path/invalid'],
    ['commit-diff', { repo, hash: 'a'.repeat(40) }, 'request/invalid-argument'],
  ];
  for (const [segment, query, code] of invalidGet) {
    const before = calls.length;
    const result = await invoke(segment, { query });
    check(!result.ok && result.error.code === code && before === calls.length, `${segment} refuses malformed selector/history pagination or path: ${JSON.stringify(query)}`);
  }
  for (const skip of [null, '1', 1.5, -1, Infinity, NaN, 1000001]) {
    await assert.rejects(service.graph({ repo, skip }), { code: 'request/invalid-argument' });
    check(true, `direct graph rejects invalid skip ${String(skip)}`);
  }
  for (const [segment, body, fields] of [
    ['switch-branch', { branch: 'topic', remoteBranch: 'origin/topic' }, ['root', 'branch', 'remoteBranch', 'signal']],
    ['create-branch', { branch: 'topic' }, ['root', 'branch', 'signal']],
    ['fetch', { remote: 'origin' }, ['root', 'remote', 'signal']],
    ['pull', { remote: 'origin', branch: 'main', sourceBranch: 'main' }, ['root', 'remote', 'branch', 'sourceBranch', 'signal']],
    ['push', { setUpstream: true, sourceBranch: 'main' }, ['root', 'remote', 'branch', 'sourceBranch', 'setUpstream', 'signal']],
  ]) {
    const result = await invoke(segment, { query: { repo: second }, body: { ...body, repo: nested, force: true, cwd: second, argv: ['--force'] } });
    check(result.ok && calls.at(-1).request.root === repo, `${segment} retains body-over-query selector precedence`);
    equal(Object.keys(calls.at(-1).request).sort(), fields.sort(), `${segment} forwards only approved operation fields`);
  }
  for (const [segment, body] of [
    ['switch-branch', { branch: 1 }], ['switch-branch', { branch: 'topic', remoteBranch: false }],
    ['create-branch', { branch: null }], ['create-branch', { branch: '' }],
    ['fetch', { remote: {} }], ['fetch', {}], ['pull', { remote: null }],
    ['pull', { branch: [] }], ['push', { setUpstream: 'true' }], ['push', { setUpstream: 1 }],
    ['push', { remote: false }], ['push', { branch: 7 }],
    ['pull', { sourceBranch: null }], ['pull', { sourceBranch: '' }],
    ['push', { sourceBranch: false }], ['push', { sourceBranch: undefined }],
  ]) {
    const before = calls.length;
    const result = await invoke(segment, { body: { repo, sourceBranch: 'main', ...body } });
    check(!result.ok && result.error.code === 'request/invalid-argument' && before === calls.length, `${segment} strictly validates supplied scalar types: ${JSON.stringify(body)}`);
  }
  const defaultPush = await invoke('push', { body: { repo, sourceBranch: 'main' } });
  check(defaultPush.ok && calls.at(-1).request.setUpstream === false, 'push defaults setUpstream to boolean false');
  for (const raw of ['[]', 'null', '{']) {
    const result = await invoke('fetch', { raw });
    check(!result.ok && result.error.code === 'request/invalid-body', 'new POST wrapper rejects malformed/nonobject JSON');
  }

  console.log('\n## serialized mutation queues');
  // Prime real selector contexts so ordering assertions test queues, not git IO.
  for (const request of [{ repo }, { repo: nested }, { repo: alias }, { repo: second }, { sessionId: 'nested-session' }]) await service.context(request);
  const originalContext = service.context.bind(service);
  let contexts = 0;
  service.context = async (request) => { contexts++; return originalContext(request); };
  const order = [], gate = deferred(), started = deferred();
  service.fake.stage = async ({ root }) => { order.push(`stage:${root}`); started.resolve(); await gate.promise; return { staged: true }; };
  service.fake.switchBranch = async ({ root }) => { order.push(`switch:${root}`); return { branch: 'topic' }; };
  let guards = 0;
  service.withPaths = async (...args) => { guards++; return historicGuard.apply(service, args); };
  const first = service.stage({ repo: alias, paths: ['tracked.txt'] });
  await started.promise;
  const aborted = new AbortController();
  const pending = service.switchBranch({ sessionId: 'nested-session', branch: 'cancelled', signal: aborted.signal });
  const pendingResult = pending.then(() => null, (error) => error);
  await until(() => service.mutationQueues.get(repo)?.jobs.length === 1, 'first queued job');
  aborted.abort();
  equal((await pendingResult)?.code, 'git/aborted', 'pending cancellation rejects while predecessor remains blocked');
  equal(service.mutationQueues.get(repo).jobs.length, 0, 'cancelled pending job is removed immediately');
  const queued = service.switchBranch({ repo: nested, branch: 'topic' });
  await until(() => service.mutationQueues.get(repo)?.jobs.length === 1);
  const stagedLater = service.stage({ sessionId: 'nested-session', paths: ['tracked.txt'] });
  await until(() => service.mutationQueues.get(repo)?.jobs.length === 2, 'second queued job');
  equal(guards, 1, 'old stage path validation waits inside queue callback');
  equal(order, [`stage:${repo}`], 'old stage excludes new switch on same canonical root');
  await service.switchBranch({ repo: second, branch: 'other' });
  equal(order, [`stage:${repo}`, `switch:${second}`], 'separate repository mutates independently of blocked root');
  gate.resolve();
  await Promise.all([first, queued, stagedLater]);
  equal(order, [`stage:${repo}`, `switch:${second}`, `switch:${repo}`, `stage:${repo}`], 'repo, nested path, alias and session share FIFO mutation queue');
  equal(contexts, 5, 'each mutation resolves context exactly once');
  equal(service.mutationQueues.size, 0, 'successful and cancelled queues leave no entries');

  const failGate = deferred(), failStarted = deferred();
  service.fake.commit = async () => { failStarted.resolve(); await failGate.promise; throw new GitError('git/failed', 'deliberate failure'); };
  const failed = service.commit({ repo, message: 'x' }).then(() => null, (error) => error);
  await failStarted.promise;
  const afterFailure = service.switchBranch({ repo, branch: 'topic' });
  await until(() => service.mutationQueues.get(repo)?.jobs.length === 1);
  failGate.resolve();
  equal((await failed).code, 'git/failed', 'running job failure is preserved');
  check((await afterFailure).branch === 'topic', 'failed job cannot poison later mutation');
  await assert.rejects(service.stage({ repo, paths: ['../outside'] }), { code: 'path/outside-repository' });
  check((await service.switchBranch({ repo, branch: 'topic' })).branch === 'topic', 'guard rejection cannot poison later mutation');
  const preAborted = new AbortController(); preAborted.abort();
  const before = contexts;
  await assert.rejects(service.fetch({ repo, remote: 'origin', signal: preAborted.signal }), { code: 'git/aborted' });
  equal(contexts, before, 'pre-aborted mutations do not resolve context or reach Git');
  equal(service.mutationQueues.size, 0, 'failed/rejected/pre-aborted jobs leak no queue entries');

  const runningAbort = new AbortController(), abortStarted = deferred();
  service.fake.fetch = async ({ signal }) => {
    abortStarted.resolve();
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    throw new GitError('git/aborted', 'active command cancelled');
  };
  const activeCancelled = service.fetch({ repo, remote: 'origin', signal: runningAbort.signal }).then(() => null, (error) => error);
  await abortStarted.promise;
  const afterCancelled = service.switchBranch({ repo, branch: 'topic' });
  await until(() => service.mutationQueues.get(repo)?.jobs.length === 1);
  runningAbort.abort();
  equal((await activeCancelled).code, 'git/aborted', 'active command cancellation propagates');
  check((await afterCancelled).branch === 'topic', 'active cancelled job cannot poison its successor');
  equal(service.mutationQueues.size, 0, 'active cancellation leaves no idle queue entries');

  // Every mutation (including existing tool methods) waits behind the same gate.
  for (const name of mutationNames) service.fake[name] = async () => ({ method: name });
  const allGate = deferred(), allStarted = deferred(), observed = [];
  service.fake.stage = async () => { allStarted.resolve(); await allGate.promise; return {}; };
  for (const name of mutationNames.filter((name) => name !== 'stage')) service.fake[name] = async () => { observed.push(name); return {}; };
  const blocker = service.stage({ repo, paths: ['tracked.txt'] }); await allStarted.promise;
  const requests = {
    unstage: { paths: ['tracked.txt'] }, discard: { paths: ['tracked.txt'] },
    stageHunk: { path: 'tracked.txt', hunkIndex: 0 }, unstageHunk: { path: 'tracked.txt', hunkIndex: 0 }, discardHunk: { path: 'tracked.txt', hunkIndex: 0 },
    commit: { message: 'x' }, switchBranch: { branch: 'topic' }, createBranch: { branch: 'topic' },
    fetch: { remote: 'origin' }, pull: { sourceBranch: 'main' }, push: { sourceBranch: 'main' },
  };
  const allJobs = Object.entries(requests).map(([name, fields]) => service[name]({ repo, ...fields }));
  await until(() => service.mutationQueues.get(repo)?.jobs.length === 11, 'full mutation table queued');
  equal(observed, [], 'every old/new mutation is blocked by active mutation');
  allGate.resolve(); await Promise.all([blocker, ...allJobs]);
  equal(observed.length, 11, 'every queued mutation executes after release');
  equal(service.mutationQueues.size, 0, 'full mutation table drains without idle map entries');
  await dispose();
  equal(registrations.size, 0, 'route disposer withdraws all Connection registrations');

  console.log('\n## a failed read through the service is still a GitError');
  // The service supplies a lazy runner wrapper, not the runner itself, so the
  // parsed-read helpers must not depend on runner-only methods. This seam is
  // where the HTTP routes and the agent tool actually run.
  const brokenCtx = {
    ...ctx,
    subprocess: {
      async resolveExecutable(name) { return name; },
      spawn(spec) {
        const promisor = spec.argv.includes('commit-diff') || spec.argv.includes('--no-index');
        return {
          done: Promise.resolve({ exitCode: promisor ? 128 : 2 }),
          collected: {
            stdout: { readFrom: () => ({ text: '', lossy: false }) },
            stderr: { readFrom: () => ({ text: promisor
              ? 'fatal: could not fetch 5626abf0f72e58d7a153368ba57db4c673c0e171 from promisor remote'
              : 'fatal: bad object HEAD' }) },
          },
        };
      },
    },
  };
  const brokenService = new SourceControlService(brokenCtx, config);
  for (const [method, request] of [
    ['log', { repo }],
    ['diff', { repo, path: 'tracked.txt', staged: false, untracked: false }],
    ['stageHunk', { repo, path: 'tracked.txt', hunkIndex: 0 }],
  ]) {
    const error = await brokenService[method](request).then(() => null, (thrown) => thrown);
    check(error !== null && error.name === 'GitError' && error.code === 'git/failed', `${method} through the service reports git/failed rather than a wiring error`, { code: error?.code, message: error?.message });
  }
  const realSpawn = ctx.subprocess.spawn.bind(ctx.subprocess);
  const promisorCtx = { ...ctx, subprocess: {
    resolveExecutable: ctx.subprocess.resolveExecutable,
    spawn(spec) {
      if (!spec.argv.includes('log')) return realSpawn(spec);
      return {
        done: Promise.resolve({ exitCode: 128 }),
        collected: {
          stdout: { readFrom: () => ({ text: '', lossy: false }) },
          stderr: { readFrom: () => ({ text: 'fatal: could not fetch 5626abf0f72e58d7a153368ba57db4c673c0e171 from promisor remote' }) },
        },
      };
    },
  } };
  const promisorError = await new SourceControlService(promisorCtx, config).log({ repo }).then(() => null, (thrown) => thrown);
  check(promisorError !== null && promisorError.code === 'git/object-unavailable', 'a promisor failure through the service keeps its actionable code', { code: promisorError?.code });

  // Repository discovery runs before any read and used to build its own
  // unredacted failure message; it now shares the same failure owner.
  const discoveryLeak = await new SourceControlService({
    ...ctx,
    subprocess: {
      async resolveExecutable(name) { return name; },
      spawn() {
        return {
          done: Promise.resolve({ exitCode: 128 }),
          collected: {
            stdout: { readFrom: () => ({ text: '', lossy: false }) },
            stderr: { readFrom: () => ({ text: 'fatal: could not read from https://user:hunter2@host/r.git?token=SECRETTOKEN\nAuthorization: Basic Q0lQQVNTV09SRA==' }) },
          },
        };
      },
    },
  }, config).status({ repo }).then(() => null, (thrown) => thrown);
  check(discoveryLeak !== null && discoveryLeak.code === 'git/failed', 'repository discovery failure is a reported GitError', { code: discoveryLeak?.code });
  check(!/hunter2|SECRETTOKEN|Q0lQQVNTV09SRA/.test(String(discoveryLeak?.message)), 'repository discovery failure never echoes credentials', discoveryLeak?.message);

  console.log('\n## real command-layer integration');
  const realService = new SourceControlService(ctx, config);
  const missing = ['branches', 'graph', 'commitDetails', 'commitDiff', 'switchBranch', 'createBranch', 'fetch', 'pull', 'push'].filter((name) => typeof realService.operations[name] !== 'function');
  check(missing.length === 0, `command-layer expansion dependency is available${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`);
  if (missing.length === 0) {
    await registerRoutes(ctx, realService);
    const origin = join(scratch, 'origin.git');
    await command(['init', '--bare', '-q', origin], scratch);
    await command(['remote', 'add', 'origin', origin], repo);
    let result = await invoke('branches', { query: { repo } });
    check(result.ok && result.value.current === 'main' && result.value.remotes.some((row) => row.name === 'origin'), 'real branches lists current branch and configured remote');
    const initialHash = await command(['rev-parse', 'HEAD'], repo);
    result = await invoke('commit-details', { query: { repo, hash: initialHash } });
    check(result.ok && result.value.commit.hash === initialHash && result.value.files.some((row) => row.path === 'tracked.txt'), 'real initial commit details returns root-commit files');
    result = await invoke('commit-diff', { query: { repo, hash: initialHash, path: 'tracked.txt' } });
    check(result.ok && result.value.added === 1, 'real root commit diff returns parsed addition');
    await writeFile(join(repo, 'gone.txt'), 'historic\n');
    await command(['add', '--', 'gone.txt'], repo); await command(['commit', '-qm', 'historic addition'], repo);
    const historicHash = await command(['rev-parse', 'HEAD'], repo);
    await command(['rm', '--', 'gone.txt'], repo); await command(['commit', '-qm', 'historic deletion'], repo);
    result = await invoke('commit-diff', { query: { repo, hash: historicHash, path: 'gone.txt' } });
    check(result.ok && result.value.added === 1, 'real historic diff works for file now absent');
    result = await invoke('commit-diff', { query: { repo, hash: historicHash, path: 'not-in-commit.txt' } });
    check(!result.ok, 'real historic diff refuses paths not in selected commit');
    result = await invoke('graph', { query: { repo } });
    check(result.ok && result.value.commits.length === 2 && result.value.hasMore === true, 'real graph pagination returns bounded page and hasMore');
    result = await invoke('graph', { query: { sessionId: 'nested-session', skip: '2' } });
    check(result.ok && result.value.commits.length === 1 && result.value.hasMore === false, 'real graph honors nested-session selector and skip');
    result = await invoke('create-branch', { body: { repo, branch: 'topic' } });
    check(result.ok && result.value.branch === 'topic', 'real create branch route succeeds');
    result = await invoke('switch-branch', { body: { repo, branch: 'topic' } });
    check(result.ok && await command(['branch', '--show-current'], repo) === 'topic', 'real switch route changes branch');
    result = await invoke('switch-branch', { body: { repo, branch: 'main' } });
    check(result.ok, 'real switch restores main');
    result = await invoke('push', { body: { repo, remote: 'origin', branch: 'main', sourceBranch: 'main', setUpstream: true } });
    check(result.ok && await command(['rev-parse', 'refs/heads/main'], origin) === await command(['rev-parse', 'HEAD'], repo), 'real push uses only scratch bare origin and sets upstream');
    result = await invoke('fetch', { body: { repo, remote: 'origin' } });
    check(result.ok && result.value.remote === 'origin', 'real fetch explicitly updates scratch origin');
    result = await invoke('pull', { body: { repo, sourceBranch: 'main' } });
    check(result.ok && result.value.remote === 'origin' && result.value.branch === 'main', 'real pull uses configured upstream with explicit POST');
    result = await invoke('switch-branch', { body: { repo, branch: '--force' } });
    check(!result.ok, 'real switch rejects option-like branch payload');

    // Preserve the complete POST -> canonical-root queue -> real Git regression,
    // not just a helper check. Topic is a strict descendant, so the old wrong-
    // source push would have fast-forwarded remote main and genuinely published B.
    await command(['switch', 'topic'], repo);
    await writeFile(join(repo, 'topic-only.txt'), 'topic-only commit\n');
    await command(['add', '--', 'topic-only.txt'], repo);
    await command(['commit', '-qm', 'topic must not be published as main'], repo);
    const topicHash = await command(['rev-parse', 'HEAD'], repo);
    await command(['switch', 'main'], repo);
    const remoteBefore = await command(['for-each-ref', '--format=%(refname) %(objectname)'], origin);
    const liveOperations = realService.operations;
    const originalSpawn = subprocess.spawn;
    let transports = 0;
    subprocess.spawn = (spec) => {
      if (spec.argv.some((arg) => ['fetch', 'pull', 'push'].includes(arg))) transports++;
      return originalSpawn(spec);
    };
    try {
      for (const action of ['push', 'pull']) {
        await invoke('switch-branch', { body: { repo, branch: 'main' } });
        const entered = deferred(), release = deferred();
        Object.defineProperty(realService, 'operations', { configurable: true, value: {
          ...liveOperations,
          switchBranch: async (request) => { entered.resolve(); await release.promise; return liveOperations.switchBranch(request); },
        } });
        const switched = invoke('switch-branch', { body: { repo, branch: 'topic' } });
        await entered.promise;
        let stale;
        const before = transports;
        try {
          stale = invoke(action, { body: { repo, remote: 'origin', branch: 'main', sourceBranch: 'main', ...(action === 'push' ? { setUpstream: true } : {}) } });
          await until(() => realService.mutationQueues.get(repo)?.jobs.length === 1, 'queued stale transport admission');
        } finally { release.resolve(); }
        check((await switched).ok, `registered switch executes before queued stale ${action}`);
        const refused = await stale;
        check(!refused.ok && refused.error.code === 'git/source-branch-changed', `queued POST ${action} preserves the originally confirmed source branch`);
        equal(transports, before, `stale queued ${action} makes zero transport calls`);
        equal(await command(['for-each-ref', '--format=%(refname) %(objectname)'], origin), remoteBefore, `stale queued ${action} leaves every remote ref unchanged`);
        equal(realService.mutationQueues.size, 0, `source-mismatched ${action} drains its canonical-root queue`);
        delete realService.operations;
      }
      const confirmed = await invoke('push', { body: { repo, remote: 'origin', branch: 'different-destination', sourceBranch: 'topic', setUpstream: true } });
      check(confirmed.ok, 'confirmed source may push to a legitimately differently named destination');
      equal(await command(['rev-parse', 'refs/heads/different-destination'], origin), topicHash, 'confirmed POST publishes exactly the selected source branch');
      equal(await command(['rev-parse', 'refs/heads/main'], origin), await command(['rev-parse', 'refs/heads/main'], repo), 'valid differently named push still preserves remote main');
    } finally { delete realService.operations; subprocess.spawn = originalSpawn; }
  }
} catch (error) {
  failures++; console.error(error.stack);
} finally {
  // Only remove the known mkdtemp directory, never a caller/user repository.
  assert(scratch.startsWith(join(tmpdir(), 'scm-repository-routes-')));
  await rm(scratch, { recursive: true, force: true });
}
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exitCode = failures === 0 ? 0 : 1;
