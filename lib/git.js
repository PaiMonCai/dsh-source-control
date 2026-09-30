/**
 * Pure git layer: argv-only invocation plus status/diff/log parsing.
 *
 * This module knows nothing about Cordis, Sessions, or HTTP. It receives a
 * {@link GitRunner} (already bound to a resolved `git` executable) and returns
 * plain data, so it can be driven directly by a verification script against a
 * scratch repository.
 *
 * Invariants this module is responsible for:
 * - argv only; no argument is ever shell-interpreted;
 * - every path argument is passed after `--`;
 * - a command's environment is scrubbed of ambient git configuration, terminal
 *   prompting, and optional locks.
 *
 * Path containment is NOT decided here: {@link assertInside} in `./repo.js` is
 * the single guard, and callers must run every path through it first.
 */

/** Kill grace for one managed child process. */
const TERMINATE_GRACE_MS = 2000;
/** Retained stderr tail for diagnostics. */
const STDERR_TAIL_BYTES = 16 * 1024;
/** Field separator inside one `git log` record. */
const LOG_FIELD = '\u001f';
/** Record separator between `git log` records. */
const LOG_RECORD = '\u001e';

/** A git invocation that failed, or a repository state that forbids the request. */
export class GitError extends Error {
  /**
   * @param {string} code - stable machine code the route layer forwards.
   * @param {string} message - human-readable reason.
   * @param {object} [details] - optional structured context.
   */
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'GitError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Strip a trailing newline git appends to human-facing output.
 * @param {string} text - raw output.
 * @returns {string} the same text without one trailing `\n`.
 */
function trimEol(text) {
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

/**
 * Split NUL-delimited output into records, dropping the trailing empty token.
 * @param {string} text - `-z` output.
 * @returns {string[]} records.
 */
function splitNul(text) {
  if (text === '') return [];
  const parts = text.split('\u0000');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/**
 * Run one resolved git executable with a scrubbed environment and bounded output.
 *
 * One runner is created per service instance and reused; each call gets its own
 * timeout and abort signal.
 */
export class GitRunner {
  /**
   * @param {object} subprocess - `ctx.subprocess`.
   * @param {string} executable - absolute path to the git executable.
   * @param {object} limits - `{timeoutMs, maxOutputBytes}`.
   */
  constructor(subprocess, executable, limits) {
    this.subprocess = subprocess;
    this.executable = executable;
    this.limits = limits;
  }

  /**
   * Run `git <args>` to completion.
   * @param {string[]} args - git arguments.
   * @param {object} [options] - `{cwd, signal, stdin, maxBytes, allowExitCodes}`.
   * @returns {Promise<{exitCode: number, stdout: string, stderr: string, truncated: boolean}>} exit facts.
   * @throws {GitError} when the command times out, is aborted, or cannot spawn.
   */
  async run(args, options = {}) {
    const timeout = AbortSignal.timeout(this.limits.timeoutMs);
    const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
    let handle;
    try {
      handle = this.subprocess.spawn({
        argv: [this.executable, ...args],
        cwd: options.cwd,
        stdio: {
          stdin: options.stdin === undefined ? 'ignore' : { data: options.stdin },
          stdout: { maxBytes: options.maxBytes ?? this.limits.maxOutputBytes },
          stderr: { maxBytes: STDERR_TAIL_BYTES },
        },
        graceMs: TERMINATE_GRACE_MS,
        signal,
        env: {
          GIT_CONFIG_COUNT: '0',
          GIT_TERMINAL_PROMPT: '0',
          GIT_OPTIONAL_LOCKS: '0',
          GIT_PAGER: 'cat',
          // Every path this package passes comes verbatim from `git status`
          // output and must be treated as one literal file. Without this, git
          // reads a path as a pathspec glob: staging a file literally named
          // `report[1].txt` also stages `report1.txt`, and — far worse — the
          // `git clean -f` behind discard would DELETE a sibling that merely
          // matched the pattern (`star*.txt` also removes `starZZZ.txt`).
          GIT_LITERAL_PATHSPECS: '1',
          LC_ALL: 'C',
        },
      });
    } catch (error) {
      throw new GitError('git/spawn-failed', `git ${args[0] ?? ''} could not start`, {
        reason: String(error),
      });
    }
    const outcome = await handle.done;
    if (signal.aborted) {
      throw new GitError(
        timeout.aborted ? 'git/timeout' : 'git/aborted',
        timeout.aborted
          ? `git ${args.join(' ')} timed out after ${this.limits.timeoutMs}ms`
          : `git ${args.join(' ')} was aborted`,
      );
    }
    const stdout = handle.collected.stdout?.readFrom(0) ?? { text: '', lossy: false };
    const stderr = handle.collected.stderr?.readFrom(0).text ?? '';
    // A cut stdout must never be parsed as if it were complete. The collect mode
    // stops at `maxBytes`, and every parser here would silently turn the prefix
    // into wrong data: a 3000-line change reported as "0 added, 410 removed", a
    // truncated date, a status missing entries. Refusing is the only honest
    // answer, and it is what the configuration documents.
    if (stdout.lossy) {
      throw new GitError(
        'git/output-too-large',
        `git ${args[0]} produced more output than the ${this.limits.maxOutputBytes}-byte limit; raise maxOutputBytes to read it`,
        { command: args[0], maxOutputBytes: this.limits.maxOutputBytes },
      );
    }
    return {
      exitCode: outcome.exitCode,
      stdout: stdout.text,
      stderr,
      truncated: false,
    };
  }

  /**
   * Run a command that must exit zero, or report its stderr as a business failure.
   * @param {string[]} args - git arguments.
   * @param {object} [options] - see {@link GitRunner#run}.
   * @param {string} [what] - command description for the failure message.
   * @returns {Promise<object>} the exit facts.
   * @throws {GitError} with code `git/failed` when the exit code is non-zero.
   */
  async ok(args, options = {}, what = undefined) {
    const result = await this.run(args, options);
    if (result.exitCode !== 0) {
      throw new GitError('git/failed', `${what ?? `git ${args[0]}`} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`, {
        exitCode: result.exitCode,
      });
    }
    return result;
  }
}

/**
 * Parse `git status --porcelain=v2 --branch -z` into a working-tree summary.
 *
 * A path appears in `staged` when its index status differs from `.`, in
 * `unstaged` when its worktree status differs from `.`, and in `untracked` when
 * git reported `?`. A path staged AND modified again appears in both, which is
 * how VS Code presents it.
 *
 * @param {string} text - raw `-z` output.
 * @returns {{branch: string|null, oid: string|null, upstream: string|null, ahead: number, behind: number, entries: object[]}} the summary.
 */
export function parseStatus(text) {
  const summary = {
    branch: null,
    oid: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    entries: [],
  };
  const records = splitNul(text);
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === '') continue;
    if (record.startsWith('# ')) {
      const [key, ...rest] = record.slice(2).split(' ');
      const value = rest.join(' ');
      if (key === 'branch.oid') summary.oid = value === '(initial)' ? null : value;
      else if (key === 'branch.head') summary.branch = value === '(detached)' ? null : value;
      else if (key === 'branch.upstream') summary.upstream = value;
      else if (key === 'branch.ab') {
        const [, ahead, behind] = value.match(/^\+(\d+) -(\d+)$/) ?? [];
        summary.ahead = Number(ahead ?? 0);
        summary.behind = Number(behind ?? 0);
      }
      continue;
    }
    const kind = record[0];
    if (kind === '1' || kind === '2') {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path> NUL <origPath>
      const fields = record.split(' ');
      const xy = fields[1] ?? '..';
      const renameScore = kind === '2' ? (fields[8] ?? '') : '';
      let path = kind === '2' ? fields.slice(9).join(' ') : fields.slice(8).join(' ');
      let origPath = null;
      if (kind === '2') {
        origPath = records[index + 1] ?? null;
        index += 1;
      }
      summary.entries.push({
        path,
        origPath,
        x: xy[0] ?? '.',
        y: xy[1] ?? '.',
        renameScore,
        untracked: false,
        unmerged: false,
      });
      continue;
    }
    if (kind === 'u') {
      const fields = record.split(' ');
      const xy = fields[1] ?? '..';
      summary.entries.push({
        path: fields.slice(10).join(' '),
        origPath: null,
        x: xy[0] ?? '.',
        y: xy[1] ?? '.',
        renameScore: '',
        untracked: false,
        unmerged: true,
      });
      continue;
    }
    if (kind === '?') {
      summary.entries.push({
        path: record.slice(2),
        origPath: null,
        x: '?',
        y: '?',
        renameScore: '',
        untracked: true,
        unmerged: false,
      });
    }
    // '!' (ignored) records are not requested and are skipped if they appear.
  }
  return summary;
}

/**
 * Parse unified diff output into hunks with line numbers, for a viewer that
 * needs old/new numbering without re-deriving it in the browser.
 *
 * Two details matter for correct numbering:
 * - a line starting with `\` is git's `\ No newline at end of file` marker, not
 *   content. Counting it as a context line would consume an old and a new line
 *   number and shift every subsequent line of the hunk;
 * - splitting on `\n` leaves a trailing empty element for output that ends with a
 *   newline, which would appear as a phantom empty context line in the last hunk
 *   and inflate the line count used by the size limit.
 *
 * @param {string} text - `git diff` output.
 * @returns {{header: string[], hunks: object[], binary: boolean, added: number, removed: number}} the parsed diff.
 */
export function parseDiff(text) {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const header = [];
  const hunks = [];
  let current = null;
  let binary = false;
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.startsWith('@@')) {
      const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
      current = {
        header: line,
        section: match?.[5]?.trim() ?? '',
        oldStart: Number(match?.[1] ?? 0),
        oldCount: Number(match?.[2] ?? 1),
        newStart: Number(match?.[3] ?? 0),
        newCount: Number(match?.[4] ?? 1),
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (current === null) {
      if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) binary = true;
      if (line !== '') header.push(line);
      continue;
    }
    // A marker carries no line number on either side and is not counted.
    if (line.startsWith('\\')) {
      current.lines.push({ kind: 'meta', text: line.slice(1) });
      continue;
    }
    const kind = line[0];
    if (kind === '+') added += 1;
    else if (kind === '-') removed += 1;
    current.lines.push({
      kind: kind === '+' ? 'add' : kind === '-' ? 'del' : 'ctx',
      text: line.slice(1),
    });
  }
  if (text.includes('Binary files ') || text.includes('GIT binary patch')) binary = true;
  return { header, hunks, binary, added, removed };
}

