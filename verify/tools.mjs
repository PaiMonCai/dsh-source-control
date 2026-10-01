/**
 * Verification for the agent tool.
 *
 * The reference this tool follows is "one operation, two callers", so the load
 * bearing assertions here are the ones that check the two callers agree: the same
 * `service` method answers both, and the tool cannot reach anything the routes
 * cannot — or, for discard, the reverse.
 *
 * Run with:
 *
 *     node verify/tools.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ROUTE_PREFIX, routeTable } from '../lib/routes.js';
import { SourceControlService } from '../lib/service.js';
import { ACTIONS, MAX_DIFF_LINES, TOOL_NAME, readArguments, renderDiff, sourceControlTool, summarize } from '../lib/tool.js';

let failures = 0;
let checks = 0;

/**
 * Assert one condition.
 * @param {boolean} condition - the condition.
 * @param {string} label - what is asserted.
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
 * Assert a call rejects with a given error code.
 * @param {() => Promise<unknown>} run - the call.
 * @param {string} code - the expected code.
 * @param {string} label - what is asserted.
 */
async function rejects(run, code, label) {
  checks += 1;
  try {
    await run();
    failures += 1;
    console.log(`FAIL ${label} :: resolved instead of rejecting ${code}`);
  } catch (error) {
    // A service refusal keeps its structured code; the tool rewrites it into the
    // message, because the registry cannot read a foreign error's code field.
    const carries = error?.code === code || (typeof error?.message === 'string' && error.message.startsWith(`${code}:`));
    if (carries) {
      console.log(`ok   ${label}`);
      return;
    }
    failures += 1;
    console.log(`FAIL ${label} :: expected ${code}, got ${error?.code ?? error?.message ?? String(error)}`);
  }
}

/**
 * Run one command through node's child_process.
 * @param {string} command - executable.
 * @param {string[]} args - argv.
 * @param {string} cwd - working directory.
 * @returns {Promise<void>} settles on exit.
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
  /** @param {string} command - command name. @returns {Promise<string>} it. */
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
    else if (spec.stdio?.stdin === 'ignore') child.stdin.end();
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
        stdout: { readFrom: () => ({ text: stdout, nextOffset: 0, lossy: false }) },
        stderr: { readFrom: () => ({ text: stderr, nextOffset: 0, lossy: false }) },
      },
    };
  },
};

const scratch = await mkdtemp(join(tmpdir(), 'dsh-source-control-tools-'));
const repo = join(scratch, 'repo');
const otherRepo = join(scratch, 'other');
for (const root of [repo, otherRepo]) {
  await mkdir(root);
  await sh('git', ['init', '-q', '.'], root);
  await sh('git', ['config', 'user.email', 'verify@example.com'], root);
  await sh('git', ['config', 'user.name', 'Verify'], root);
}
await writeFile(join(repo, 'tracked.txt'), 'one\n');
await sh('git', ['add', '-A'], repo);
await sh('git', ['commit', '-qm', 'initial'], repo);
await writeFile(join(repo, 'tracked.txt'), 'one\ntwo\n');
await writeFile(join(repo, 'fresh.txt'), 'fresh\n');
await writeFile(join(otherRepo, 'elsewhere.txt'), 'elsewhere\n');
await sh('git', ['add', '-A'], otherRepo);
await sh('git', ['commit', '-qm', 'other'], otherRepo);

const SESSION_ID = 'session-tool-1';
const sessions = [
  { id: SESSION_ID, header: { cwd: repo } },
  { id: 'session-other', header: { cwd: otherRepo } },
  { id: 'session-no-cwd', header: {} },
];
const ctx = {
  subprocess,
  logger: { info() {}, warn() {}, error() {} },
  sessions: { get: (id) => sessions.find((session) => session.id === id), list: () => sessions },
};
const config = { timeoutMs: 30000, maxOutputBytes: 8 * 1024 * 1024, maxDiffLines: 20000, maxLogEntries: 50 };
const service = new SourceControlService(ctx, config);
const tool = sourceControlTool(service);
/** The execution context a tool call receives. */
const exec = (sessionId = SESSION_ID) => ({ agent: sessionId === null ? undefined : { id: sessionId }, signal: undefined });
const routes = new Map(routeTable(service).map((route) => [route.path, route]));

