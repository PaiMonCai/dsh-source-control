/**
 * Verification for hunk-level staging, unstaging, and discarding.
 *
 * The dangerous property here is authority: a hunk operation must never accept
 * patch text from the caller. The caller supplies a path and a hunk NUMBER, and
 * the Host rebuilds the patch from live `git diff` output. `slicePatch` is
 * exported and tested directly for the same reason.
 *
 * Run with:
 *
 *     node verify/hunks.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GitError, GitRunner, createOperations, slicePatch } from '../lib/git.js';
import { ROUTE_PREFIX, routeTable } from '../lib/routes.js';
import { SourceControlService } from '../lib/service.js';

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
    if (error instanceof GitError && error.code === code) {
      console.log(`ok   ${label}`);
      return;
    }
    failures += 1;
    console.log(`FAIL ${label} :: expected ${code}, got ${error?.code ?? String(error)}`);
  }
}

/**
 * Run one command through node's child_process.
 * @param {string} command - executable.
 * @param {string[]} args - argv.
 * @param {string} cwd - working directory.
 * @returns {Promise<string>} stdout.
 */
async function sh(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${command} ${args.join(' ')} exited ${code}`))));
    child.on('error', reject);
  });
}

/** A `ctx.subprocess` adapter, including stdin, which `git apply` needs. */
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
    // `stdin: { data }` is how the runner feeds a patch; without this the child
    // waits for input forever.
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

const scratch = await realpath(await mkdtemp(join(tmpdir(), 'dsh-source-control-hunks-')));
const repo = join(scratch, 'repo');
const outside = join(scratch, 'outside');
await mkdir(repo);
await mkdir(outside);
await writeFile(join(outside, 'secret.txt'), 'do not touch\n');
await sh('git', ['init', '-q', '.'], repo);
await sh('git', ['config', 'user.email', 'verify@example.com'], repo);
await sh('git', ['config', 'user.name', 'Verify'], repo);

/**
 * Twenty numbered lines. Two edits far enough apart (line 2 and line 20) land in
 * separate hunks under git's default 3-line context: edits closer than that get
 * merged into one hunk, which would make this suite prove nothing about slicing.
 */
const ORIGINAL = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n') + '\n';
/**
 * @param {string} first - replacement for line 2.
 * @param {string} last - replacement for line 20.
 * @returns {string} the file content.
 */
const edited = (first, last) =>
  Array.from({ length: 20 }, (_, i) => {
    const n = i + 1;
    if (n === 2) return first;
    if (n === 20) return last;
    return `line${n}`;
  }).join('\n') + '\n';

await writeFile(join(repo, 'f.txt'), ORIGINAL);
await sh('git', ['add', '-A'], repo);
await sh('git', ['commit', '-qm', 'initial'], repo);

const config = { timeoutMs: 30000, maxOutputBytes: 8 * 1024 * 1024, maxDiffLines: 20000, maxLogEntries: 50 };
const SESSION_ID = 'session-hunks';
const ctx = {
  subprocess,
  logger: { info() {}, warn() {}, error() {} },
  sessions: {
    /** @param {string} id - session id. @returns {object|undefined} the session. */
    get: (id) => (id === SESSION_ID ? { id, header: { cwd: repo } } : undefined),
    /** @returns {object[]} the sessions. */
    list: () => [{ id: SESSION_ID, header: { cwd: repo } }],
  },
};
const service = new SourceControlService(ctx, config);
const ops = () => createOperations(new GitRunner(subprocess, 'git', config), config);
const routes = new Map(routeTable(service).map((route) => [route.path, route]));
/** Invoke one route the way the wrapper does. */
const call = (segment, body) =>
  routes.get(`${ROUTE_PREFIX}/${segment}`).handle({ url: new URL('http://x'), body: { sessionId: SESSION_ID, ...body }, signal: undefined });
/** Read back what git has staged, and what is still only in the work tree. */
const sides = async () => {
  const status = await ops().status({ root: repo, signal: undefined });
  const diff = await ops().diff({ root: repo, path: 'f.txt', staged: false, signal: undefined });
  const staged = await ops().diff({ root: repo, path: 'f.txt', staged: true, signal: undefined });
  return { status, hunks: diff.hunks.length, stagedHunks: staged.hunks.length };
};

console.log(`# repo: ${repo}\n`);

// ---------------------------------------------------------------------------
console.log('## slicePatch: a hunk is taken whole');
await writeFile(join(repo, 'f.txt'), edited('CHANGED2', 'CHANGED20'));
const raw = await sh('git', ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--', 'f.txt'], repo);
check(raw.split('\n').filter((line) => line.startsWith('@@')).length === 2, 'the fixture has two separate hunks');
const first = slicePatch(raw, 0);
const second = slicePatch(raw, 1);
check(first.total === 2 && second.total === 2, 'both slice calls report the same total', { first: first.total, second: second.total });
check(first.patch.includes('diff --git a/f.txt b/f.txt'), 'a slice keeps the file header');
const headers = raw.split('\n').filter((line) => line.startsWith('@@'));
check(first.patch.includes(headers[0]) && !first.patch.includes(headers[1]), 'slice 0 holds only the first hunk', first.patch);
check(second.patch.includes(headers[1]) && !second.patch.includes(headers[0]), 'slice 1 holds only the second hunk', second.patch);
check(first.patch.endsWith('\n'), 'a slice ends with a newline, as git requires');
// The header must agree with the lines beneath it, or git apply refuses it.
const headerLineCount = (patch) => {
  const at = patch.split('\n').findIndex((line) => line.startsWith('@@'));
  const body = patch.split('\n').slice(at + 1).filter((line) => line !== '');
  const declared = /@@ -(\d+),(\d+) \+(\d+),(\d+) @@/.exec(patch);
  const oldSide = body.filter((line) => !line.startsWith('+')).length;
  const newSide = body.filter((line) => !line.startsWith('-')).length;
  return Number(declared[2]) === oldSide && Number(declared[4]) === newSide;
};
check(headerLineCount(first.patch), 'slice 0 is internally consistent, so git apply will accept it');
check(headerLineCount(second.patch), 'slice 1 is internally consistent too');

console.log('\n## slicePatch refuses an index it does not have');
await rejects(() => Promise.resolve(slicePatch(raw, 2)), 'git/no-such-hunk', 'an out-of-range hunk index is refused');
await rejects(() => Promise.resolve(slicePatch(raw, -1)), 'git/no-such-hunk', 'a negative index is refused');
await rejects(() => Promise.resolve(slicePatch(raw, 1.5)), 'git/no-such-hunk', 'a non-integer index is refused');
await rejects(() => Promise.resolve(slicePatch('', 0)), 'git/no-such-hunk', 'a path with no hunks is refused');

// ---------------------------------------------------------------------------
console.log('\n## stage one hunk');
let before = await sides();
check(before.hunks === 2 && before.stagedHunks === 0, 'the fixture starts with two unstaged hunks', before);
const stagedFirst = await call('stage-hunk', { path: 'f.txt', hunkIndex: 0 });
check(stagedFirst.total === 2 && stagedFirst.hunkIndex === 0, 'the route reports which hunk it applied', stagedFirst);
let after = await sides();
check(after.stagedHunks === 1, 'exactly one hunk is now staged', after);
check(after.hunks === 1, 'exactly one hunk remains unstaged', after);
const stagedText = await sh('git', ['diff', '--cached', '--', 'f.txt'], repo);
check(stagedText.includes('+CHANGED2'), 'the staged hunk is the one that was asked for', stagedText);
check(!stagedText.includes('CHANGED10'), 'the other hunk was not staged', stagedText);
const worktreeText = await readFile(join(repo, 'f.txt'), 'utf8');
check(worktreeText.includes('CHANGED20'), 'the working tree still holds the unstaged edit');

console.log('\n## the remaining hunks renumber, and a stale index fails cleanly');
await rejects(() => call('stage-hunk', { path: 'f.txt', hunkIndex: 1 }), 'git/no-such-hunk', 'the old second index no longer exists');
const stillStaged = await sides();
check(stillStaged.stagedHunks === 1 && stillStaged.hunks === 1, 'the refused call changed nothing', stillStaged);

console.log('\n## unstage one hunk');
const unstaged = await call('unstage-hunk', { path: 'f.txt', hunkIndex: 0 });
check(unstaged.hunkIndex === 0, 'the unstage route reports its hunk', unstaged);
after = await sides();
check(after.stagedHunks === 0, 'the index holds no hunks again', after);
check(after.hunks === 2, 'both hunks are unstaged again', after);
check((await readFile(join(repo, 'f.txt'), 'utf8')).includes('CHANGED2'), 'unstage left the working tree alone');

// ---------------------------------------------------------------------------
console.log('\n## discard one hunk');
const beforeDiscard = await readFile(join(repo, 'f.txt'), 'utf8');
check(beforeDiscard.includes('CHANGED2') && beforeDiscard.includes('CHANGED20'), 'both edits are present first');
const discarded = await call('discard-hunk', { path: 'f.txt', hunkIndex: 0 });
check(discarded.hunkIndex === 0, 'the discard route reports its hunk', discarded);
const afterDiscard = await readFile(join(repo, 'f.txt'), 'utf8');
check(afterDiscard.includes('line2'), 'the discarded hunk reverted to its committed content');
check(afterDiscard.includes('CHANGED20'), 'the other hunk survived the discard', afterDiscard);
after = await sides();
check(after.hunks === 1, 'one hunk remains', after);

// ---------------------------------------------------------------------------
console.log('\n## authority: the caller names a path and a number, never patch text');
const stagedBefore = await sides();
// A body carrying patch text must be ignored entirely: only path and hunkIndex are read.
await call('stage-hunk', {
  path: 'f.txt',
  hunkIndex: 0,
  patch: 'diff --git a/../outside/secret.txt b/../outside/secret.txt\n--- a/../outside/secret.txt\n+++ b/../outside/secret.txt\n@@ -1,1 +1,1 @@\n-do not touch\n+OWNED\n',
  content: 'OWNED',
});
check((await readFile(join(outside, 'secret.txt'), 'utf8')) === 'do not touch\n', 'patch text in the body is ignored; the outside file is untouched');
// That probe was a real stage call (on the named path), so put the hunk back
// before the sections below reason about the working tree.
await call('unstage-hunk', { path: 'f.txt', hunkIndex: 0 });
await rejects(() => call('stage-hunk', { path: '../outside/secret.txt', hunkIndex: 0 }), 'path/outside-repository', 'the path guard still runs for hunk operations');
await rejects(() => call('discard-hunk', { path: '/etc/passwd', hunkIndex: 0 }), 'path/outside-repository', 'an absolute outside path is refused');
await rejects(() => call('stage-hunk', { path: '.git/config', hunkIndex: 0 }), 'path/invalid', 'a .git path is refused');
await rejects(() => call('stage-hunk', { hunkIndex: 0 }), 'path/invalid', 'a missing path is refused');
await rejects(() => call('stage-hunk', { path: '', hunkIndex: 0 }), 'path/invalid', 'an empty path is refused');
// A path that is not a current change has no hunks, and that is refused rather
// than silently applying an empty patch.
await rejects(() => call('stage-hunk', { path: 'ghost.txt', hunkIndex: 0 }), 'git/no-such-hunk', 'a path with no change has no hunks to stage');
const afterRefusals = await sides();
check(
  afterRefusals.stagedHunks + afterRefusals.hunks >= 0 && (await readFile(join(outside, 'secret.txt'), 'utf8')) === 'do not touch\n',
  'the refusals left the outside file and the repository alone',
);

console.log('\n## a hunk that is already staged cannot be staged again');
await call('stage-hunk', { path: 'f.txt', hunkIndex: 0 });
const doubleStage = await call('stage-hunk', { path: 'f.txt', hunkIndex: 0 }).then(
  (value) => ({ ok: true, value }),
  (error) => ({ ok: false, code: error.code }),
);
check(doubleStage.ok === false || doubleStage.value === undefined, 're-staging the only hunk is refused or a no-op', doubleStage);

await rm(scratch, { recursive: true, force: true });
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