/**
 * Cut one hunk out of a complete `git diff` patch, keeping the file header.
 *
 * The result is a valid one-hunk patch: `git apply` rejects a patch whose hunk
 * headers disagree with the lines beneath them, so a hunk is always taken whole
 * (from its `@@` to the next `@@` or the end) rather than by line count. The file
 * header is kept verbatim, which is what lets `--cached` check the preimage
 * against the index.
 *
 * `index` addresses the hunk the caller was shown, and it is the ONLY thing the
 * caller supplies: the patch itself is always regenerated here from live git
 * output, so no caller can name a path or content of its own.
 *
 * @param {string} raw - complete `git diff` output for one path.
 * @param {number} index - zero-based hunk index.
 * @returns {{patch: string, total: number}} the one-hunk patch and the hunk count.
 * @throws {GitError} code `git/no-such-hunk` when the index is out of range.
 */
export function slicePatch(raw, index) {
  const lines = raw.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const firstHunk = lines.findIndex((line) => line.startsWith('@@'));
  if (firstHunk === -1) {
    throw new GitError('git/no-such-hunk', 'this path has no hunks to act on', { total: 0 });
  }
  const starts = [];
  for (let at = firstHunk; at < lines.length; at += 1) {
    if (lines[at].startsWith('@@')) starts.push(at);
  }
  if (!Number.isSafeInteger(index) || index < 0 || index >= starts.length) {
    throw new GitError('git/no-such-hunk', `hunk ${index} does not exist for this path`, { index, total: starts.length });
  }
  const from = starts[index];
  const to = index + 1 < starts.length ? starts[index + 1] : lines.length;
  const patch = [...lines.slice(0, firstHunk), ...lines.slice(from, to)];
  return { patch: `${patch.join('\n')}\n`, total: starts.length };
}