console.log(`# repos: ${repo}\n`);

// ---------------------------------------------------------------------------
console.log('## definition shape');
check(tool.name === TOOL_NAME && TOOL_NAME === 'source_control', 'the tool name is source_control', tool.name);
check(typeof tool.description === 'string' && tool.description.length > 40, 'it carries a model-facing description');
check(tool.parameters.type === 'object', 'parameters is an object-rooted schema');
check(Array.isArray(tool.parameters.required) && tool.parameters.required.includes('action'), 'action is required', tool.parameters.required);
check(
  Array.isArray(tool.parameters.properties.action.enum) && tool.parameters.properties.action.enum.join(',') === ACTIONS.join(','),
  'the action enum is exactly the offered set',
  tool.parameters.properties.action.enum,
);
check(!JSON.stringify(tool.parameters).includes('discard'), 'discard appears nowhere in the parameters');
check(typeof tool.output?.render === 'function', 'output exposes a render');
check(tool.output.schema.type === 'object', 'the output schema is an object');
check(typeof tool.execute === 'function', 'the definition is executable');
const rendered = tool.output.render({ action: 'status' }, { action: 'status', summary: 'hello' });
check(Array.isArray(rendered) && rendered[0]?.type === 'text' && rendered[0].text === 'hello', 'render returns one text block', rendered);

console.log('\n## the tool has no path to discard');
check(!ACTIONS.includes('discard'), 'discard is not an action');
check(ACTIONS.includes('diff'), 'diff is an action');
await rejects(() => readArguments({ action: 'discard', paths: ['tracked.txt'] }), 'tool/invalid-arguments', 'a discard action is refused');
// And the code path itself: no action can reach service.discard.
const discardCalls = [];
const probe = new Proxy(service, {
  get(target, property) {
    if (property === 'discard') return () => {
      discardCalls.push(property);
      throw new Error('discard must not be reachable from the tool');
    };
    return target[property];
  },
});
const probeTool = sourceControlTool(probe);
for (const action of ACTIONS) {
  const args = { action, paths: ['tracked.txt'], message: 'unused' };
  try {
    await probeTool.execute(args, exec());
  } catch {
    // A refusal is fine; reaching discard is not.
  }
}
check(discardCalls.length === 0, 'no action reaches service.discard', discardCalls);

console.log('\n## scope is the calling Session, and nothing else');
await rejects(() => tool.execute({ action: 'status' }, { agent: undefined, signal: undefined }), 'tool/no-agent', 'a call with no owning agent is refused');
// A smuggled `repo` must not widen the scope.
await writeFile(join(otherRepo, 'sneaky.txt'), 'sneaky\n');
const smuggled = await tool.execute({ action: 'status', repo: otherRepo }, exec());
check(!smuggled.summary.includes('elsewhere.txt') && !smuggled.summary.includes('sneaky.txt'), 'a `repo` argument does not change which repository is read', smuggled.summary);
const otherStatus = await tool.execute({ action: 'status' }, exec('session-other'));
check(otherStatus.summary.includes('elsewhere.txt') || otherStatus.summary.includes('sneaky.txt'), 'another Session reads its own repository', otherStatus.summary);
await rejects(() => tool.execute({ action: 'status' }, exec('session-no-cwd')), 'session/no-workspace', 'a Session without a working directory is refused');
await rejects(() => tool.execute({ action: 'status' }, exec('nope')), 'session/unknown', 'an unknown Session is refused');
await rejects(() => service.status({}), 'session/required', 'a request with no selector is refused as a missing Session, not as a missing repository');
// The registry only attaches a structured code to its own HarnessError, which a
// workspace-linked package cannot import, so the code travels in the message.
const coded = await tool
  .execute({ action: 'status' }, exec('nope'))
  .then(() => null)
  .catch((error) => error.message);
check(typeof coded === 'string' && coded.startsWith('session/unknown:'), 'a refusal carries its code in the message', coded);

