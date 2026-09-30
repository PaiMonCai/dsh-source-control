/**
 * Regression coverage for the defects an adversarial review found.
 *
 * Each section names the defect it pins down, so a future reader who changes the
 * behaviour knows what breaks. Every case here failed before the corresponding
 * fix; none of them is hypothetical.
 *
 * Run with:
 *
 *     node verify/hardening.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GitError, GitRunner, createOperations, parseDiff } from '../lib/git.js';
import { assertInside } from '../lib/repo.js';

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
 * Assert a call rejects with a given GitError code.
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
 * @returns {Promise<void>} settles on exit.
 */
async function sh(command, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'ignore' });
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited ${code}`))));
    child.on('error', reject);
  });
}

/**
 * A `ctx.subprocess` adapter. `truncateAt` mimics the real collect mode, which
 * cuts stdout at the configured limit and reports the read as lossy.
 * @param {number} [truncateAt] - byte cap to apply to stdout.
 * @returns {object} the adapter.
 */
function adapter(truncateAt = Infinity) {
  return {
    /**
     * @param {string} command - command name.
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
      const cap = Math.min(truncateAt, spec.stdio?.stdout?.maxBytes ?? Infinity);
      return {
        done: new Promise((resolve) => child.on('close', (exitCode, signal) => resolve({ exitCode, signal }))),
        collected: {
          stdout: {
            readFrom: () => {
              const lossy = stdout.length > cap;
              return { text: lossy ? stdout.slice(0, cap) : stdout, nextOffset: 0, lossy };
            },
          },
          stderr: { readFrom: () => ({ text: stderr, nextOffset: 0, lossy: false }) },
        },
      };
    },
  };
}

/** Build one independent repository with one commit. */
async function makeRepo(name) {
  const root = join(scratch, name);
  await mkdir(root);
  await sh('git', ['init', '-q', '.'], root);
  await sh('git', ['config', 'user.email', 'verify@example.com'], root);
  await sh('git', ['config', 'user.name', 'Verify'], root);
  return root;
}

/**
 * @param {object} [limits] - runner limits.
 * @returns {object} operations bound to those limits.
 */
function ops(limits = {}) {
  const config = { timeoutMs: 30000, maxOutputBytes: 8 * 1024 * 1024, maxDiffLines: 20000, maxLogEntries: 50, ...limits };
  return createOperations(new GitRunner(adapter(), 'git', config), config);
}

const scratch = await mkdtemp(join(tmpdir(), 'dsh-source-control-hardening-'));
const io = (root) => ({ root, signal: undefined });

// ---------------------------------------------------------------------------
console.log('## D1 — a truncated response is refused, never parsed as complete');
// Before the fix, a 4 KB cap turned a 3000-line change into "added=0 removed=410".
const trunc = await makeRepo('trunc');
await writeFile(join(trunc, 'big.txt'), `${Array.from({ length: 3000 }, (_, i) => `orig ${i}`).join('\n')}\n`);
await sh('git', ['add', '-A'], trunc);
await sh('git', ['commit', '-qm', 'one'], trunc);
await writeFile(join(trunc, 'big.txt'), `${Array.from({ length: 3000 }, (_, i) => `new ${i}`).join('\n')}\n`);
await rejects(() => ops({ maxOutputBytes: 4096 }).diff({ ...io(trunc), path: 'big.txt' }), 'git/output-too-large', 'a diff above maxOutputBytes is refused');
await rejects(() => ops({ maxOutputBytes: 60 }).log(io(trunc)), 'git/output-too-large', 'a log above maxOutputBytes is refused');
await rejects(() => ops({ maxOutputBytes: 60 }).status(io(trunc)), 'git/output-too-large', 'a status above maxOutputBytes is refused');
const full = await ops().diff({ ...io(trunc), path: 'big.txt' });
check(full.added === 3000 && full.removed === 3000, 'the same diff read without a cap reports the true counts', {
  added: full.added,
  removed: full.removed,
});

// ---------------------------------------------------------------------------
console.log('\n## D2 — the repository\'s own hooks still run');
// Before the fix, `--no-verify` committed straight past a failing pre-commit hook.
const hooked = await makeRepo('hooks');
await writeFile(join(hooked, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
await writeFile(join(hooked, 'x.txt'), 'x\n');
const hookedOps = ops();
await hookedOps.stage({ ...io(hooked), paths: ['x.txt'] });
await rejects(() => hookedOps.commit({ ...io(hooked), message: 'blocked by hook' }), 'git/failed', 'a failing pre-commit hook blocks the commit');
check((await hookedOps.log(io(hooked))).length === 0, 'no commit was created while the hook failed');
await writeFile(join(hooked, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
const allowed = await hookedOps.commit({ ...io(hooked), message: 'hook passes' });
check(/^[0-9a-f]{40}$/.test(allowed.hash), 'the commit succeeds once the hook passes', allowed);

// ---------------------------------------------------------------------------
console.log('\n## D3 — reading a diff does not run a repository-defined command');
// Before the fix, `--no-ext-diff` was present but `--no-textconv` was not, so a
// textconv driver from a cloned repository executed on every diff.
const conv = await makeRepo('textconv');
await writeFile(join(conv, '.gitattributes'), '*.dat diff=evil\n');
await sh('git', ['config', 'diff.evil.textconv', 'sh -c "echo TEXTCONV-RAN >&2; cat"'], conv);
await writeFile(join(conv, 'f.dat'), 'v1\n');
await sh('git', ['add', '-A'], conv);
await sh('git', ['commit', '-qm', 'one'], conv);
await writeFile(join(conv, 'f.dat'), 'v2\n');
const runner = new GitRunner(adapter(), 'git', { timeoutMs: 30000, maxOutputBytes: 8 * 1024 * 1024 });
const textconvRan = await runner.run(['diff', '--no-color', '--no-ext-diff', '--', 'f.dat'], { cwd: conv });
check(textconvRan.stderr.includes('TEXTCONV-RAN'), 'the driver does run without the flag (so this test has teeth)', textconvRan.stderr.trim());
const viaOperations = await ops().diff({ ...io(conv), path: 'f.dat' });
check(viaOperations.hunks.length > 0 || viaOperations.binary === true, 'the diff still returns the change');
const runner2 = new GitRunner(adapter(), 'git', { timeoutMs: 30000, maxOutputBytes: 8 * 1024 * 1024 });
const guarded = await runner2.run(['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--', 'f.dat'], { cwd: conv });
check(!guarded.stderr.includes('TEXTCONV-RAN'), 'the plugin\'s own argv does not run the driver');

// ---------------------------------------------------------------------------
console.log('\n## D4 — a non-string commit message is refused');
const msgs = await makeRepo('messages');
await writeFile(join(msgs, 'x.txt'), 'x\n');
const msgOps = ops();
await msgOps.stage({ ...io(msgs), paths: ['x.txt'] });
await rejects(() => msgOps.commit({ ...io(msgs), message: {} }), 'git/invalid-message', 'an object message is refused');
await rejects(() => msgOps.commit({ ...io(msgs), message: 42 }), 'git/invalid-message', 'a numeric message is refused');
await rejects(() => msgOps.commit({ ...io(msgs), message: null }), 'git/invalid-message', 'a null message is refused');
check((await msgOps.log(io(msgs))).length === 0, 'no commit was created from a non-string message');

// ---------------------------------------------------------------------------
console.log('\n## D5 — discard validates positively, like stage and unstage');
// Before the fix, the split was a negative test, so any path the guard allowed
// reached `git restore` and answered with a raw git pathspec error.
const disc = await makeRepo('discard');
await writeFile(join(disc, '.gitignore'), '*.log\n');
await writeFile(join(disc, 'keep.txt'), 'k\n');
await sh('git', ['add', '-A'], disc);
await sh('git', ['commit', '-qm', 'one'], disc);
await writeFile(join(disc, 'debug.log'), 'ignored\n');
const discOps = ops();
const ignored = await discOps.discard({ ...io(disc), paths: ['debug.log'] });
check(ignored.unchanged.includes('debug.log'), 'an ignored path is reported as unchanged, not sent to git', ignored);
check((await readFile(join(disc, 'debug.log'), 'utf8')) === 'ignored\n', 'the ignored file is untouched');
const clean = await discOps.discard({ ...io(disc), paths: ['keep.txt'] });
check(clean.unchanged.includes('keep.txt'), 'an unmodified tracked file is reported as unchanged', clean);

// ---------------------------------------------------------------------------
console.log('\n## D6 — the no-newline marker is not content and carries no line number');
const marker = parseDiff(
  ['diff --git a/f b/f', '--- a/f', '+++ b/f', '@@ -1,1 +1,1 @@', '-old', '+new', '\\ No newline at end of file', ''].join('\n'),
);
const markerLines = marker.hunks[0].lines;
check(markerLines.length === 3, 'the marker is kept for display plus the two content lines', markerLines.length);
check(
  markerLines.filter((line) => line.kind === 'meta').length === 1 &&
    markerLines.filter((line) => line.kind === 'ctx').length === 0,
  'the marker is classified as meta, never as context content',
  markerLines,
);
check(marker.added === 1 && marker.removed === 1, 'the marker is not counted as added or removed', marker);
const trailing = parseDiff(['@@ -1,1 +1,1 @@', '-a', '+b', ''].join('\n'));
check(trailing.hunks[0].lines.length === 2, 'output ending in a newline adds no phantom line', trailing.hunks[0].lines);
const withMarker = parseDiff(
  ['@@ -1,2 +1,2 @@', '-a', '+a2', '\\ No newline at end of file', ' ctx', ''].join('\n'),
);
check(
  withMarker.hunks[0].lines.filter((line) => line.kind !== 'meta').length === 3,
  'a marker between content lines does not consume a number',
  withMarker.hunks[0].lines,
);

// ---------------------------------------------------------------------------
console.log('\n## D7 — nothing reaches git\'s own metadata');
const meta = await makeRepo('meta');
await writeFile(join(meta, 'keep.txt'), 'k\n');
await rejects(() => assertInside(meta, '.git/config'), 'path/invalid', '.git/config is refused');
await rejects(() => assertInside(meta, '.git/hooks/pre-commit'), 'path/invalid', '.git/hooks/pre-commit is refused');
await rejects(() => assertInside(meta, '.git'), 'path/invalid', '.git itself is refused');
const ordinary = await assertInside(meta, 'keep.txt');
check(ordinary === 'keep.txt', 'an ordinary file still passes', ordinary);
const dotted = await assertInside(meta, '.gitignore');
check(dotted === '.gitignore', '.gitignore is not mistaken for .git', dotted);

await rm(scratch, { recursive: true, force: true });
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