/**
 * Build every read and write operation over one working directory.
 *
 * Read operations never mutate. Write operations are the complete mutation set of
 * this package: stage, unstage, discard, commit. No operation contacts a network;
 * there is deliberately no fetch, pull, push, or remote command here.
 *
 * @param {GitRunner} git - the command runner.
 * @param {object} config - `{maxOutputBytes, maxDiffLines, maxLogEntries}`.
 * @returns {object} the operation table.
 */
export function createOperations(git, config) {
  /**
   * Read the working tree.
   * @param {object} io - `{root, signal}`.
   * @returns {Promise<object>} branch facts and every changed entry, grouped.
   */
  async function status({ root, signal }) {
    const result = await git.ok(['status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z'], { cwd: root, signal }, 'git status');
    const summary = parseStatus(result.stdout);
    const staged = [];
    const changes = [];
    const untracked = [];
    const conflicted = [];
    for (const entry of summary.entries) {
      const row = {
        path: entry.path,
        origPath: entry.origPath,
        renamed: entry.x === 'R' || entry.origPath !== null,
        staged: entry.x !== '.' && entry.x !== '?',
        indexStatus: entry.x,
        worktreeStatus: entry.y,
        untracked: entry.untracked,
        unmerged: entry.unmerged,
      };
      if (entry.unmerged) conflicted.push(row);
      else if (entry.untracked) untracked.push(row);
      if (!entry.untracked && !entry.unmerged) {
        if (row.staged) staged.push(row);
        if (entry.y !== '.') changes.push(row);
      }
    }
    return {
      branch: summary.branch,
      oid: summary.oid,
      upstream: summary.upstream,
      ahead: summary.ahead,
      behind: summary.behind,
      staged,
      changes,
      untracked,
      conflicted,
    };
  }

  /**
   * Compare one path against the index (`staged`) or HEAD (`unstaged`).
   *
   * An untracked path has no committed counterpart, so it is compared against
   * the empty side through `git diff --no-index`, which yields the whole file as
   * added lines — a truthful answer rather than an empty diff.
   *
   * @param {object} io - `{root, path, staged, untracked, signal}`.
   * @returns {Promise<object>} `{path, staged, binary, header, hunks, added, removed}`.
   * @throws {GitError} code `git/diff-too-large` when the diff exceeds the configured line cap.
   */
  async function diff({ root, path, staged, untracked, signal }) {
    let result;
    if (untracked === true) {
      // `--no-index` exits 1 when the files differ, which is the expected case here.
      result = await git.run(['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-index', '--', '/dev/null', path], {
        cwd: root,
        signal,
      });
    } else {
      const args = staged
        ? ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--cached', '--', path]
        : ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--', path];
      result = await git.run(args, { cwd: root, signal });
    }
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new GitError('git/failed', `git diff failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`, {
        exitCode: result.exitCode,
      });
    }
    const parsed = parseDiff(result.stdout);
    const total = parsed.hunks.reduce((count, hunk) => count + hunk.lines.length, 0);
    if (total > config.maxDiffLines) {
      throw new GitError('git/diff-too-large', `diff for ${path} has ${total} lines, above the ${config.maxDiffLines}-line limit`, {
        path,
        lines: total,
      });
    }
    return {
      path,
      staged: Boolean(staged),
      untracked: untracked === true,
      binary: parsed.binary,
      header: parsed.header,
      added: parsed.added,
      removed: parsed.removed,
      hunks: parsed.hunks,
    };
  }

  /**
   * List recent commits.
   * @param {object} io - `{root, skip, signal}`.
   * @returns {Promise<object[]>} commits, newest first.
   */
  async function log({ root, skip = 0, signal }) {
    const format = ['%H', '%h', '%an', '%aI', '%s', '%b'].join('%x1f') + '%x1e';
    const args = [
      'log',
      `--max-count=${config.maxLogEntries}`,
      `--skip=${skip}`,
      '--no-color',
      '--no-decorate',
      `--pretty=format:${format}`,
    ];
    const result = await git.run(args, { cwd: root, signal });
    if (result.exitCode !== 0) {
      // An unborn branch has no commits; that is a state, not a failure.
      if (/does not have any commits yet|unknown revision|bad default revision/.test(result.stderr)) return [];
      throw new GitError('git/failed', `git log failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`, {
        exitCode: result.exitCode,
      });
    }
    const commits = [];
    for (const record of result.stdout.split(LOG_RECORD)) {
      const trimmed = record.replace(/^[\n\r]+/, '');
      if (trimmed === '') continue;
      const [hash, short, author, date, subject, body] = trimmed.split(LOG_FIELD);
      commits.push({
        hash,
        short,
        author,
        date,
        subject: subject ?? '',
        body: (body ?? '').replace(/^[\n\r]+|[\n\r]+$/g, ''),
      });
    }
    return commits;
  }

  /**
   * Stage paths.
   *
   * The effective set is computed from the working tree rather than from the
   * requested list, because the UI may submit a row the user has since changed:
   * staging an already-staged deletion makes git exit 128 with a pathspec error,
   * and a stale click must not surface as a failure. `-A` is required so a
   * deletion is staged too; plain `git add` refuses a path missing from the work
   * tree.
   *
   * @param {object} io - `{root, paths, signal}`.
   * @returns {Promise<object>} `{paths, staged, alreadyStaged}`.
   */
  async function stage({ root, paths, signal }) {
    const current = await status({ root, signal });
    const pending = new Set();
    for (const row of current.untracked) pending.add(row.path);
    for (const row of current.changes) pending.add(row.path);
    const staged = paths.filter((path) => pending.has(path));
    const alreadyStaged = paths.filter((path) => !pending.has(path));
    if (staged.length > 0) await git.ok(['add', '-A', '--', ...staged], { cwd: root, signal }, 'git add');
    return { paths, staged, alreadyStaged };
  }

  /**
   * Unstage paths, leaving the working tree untouched.
   *
   * As with {@link stage}, only paths that are actually staged are submitted, so a
   * stale row is a no-op instead of an error. `git restore --staged` is used
   * rather than `git reset` because it also works on an unborn branch.
   *
   * @param {object} io - `{root, paths, signal}`.
   * @returns {Promise<object>} `{paths, unstaged, alreadyUnstaged}`.
   */
  async function unstage({ root, paths, signal }) {
    const current = await status({ root, signal });
    const staged = new Set(current.staged.map((row) => row.path));
    const unstaged = paths.filter((path) => staged.has(path));
    const alreadyUnstaged = paths.filter((path) => !staged.has(path));
    if (unstaged.length > 0) {
      await git.ok(['restore', '--staged', '--', ...unstaged], { cwd: root, signal }, 'git restore --staged');
    }
    return { paths, unstaged, alreadyUnstaged };
  }

  /**
   * Discard uncommitted changes for paths.
   *
   * The effective set is computed from the working tree, not from the caller, and
   * by POSITIVE membership — a path reaches git only when it is a change git
   * itself reports. `stage` and `unstage` validate the same way; a negative test
   * here let any path the guard allowed through to `git restore`, which answered
   * with a raw pathspec error for a file the UI would never send.
   *
   * A tracked change is unstaged and restored from HEAD; an untracked path has no
   * committed content to restore and is deleted through `git clean`, which is
   * asked for those exact paths, keeps ignored files, and is never recursive.
   *
   * @param {object} io - `{root, paths, signal}`.
   * @returns {Promise<object>} `{restored, removed, unchanged}`.
   */
  async function discard({ root, paths, signal }) {
    const current = await status({ root, signal });
    const untracked = new Set(current.untracked.map((row) => row.path));
    const changed = new Set([
      ...current.staged.map((row) => row.path),
      ...current.changes.map((row) => row.path),
      ...untracked,
    ]);
    const known = paths.filter((path) => changed.has(path));
    const unchanged = paths.filter((path) => !changed.has(path));
    const removed = known.filter((path) => untracked.has(path));
    const restored = known.filter((path) => !untracked.has(path));
    if (restored.length > 0) {
      await git.ok(['restore', '--staged', '--worktree', '--', ...restored], { cwd: root, signal }, 'git restore');
    }
    if (removed.length > 0) {
      await git.ok(['clean', '-f', '--', ...removed], { cwd: root, signal }, 'git clean');
    }
    return { restored, removed, unchanged };
  }

  /**
   * Commit the staged index.
   * @param {object} io - `{root, message, signal}`.
   * @returns {Promise<object>} `{hash, short, subject}`.
   * @throws {GitError} code `git/nothing-staged` when the index is empty.
   */
  async function commit({ root, message, signal }) {
    if (typeof message !== 'string') {
      throw new GitError('git/invalid-message', 'a commit message must be a string');
    }
    const trimmed = message.replace(/^\s+|\s+$/g, '');
    if (trimmed === '') throw new GitError('git/empty-message', 'a commit message is required');
    const stagedDiff = await git.run(['diff', '--cached', '--quiet'], { cwd: root, signal });
    if (stagedDiff.exitCode === 0) {
      throw new GitError('git/nothing-staged', 'nothing is staged to commit');
    }
    // `--no-verify` is deliberately absent: the repository's pre-commit and
    // commit-msg hooks are its guardrails (lint, tests, secret scans), and a UI
    // that silently skips them would let work through that the repository
    // refuses. A hook failure surfaces as an ordinary commit failure.
    await git.ok(['commit', '-F', '-'], { cwd: root, signal, stdin: trimmed }, 'git commit');
    const head = await git.ok(['rev-parse', 'HEAD'], { cwd: root, signal }, 'git rev-parse HEAD');
    const hash = trimEol(head.stdout).trim();
    const subject = trimmed.split('\n')[0];
    return { hash, short: hash.slice(0, 7), subject };
  }

  /**
   * Read those facts about the repository the UI shows in its header: the current
   * branch name and whether a commit exists at all.
   * @param {object} io - `{root, signal}`.
   * @returns {Promise<object>} `{branch, head, hasCommits}`.
   */
  async function head({ root, signal }) {
    const branchResult = await git.run(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: root, signal });
    const branch = branchResult.exitCode === 0 ? trimEol(branchResult.stdout).trim() : null;
    const headResult = await git.run(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: root, signal });
    const tip = headResult.exitCode === 0 ? trimEol(headResult.stdout).trim() : null;
    return { branch, head: tip, hasCommits: tip !== null };
  }

  /**
   * Regenerate one path's patch for a side, then hand it to `git apply`.
   *
   * Every hunk operation shares this: the patch is rebuilt from live git output
   * and sliced by index, so the only caller-supplied inputs are a path (already
   * through the guard) and a hunk number.
   *
   * @param {object} io - `{root, path, hunkIndex, side, signal}`.
   * @param {string[]} applyArgs - the `git apply` flags for this intent.
   * @returns {Promise<object>} `{path, hunkIndex, total}`.
   */
  async function applyHunk({ root, path, hunkIndex, side, signal }, applyArgs) {
    const argv = side === 'index'
      ? ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--cached', '--', path]
      : ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--', path];
    const result = await git.run(argv, { cwd: root, signal });
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new GitError('git/failed', `git diff failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`, {
        exitCode: result.exitCode,
      });
    }
    const { patch, total } = slicePatch(result.stdout, hunkIndex);
    // The patch travels on stdin, never as a file the caller could name, and
    // never through a shell.
    await git.ok(['apply', ...applyArgs, '--whitespace=nowarn', '-'], { cwd: root, signal, stdin: patch }, 'git apply');
    return { path, hunkIndex, total };
  }

  /**
   * Stage one hunk of a path's unstaged change.
   * @param {object} io - `{root, path, hunkIndex, signal}`.
   * @returns {Promise<object>} `{path, hunkIndex, total}`.
   */
  async function stageHunk({ root, path, hunkIndex, signal }) {
    return applyHunk({ root, path, hunkIndex, side: 'worktree', signal }, ['--cached']);
  }

  /**
   * Unstage one hunk of a path's staged change, leaving the working tree alone.
   * @param {object} io - `{root, path, hunkIndex, signal}`.
   * @returns {Promise<object>} `{path, hunkIndex, total}`.
   */
  async function unstageHunk({ root, path, hunkIndex, signal }) {
    return applyHunk({ root, path, hunkIndex, side: 'index', signal }, ['--cached', '-R']);
  }

  /**
   * Discard one hunk of a path's unstaged change from the working tree.
   *
   * Reached only from the HTTP routes: like whole-file discard this is
   * irreversible, so the agent tool does not expose it.
   *
   * @param {object} io - `{root, path, hunkIndex, signal}`.
   * @returns {Promise<object>} `{path, hunkIndex, total}`.
   */
  async function discardHunk({ root, path, hunkIndex, signal }) {
    return applyHunk({ root, path, hunkIndex, side: 'worktree', signal }, ['-R']);
  }

  return { status, diff, log, stage, unstage, discard, commit, head, stageHunk, unstageHunk, discardHunk };
}

export { trimEol, splitNul };