console.log('\n## an explicit-repo read cannot repoint the Session cache');
// The main page legitimately names a repository explicitly while carrying the
// Session id. That must not publish the named repository as this Session's own:
// the next Session-only call — including an agent mutation — would otherwise
// read and write a repository no Session claims.
await writeFile(join(repo, 'third.txt'), 'third\n');
await writeFile(join(otherRepo, 'elsewhere.txt'), 'elsewhere\nchanged\n');
const explicitStatusRoute = routes.get(`${ROUTE_PREFIX}/status`);
const explicitRead = await explicitStatusRoute.handle({ url: new URL(`http://x${ROUTE_PREFIX}/status?sessionId=${SESSION_ID}&repo=${encodeURIComponent(otherRepo)}`), body: {}, signal: undefined });
check(explicitRead.repository.root === await realpath(otherRepo), 'an explicit read really addresses the named repository', explicitRead.repository.root);
const sessionOnly = await explicitStatusRoute.handle({ url: new URL(`http://x${ROUTE_PREFIX}/status?sessionId=${SESSION_ID}`), body: {}, signal: undefined });
check(sessionOnly.repository.root === await realpath(repo), 'the same Session still resolves its own repository', sessionOnly.repository.root);
const stagedOwn = await tool.execute({ action: 'stage', paths: ['third.txt'] }, exec());
check(stagedOwn.summary.includes('Staged 1'), 'the agent staged inside its own Session repository', stagedOwn.summary);
const otherSession = await tool.execute({ action: 'status' }, exec('session-other'));
check(otherSession.summary.includes('elsewhere.txt') && !otherSession.summary.includes('third.txt'), 'the explicitly read repository kept its own separate state', otherSession.summary);
await tool.execute({ action: 'unstage', paths: ['third.txt'] }, exec());
await rm(join(repo, 'third.txt'));
// The cached fact is bound to the cwd it was resolved for, so a Session whose
// working directory moves cannot keep reading the previous repository.
sessions[0].header.cwd = otherRepo;
const movedSession = await explicitStatusRoute.handle({ url: new URL(`http://x${ROUTE_PREFIX}/status?sessionId=${SESSION_ID}`), body: {}, signal: undefined });
check(movedSession.repository.root === await realpath(otherRepo), 'a Session that changes working directory resolves the new repository', movedSession.repository.root);
sessions[0].header.cwd = repo;

console.log('\n## arguments');
await rejects(() => readArguments({}), 'tool/invalid-arguments', 'a missing action is refused');
await rejects(() => readArguments({ action: 'nope' }), 'tool/invalid-arguments', 'an unknown action is refused');
await rejects(() => readArguments({ action: 'stage' }), 'tool/invalid-arguments', 'stage without paths is refused');
await rejects(() => readArguments({ action: 'stage', paths: [] }), 'tool/invalid-arguments', 'stage with an empty path list is refused');
await rejects(() => readArguments({ action: 'stage', paths: [1] }), 'tool/invalid-arguments', 'a non-string path is refused');
await rejects(() => readArguments({ action: 'diff' }), 'tool/invalid-arguments', 'diff without a path is refused');
await rejects(() => readArguments({ action: 'diff', path: '' }), 'tool/invalid-arguments', 'diff with an empty path is refused');
await rejects(() => readArguments({ action: 'diff', path: 7 }), 'tool/invalid-arguments', 'diff with a non-string path is refused');
await rejects(() => readArguments({ action: 'diff', path: 'a', staged: 'yes' }), 'tool/invalid-arguments', 'a non-boolean staged flag is refused');
await rejects(() => readArguments({ action: 'commit' }), 'tool/invalid-arguments', 'commit without a message is refused');
await rejects(() => readArguments({ action: 'commit', message: 42 }), 'tool/invalid-arguments', 'a non-string message is refused');
await rejects(() => readArguments(null), 'tool/invalid-arguments', 'a null argument object is refused');
await rejects(() => readArguments([{ action: 'status' }]), 'tool/invalid-arguments', 'an array argument is refused');

console.log('\n## actions over a real repository');
const statusFirst = await tool.execute({ action: 'status' }, exec());
check(statusFirst.action === 'status', 'status reports its action');
check(statusFirst.summary.includes('tracked.txt') && statusFirst.summary.includes('fresh.txt'), 'status lists both changes', statusFirst.summary);
check(statusFirst.summary.includes('branch'), 'status names the branch', statusFirst.summary);

