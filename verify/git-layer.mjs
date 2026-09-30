/**
 * Verification for the pure git layer and the path guard.
 *
 * It drives a real scratch repository through the same code the Host uses, over a
 * `node:child_process` adapter, so no Cordis Host is needed. Run with:
 *
 *     node verify/git-layer.mjs
 *
 * Every assertion prints an `ok`/`FAIL` line; the process exits non-zero when any
 * assertion fails.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GitError, GitRunner, createOperations } from '../lib/git.js';
import { assertInside, isInside, resolveRepository } from '../lib/repo.js';

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
 * Assert that an async call rejects with a specific GitError code.
 * @param {() => Promise<unknown>} run - the call under test.
 * @param {string} code - expected error code.
 * @param {string} label - what is being asserted.
 */
async function rejects(run, code, label) {
  checks += 1;
  try {
    await run();
    failures += 1;
    console.log(`FAIL ${label} :: resolved instead of rejecting with ${code}`);
  } catch (error) {
    if (error instanceof GitError && error.code === code) {
      console.log(`ok   ${label}`);
      return;
    }
    failures += 1;
    console.log(`FAIL ${label} :: expected ${code}, got ${error.code ?? String(error)}`);
  }
}

/**
 * Run one command to completion through node's child_process.
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

/** A `ctx.subprocess`-shaped adapter over node's child_process. */
const subprocessAdapter = {
  /**
   * @param {string} command - bare command name.
   * @returns {Promise<string>} the command as given.
   */
  async resolveExecutable(command) {
    return command;
  },
  /**
   * @param {object} spec - the spawn spec.
   * @returns {object} a handle with `done` and collected output readers.
   */
  spawn(spec) {
    const child = spawn(spec.argv[0], spec.argv.slice(1), {
      cwd: spec.cwd,
      env: { ...process.env, ...(spec.env ?? {}) },
    });
    if (spec.stdio?.stdin !== undefined && typeof spec.stdio.stdin === 'object') {
      child.stdin.end(spec.stdio.stdin.data);
    }
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

const scratch = await realpath(await mkdtemp(join(tmpdir(), 'dsh-source-control-verify-')));
const repo = join(scratch, 'repo');
const outside = join(scratch, 'outside');
await mkdir(repo);
await mkdir(outside);
await writeFile(join(outside, 'secret.txt'), 'do not touch\n');
await mkdir(join(outside, 'escape-target'));

await sh('git', ['init', '-q', '.'], repo);
await sh('git', ['config', 'user.email', 'verify@example.com'], repo);
await sh('git', ['config', 'user.name', 'Verify'], repo);
await writeFile(join(repo, 'kept.txt'), 'original line\n');
await writeFile(join(repo, 'torename.txt'), 'rename me with identical content\n');
await mkdir(join(repo, 'sub'));
await writeFile(join(repo, 'sub', 'nested.txt'), 'nested\n');
await sh('git', ['add', '-A'], repo);
await sh('git', ['commit', '-qm', 'initial'], repo);

const runner = new GitRunner(subprocessAdapter, 'git', { timeoutMs: 30000, maxOutputBytes: 8 * 1024 * 1024 });
const ops = createOperations(runner, { maxOutputBytes: 8 * 1024 * 1024, maxDiffLines: 20000, maxLogEntries: 50 });
const io = { root: repo, signal: undefined };
console.log(`# scratch repository: ${repo}\n`);

// ---------------------------------------------------------------------------
console.log('## repository resolution');
const located = await resolveRepository(runner, { cwd: join(repo, 'sub') });
check(located?.root === repo, 'a nested directory resolves to the repository root', located);
check((await resolveRepository(runner, { cwd: outside })) === null, 'a directory outside any repository reports null');
check(isInside(repo, join(repo, 'sub', 'nested.txt')), 'isInside accepts a descendant');
check(!isInside(repo, `${repo}-other`), 'isInside rejects a sibling that shares a prefix');

// ---------------------------------------------------------------------------
console.log('\n## status: one row per class of change');
await writeFile(join(repo, 'kept.txt'), 'original line\nmodified line\n');
await writeFile(join(repo, 'untracked.txt'), 'brand new\n');
await sh('git', ['mv', 'torename.txt', 'renamed.txt'], repo); // pure rename: content identical
await writeFile(join(repo, 'renamed.txt'), 'rename me with identical content\nextra staged edit\n');
await sh('git', ['add', 'renamed.txt'], repo);
await sh('git', ['rm', '-q', 'sub/nested.txt'], repo);
await writeFile(join(repo, 'ignored.log'), 'ignored\n');
await writeFile(join(repo, '.gitignore'), '*.log\n');

const state = await ops.status(io);
check(['master', 'main'].includes(state.branch), 'status reports the branch', state.branch);
const untrackedPaths = state.untracked.map((row) => row.path);
check(untrackedPaths.includes('untracked.txt'), 'an untracked file is grouped as untracked', untrackedPaths);
check(untrackedPaths.includes('.gitignore'), 'untracked listing uses --untracked-files=all', untrackedPaths);
check(!untrackedPaths.includes('ignored.log'), 'an ignored file is not listed as untracked', untrackedPaths);
check(state.changes.some((row) => row.path === 'kept.txt'), 'a modified tracked file is an unstaged change', state.changes);
check(
  state.staged.some((row) => row.path === 'sub/nested.txt' && row.indexStatus === 'D'),
  'a staged deletion is listed as staged',
  state.staged,
);
check(
  !state.changes.some((row) => row.path === 'sub/nested.txt'),
  'a purely staged deletion is not also listed as an unstaged change',
);
const renamedRow = state.staged.find((row) => row.origPath !== null);
check(renamedRow?.path === 'renamed.txt' && renamedRow?.origPath === 'torename.txt', 'a rename carries both its new and original path', renamedRow);
check(renamedRow?.renamed === true, 'a rename is flagged as renamed', renamedRow);

// A rename whose content changed too much is legitimately reported by git as a
// deletion plus an addition; that is git's similarity rule, and the layer must
// pass it through rather than invent a rename.
await writeFile(join(repo, 'rewritten.txt'), 'totally different content that shares nothing at all\n');
await sh('git', ['add', 'rewritten.txt'], repo);
await sh('git', ['rm', '-q', '--cached', 'renamed.txt'], repo);
await writeFile(join(repo, 'renamed.txt'), 'totally different content that shares nothing at all\n');
await sh('git', ['add', 'renamed.txt'], repo);
await sh('git', ['rm', '-q', '--cached', 'rewritten.txt'], repo);

// ---------------------------------------------------------------------------
console.log('\n## diffs');
const untrackedDiff = await ops.diff({ ...io, path: 'untracked.txt', untracked: true });
check(untrackedDiff.added === 1 && untrackedDiff.removed === 0, 'an untracked file diffs as added lines', {
  added: untrackedDiff.added,
  removed: untrackedDiff.removed,
});
const unstagedDiff = await ops.diff({ ...io, path: 'kept.txt', staged: false });
check(unstagedDiff.added === 1, 'an unstaged modification diffs against HEAD', unstagedDiff);
const stagedDiff = await ops.diff({ ...io, path: 'kept.txt', staged: true });
check(stagedDiff.hunks.length === 0, 'a path with no staged change diffs empty', stagedDiff.hunks.length);
const stagedRenameDiff = await ops.diff({ ...io, path: 'renamed.txt', staged: true });
check(stagedRenameDiff.hunks.length > 0, 'a staged change has hunks', stagedRenameDiff.hunks.length);
const numbered = stagedRenameDiff.hunks.every(
  (hunk) => Number.isSafeInteger(hunk.oldStart) && Number.isSafeInteger(hunk.newStart) && hunk.lines.every((line) => typeof line.text === 'string'),
);
check(numbered, 'every hunk carries numeric line numbers and text lines');
const binaryProbe = await ops.diff({ ...io, path: 'untracked.txt', untracked: true });
check(binaryProbe.binary === false, 'a text diff is not reported as binary', binaryProbe.binary);

// ---------------------------------------------------------------------------
console.log('\n## stage and unstage');
await writeFile(join(repo, 'second-untracked.txt'), 'second\n');
await ops.stage({ ...io, paths: ['second-untracked.txt'] });
const afterStage = await ops.status(io);
check(afterStage.staged.some((row) => row.path === 'second-untracked.txt'), 'stage moves a file into the staged group');
check(!afterStage.untracked.some((row) => row.path === 'second-untracked.txt'), 'a staged file leaves the untracked group');
await ops.unstage({ ...io, paths: ['second-untracked.txt'] });
const afterUnstage = await ops.status(io);
check(afterUnstage.untracked.some((row) => row.path === 'second-untracked.txt'), 'unstage returns a file to the untracked group');
check(!afterUnstage.staged.some((row) => row.path === 'second-untracked.txt'), 'an unstaged file leaves the staged group');
const keptContent = await readFile(join(repo, 'kept.txt'), 'utf8');
check(keptContent.includes('modified line'), 'unstage does not touch the working tree');
const idempotentUnstage = await ops.unstage({ ...io, paths: ['second-untracked.txt'] });
check(idempotentUnstage.alreadyUnstaged.includes('second-untracked.txt'), 'unstaging an already-unstaged path is a reported no-op');

// ---------------------------------------------------------------------------
console.log('\n## commit');
await rejects(() => ops.commit({ ...io, message: '   ' }), 'git/empty-message', 'a blank commit message is refused');
await ops.stage({ ...io, paths: ['kept.txt', 'renamed.txt', 'sub/nested.txt', 'untracked.txt', 'second-untracked.txt', '.gitignore'] });
const idempotentStage = await ops.stage({ ...io, paths: ['renamed.txt'] });
check(idempotentStage.alreadyStaged.includes('renamed.txt'), 'staging an already-staged path is a reported no-op, not an error');
const committed = await ops.commit({ ...io, message: 'verify commit\n\nbody line\n' });
check(/^[0-9a-f]{40}$/.test(committed.hash), 'commit reports the new hash', committed.hash);
check(committed.subject === 'verify commit', 'commit reports its subject', committed.subject);
const afterCommit = await ops.status(io);
check(afterCommit.staged.length === 0 && afterCommit.changes.length === 0, 'a commit empties the working tree', afterCommit);
await rejects(() => ops.commit({ ...io, message: 'again' }), 'git/nothing-staged', 'committing an empty index is refused');
const history = await ops.log(io);
check(history[0]?.hash === committed.hash, 'the new commit is the history head', history[0]);
check(history[0]?.body.includes('body line'), 'a multi-line message keeps its body', history[0]?.body);
check(history.length === 2, 'history lists every commit', history.length);

// ---------------------------------------------------------------------------
console.log('\n## unborn branch (a repository with zero commits)');
const unborn = join(scratch, 'unborn');
await mkdir(unborn);
await sh('git', ['init', '-q', '.'], unborn);
await sh('git', ['config', 'user.email', 'verify@example.com'], unborn);
await sh('git', ['config', 'user.name', 'Verify'], unborn);
const unbornIo = { root: unborn, signal: undefined };
const unbornHead = await ops.head(unbornIo);
check(unbornHead.hasCommits === false && unbornHead.head === null, 'an unborn branch reports no commit', unbornHead);
check(typeof unbornHead.branch === 'string' && unbornHead.branch !== '', 'an unborn branch still names its branch', unbornHead.branch);
check((await ops.log(unbornIo)).length === 0, 'an unborn branch has an empty history');
check((await ops.status(unbornIo)).staged.length === 0, 'an unborn branch has an empty status');
await writeFile(join(unborn, 'first.txt'), 'first content\n');
await ops.stage({ ...unbornIo, paths: ['first.txt'] });
const firstCommit = await ops.commit({ ...unbornIo, message: 'the very first commit' });
check(/^[0-9a-f]{40}$/.test(firstCommit.hash), 'the first commit on an unborn branch succeeds', firstCommit);
check((await ops.log(unbornIo)).length === 1, 'history lists the first commit');
await writeFile(join(unborn, 'first.txt'), 'thrown away\n');
await ops.discard({ ...unbornIo, paths: ['first.txt'] });
check((await readFile(join(unborn, 'first.txt'), 'utf8')) === 'first content\n', 'discard restores from the first commit');

// ---------------------------------------------------------------------------
console.log('\n## discard');
await writeFile(join(repo, 'kept.txt'), 'thrown away\n');
await ops.discard({ ...io, paths: ['kept.txt'] });
const discarded = await ops.status(io);
check(!discarded.changes.some((row) => row.path === 'kept.txt'), 'discard reverts a tracked file to HEAD');
check((await readFile(join(repo, 'kept.txt'), 'utf8')) === 'original line\nmodified line\n', 'discard restores the committed content');
await writeFile(join(repo, 'throwaway.txt'), 'delete me\n');
const discardedUntracked = await ops.discard({ ...io, paths: ['throwaway.txt'] });
check(discardedUntracked.removed.includes('throwaway.txt'), 'discard classifies an untracked path as a deletion', discardedUntracked);
const cleaned = await ops.status(io);
check(!cleaned.untracked.some((row) => row.path === 'throwaway.txt'), 'discard deletes an untracked file');

// ---------------------------------------------------------------------------
console.log('\n## pathspec literals (a path must never widen into a pattern)');
// git reads a path argument as a pathspec glob unless told otherwise. Staging a
// file literally named `report[1].txt` would also stage `report1.txt`, and the
// `git clean -f` behind discard would delete a sibling matched by the pattern.
const globRepo = join(scratch, 'glob');
await mkdir(globRepo);
await sh('git', ['init', '-q', '.'], globRepo);
await sh('git', ['config', 'user.email', 'verify@example.com'], globRepo);
await sh('git', ['config', 'user.name', 'Verify'], globRepo);
await writeFile(join(globRepo, 'keep.txt'), 'base\n');
await sh('git', ['add', '-A'], globRepo);
await sh('git', ['commit', '-qm', 'base'], globRepo);
await writeFile(join(globRepo, 'report[1].txt'), 'bracket\n');
await writeFile(join(globRepo, 'report1.txt'), 'plain\n');
await writeFile(join(globRepo, 'star*.txt'), 'star\n');
await writeFile(join(globRepo, 'starZZZ.txt'), 'bystander\n');
const globIo = { root: globRepo, signal: undefined };

await ops.stage({ ...globIo, paths: ['report[1].txt'] });
const afterGlobStage = await ops.status(globIo);
const globStaged = afterGlobStage.staged.map((row) => row.path);
check(globStaged.includes('report[1].txt'), 'the requested bracket-named file is staged', globStaged);
check(!globStaged.includes('report1.txt'), 'staging a glob-looking name does NOT stage a different file', globStaged);

await ops.discard({ ...globIo, paths: ['star*.txt'] });
const starExists = async (name) => {
  try {
    await readFile(join(globRepo, name), 'utf8');
    return true;
  } catch {
    return false;
  }
};
check(!(await starExists('star*.txt')), 'discard removes the requested star-named file');
check(await starExists('starZZZ.txt'), 'discard does NOT delete a bystander that merely matched the pattern');
const remaining = await ops.status(globIo);
check(
  remaining.untracked.some((row) => row.path === 'starZZZ.txt'),
  'the bystander is still present in the working tree',
  remaining.untracked.map((row) => row.path),
);
check(
  !remaining.untracked.some((row) => row.path === 'star*.txt'),
  'the requested file is gone from the working tree',
  remaining.untracked.map((row) => row.path),
);

// ---------------------------------------------------------------------------
console.log('\n## path guard');
await rejects(() => assertInside(repo, '../outside/secret.txt'), 'path/outside-repository', 'a `..` escape is refused');
await rejects(() => assertInside(repo, '/etc/passwd'), 'path/outside-repository', 'an absolute outside path is refused');
await rejects(
  () => assertInside(repo, join(outside, 'secret.txt')),
  'path/outside-repository',
  'an absolute sibling path is refused',
);
await rejects(() => assertInside(repo, ''), 'path/invalid', 'an empty path is refused');
await rejects(() => assertInside(repo, 'kept.txt\u0000'), 'path/invalid', 'a NUL byte is refused');
await rejects(() => assertInside(repo, '.'), 'path/invalid', 'the repository root itself is refused');
await rejects(() => assertInside(repo, 'sub/'), 'path/invalid', 'a directory path is refused');
const deletedWithParent = await assertInside(repo, 'gone-dir/gone.txt');
check(
  deletedWithParent === join('gone-dir', 'gone.txt'),
  'a deleted file whose directory is gone is accepted (git recreates it)',
  deletedWithParent,
);

await symlink(join(outside, 'escape-target'), join(repo, 'escape-link'));
await rejects(
  () => assertInside(repo, 'escape-link/payload.txt'),
  'path/outside-repository',
  'a path whose parent is a symlink out of the repository is refused',
);
const insideLink = await assertInside(repo, 'sub/nested.txt');
check(insideLink === join('sub', 'nested.txt'), 'a normal nested path passes and is returned relative', insideLink);
const outsideRepoLink = await assertInside(repo, 'escape-link');
check(outsideRepoLink === 'escape-link', 'a leaf symlink inside the repository is allowed (git stores it as a blob)');

// ---------------------------------------------------------------------------
console.log('\n## no network git');
const source = await readFile(new URL('../lib/git.js', import.meta.url), 'utf8');
for (const verb of ['fetch', 'pull', 'push', 'remote', 'clone', 'ls-remote']) {
  const pattern = new RegExp(`['"\`]${verb}['"\`]`);
  check(!pattern.test(source), `lib/git.js runs no \`git ${verb}\``);
}

await rm(scratch, { recursive: true, force: true });
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