const staged = await tool.execute({ action: 'stage', paths: ['tracked.txt', 'fresh.txt'] }, exec());
check(staged.summary.includes('Staged 2'), 'stage reports both paths', staged.summary);
const afterStage = await tool.execute({ action: 'status' }, exec());
check(afterStage.summary.includes('2 staged'), 'status shows both as staged', afterStage.summary);

const restaged = await tool.execute({ action: 'stage', paths: ['tracked.txt'] }, exec());
check(restaged.summary.includes('No change to act on'), 're-staging is a reported no-op', restaged.summary);

const unstaged = await tool.execute({ action: 'unstage', paths: ['fresh.txt'] }, exec());
check(unstaged.summary.includes('Unstaged 1'), 'unstage reports one path', unstaged.summary);

const committed = await tool.execute({ action: 'commit', message: 'via the tool\n\nbody\n' }, exec());
check(/^Committed [0-9a-f]{7}: via the tool/.test(committed.summary), 'commit reports the short hash and subject', committed.summary);
const afterCommit = await tool.execute({ action: 'status' }, exec());
check(!afterCommit.summary.includes('staged'), 'nothing is left staged after the commit', afterCommit.summary);
check(afterCommit.summary.includes('untracked fresh.txt'), 'the path left unstaged is still untracked', afterCommit.summary);
await rejects(() => tool.execute({ action: 'commit', message: 'again' }, exec()), 'git/nothing-staged', 'committing an empty index is refused');
await rejects(() => tool.execute({ action: 'stage', paths: ['../outside.txt'] }, exec()), 'path/outside-repository', 'an escaping path is refused');
const notAChange = await tool.execute({ action: 'stage', paths: ['debug.log'] }, exec());
check(
  notAChange.summary.includes('No change to act on'),
  'a path that is not a current change is a reported no-op, not an error',
  notAChange.summary,
);

// ---------------------------------------------------------------------------
console.log('\n## diff');
// Earlier sections committed everything, so make a real unstaged change first.
await writeFile(join(repo, 'tracked.txt'), 'one\ntwo\nthree\n');
const diffOut = await tool.execute({ action: 'diff', path: 'tracked.txt' }, exec());
check(diffOut.action === 'diff', 'diff reports its action');
check(diffOut.summary.startsWith('tracked.txt (unstaged)'), 'the header names the path and which side is compared', diffOut.summary.split('\n')[0]);
check(diffOut.summary.includes('+three'), 'an added line is rendered with its prefix', diffOut.summary);
check(diffOut.summary.includes('@@'), 'the hunk header is kept verbatim so the numbers are git\'s own', diffOut.summary);
await rejects(() => tool.execute({ action: 'diff', path: '../outside.txt' }, exec()), 'path/outside-repository', 'diff refuses an escaping path');
await rejects(() => tool.execute({ action: 'diff', path: 'nope.txt' }, exec('nope')), 'session/unknown', 'diff still scopes to the agent session');
// An untracked path needs the flag, exactly as the route layer does.
await writeFile(join(repo, 'untracked.txt'), 'brand new\n');
const untrackedDiff = await tool.execute({ action: 'diff', path: 'untracked.txt', untracked: true }, exec());
check(untrackedDiff.summary.startsWith('untracked.txt (untracked)'), 'an untracked diff says so', untrackedDiff.summary.split('\n')[0]);
check(untrackedDiff.summary.includes('+brand new'), 'its content is shown as added', untrackedDiff.summary);
const stagedDiff = await tool.execute({ action: 'diff', path: 'tracked.txt', staged: true }, exec());
check(stagedDiff.summary.startsWith('tracked.txt (staged)'), 'a staged diff says so', stagedDiff.summary.split('\n')[0]);

console.log('\n## renderDiff is pure, and states a cut instead of hiding it');
const sampleDiff = { path: 'a.txt', staged: false, untracked: false, binary: false, added: 1, removed: 0, hunks: [{ header: '@@ -1,1 +1,2 @@', lines: [{ kind: 'ctx', text: 'one' }, { kind: 'add', text: 'two' }] }] };
check(renderDiff(sampleDiff).includes('a.txt (unstaged)'), 'the pure renderer names the path and side');
check(renderDiff({ ...sampleDiff, binary: true, hunks: [] }).includes('Binary file'), 'a binary diff is labelled');
check(renderDiff({ ...sampleDiff, hunks: [] }).includes('No changes to show'), 'an empty diff is labelled');
const manyLines = Array.from({ length: MAX_DIFF_LINES + 25 }, (_, i) => ({ kind: 'add', text: `line ${i}` }));
const huge = renderDiff({ ...sampleDiff, added: manyLines.length, hunks: [{ header: '@@ -1,1 +1,1000 @@', lines: manyLines }] });
check(huge.includes('25 further line(s) cut'), 'the cut is stated with its count', huge.split('\n').slice(-1)[0]);
check(
  huge.split('\n').filter((line) => line.startsWith('+')).length === MAX_DIFF_LINES,
  'exactly the limit is shown',
  huge.split('\n').filter((line) => line.startsWith('+')).length,
);
check(
  !huge.includes(`line ${MAX_DIFF_LINES + 1}`),
  'the lines past the limit are absent, so the count is honest',
);
const metaDiff = renderDiff({ ...sampleDiff, hunks: [{ header: '@@ -1,1 +1,1 @@', lines: [{ kind: 'del', text: 'a' }, { kind: 'meta', text: ' No newline at end of file' }] }] });
check(metaDiff.includes('\\ No newline at end of file'), 'a meta marker keeps its backslash prefix', metaDiff);

// ---------------------------------------------------------------------------
console.log('\n## the two callers agree');
// "One operation, two callers" only holds if both really share the implementation.
// Same operation, same repository, same observable result.
await writeFile(join(repo, 'agreement.txt'), 'agree\n');
const viaTool = await tool.execute({ action: 'stage', paths: ['agreement.txt'] }, exec());
const statusRoute = routes.get(`${ROUTE_PREFIX}/status`);
const viaRoute = await statusRoute.handle({ url: new URL(`http://x${ROUTE_PREFIX}/status?sessionId=${SESSION_ID}`), body: {}, signal: undefined });
check(
  viaRoute.status.staged.some((row) => row.path === 'agreement.txt'),
  'the route sees the change the tool made',
  viaRoute.status.staged.map((row) => row.path),
);
check(viaTool.summary.includes('Staged 1'), 'the tool reported that change', viaTool.summary);
// And the reverse direction: a route write is visible to the tool.
const unstageRoute = routes.get(`${ROUTE_PREFIX}/unstage`);
await unstageRoute.handle({ url: new URL('http://x'), body: { sessionId: SESSION_ID, paths: ['agreement.txt'] }, signal: undefined });
const toolSeesRoute = await tool.execute({ action: 'status' }, exec());
check(!toolSeesRoute.summary.includes('1 staged'), 'the tool sees the route\'s unstage', toolSeesRoute.summary);

console.log('\n## summarize is pure');
const sample = { repository: { branch: 'main', hasCommits: true }, status: { staged: [], changes: [], untracked: [], conflicted: [] } };
check(summarize('status', sample).includes('Working tree clean'), 'an empty status reads as clean');
const detached = summarize('status', { repository: { branch: null, hasCommits: true }, status: { staged: [], changes: [], untracked: [], conflicted: [] } });
check(detached.includes('(detached)'), 'a detached HEAD is labelled', detached);
const unborn = summarize('status', { repository: { branch: 'main', hasCommits: false }, status: { staged: [], changes: [], untracked: [], conflicted: [] } });
check(unborn.includes('no commits yet'), 'an unborn branch is labelled', unborn);
check(summarize('commit', { short: 'abc1234', subject: 's' }) === 'Committed abc1234: s', 'commit summarizes its hash and subject');
const conflictSummary = summarize('status', {
  repository: { branch: 'main', hasCommits: true },
  status: { staged: [], changes: [], untracked: [], conflicted: [{ path: 'c.txt' }] },
});
check(conflictSummary.includes('1 conflicted') && conflictSummary.includes('c.txt'), 'a conflict is reported', conflictSummary);

await rm(scratch, { recursive: true, force: true });
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
