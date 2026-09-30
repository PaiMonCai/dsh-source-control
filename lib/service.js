/**
 * The Source Control service: repository resolution, the containment guard, and
 * the operation table the routes expose.
 *
 * This is the only place a caller-supplied path is turned into a git argument, so
 * the path guard lives here rather than in the route layer. A route cannot reach
 * git without passing through {@link SourceControlService#withPaths}.
 */
import { GitError, GitRunner, createOperations } from './git.js';
import { assertInside, resolveRepository } from './repo.js';

/**
 * How long one resolved `sessionId -> repository` fact is reused. A Session's cwd
 * never changes, so the entry only becomes stale when the directory stops being a
 * repository; a `turn/end` event clears it.
 */
const REPOSITORY_CACHE_TTL_MS = 30000;

/** Locate one path's repository, reporting absence instead of throwing. */
export class SourceControlService {
  /**
   * @param {object} ctx - the Host context carrying `subprocess` and `sessions`.
   * @param {object} config - validated plugin configuration.
   */
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config;
    /** @type {GitRunner|null} lazily resolved, so a Host without git still loads. */
    this.runner = null;
    /** @type {Promise<GitRunner|null>|null} */
    this.runnerPending = null;
    /** @type {Map<string, {at: number, value: object|null}>} sessionId -> repository */
    this.repositories = new Map();
    /** @type {Map<string, {at: number, value: object|null}>} cwd -> repository */
    this.byCwd = new Map();
  }

  /**
   * Resolve the git executable once per service instance.
   *
   * A Host without a usable git is a reported state (`git-unavailable`), never a
   * load failure: the panel renders the reason instead of the plugin refusing to
   * mount.
   *
   * @param {AbortSignal} [signal] - cancellation for the lookup.
   * @returns {Promise<GitRunner|null>} the runner, or null when git is unavailable.
   */
  async git(signal) {
    if (this.runner !== null) return this.runner;
    this.runnerPending ??= (async () => {
      try {
        const executable = await this.ctx.subprocess.resolveExecutable('git', undefined, signal);
        return new GitRunner(this.ctx.subprocess, executable, {
          timeoutMs: this.config.timeoutMs,
          maxOutputBytes: this.config.maxOutputBytes,
        });
      } catch {
        return null;
      }
    })();
    const resolved = await this.runnerPending;
    if (resolved !== null) this.runner = resolved;
    else this.runnerPending = null;
    return resolved;
  }

  /**
   * Report the executable this service would use, for the panel's diagnostics.
   * @returns {Promise<{available: boolean, executable: string|null}>} availability.
   */
  async gitInfo() {
    const runner = await this.git();
    return { available: runner !== null, executable: runner?.executable ?? null };
  }

  /**
   * Resolve one Session's working directory.
   * @param {string} sessionId - the Session identity.
   * @returns {string} the absolute working directory.
   * @throws {GitError} code `session/unknown` or `session/no-workspace`.
   */
  sessionCwd(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new GitError('session/required', 'a sessionId is required');
    }
    const session = this.ctx.sessions.get(sessionId);
    if (session === undefined) {
      throw new GitError('session/unknown', `no live Session ${sessionId}`, { sessionId });
    }
    const cwd = session.header?.cwd;
    if (typeof cwd !== 'string' || cwd === '') {
      throw new GitError('session/no-workspace', 'this Session has no working directory', { sessionId });
    }
    return cwd;
  }

  /**
   * Locate the repository enclosing a working directory, with a short cache.
   * @param {string} cwd - absolute working directory.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<object|null>} `{root, gitDir}`, or null when cwd is not in a repository.
   */
  async repositoryForCwd(cwd, signal) {
    const cached = this.byCwd.get(cwd);
    if (cached !== undefined && Date.now() - cached.at < REPOSITORY_CACHE_TTL_MS) return cached.value;
    const runner = await this.git(signal);
    if (runner === null) return null;
    const value = await resolveRepository(runner, { cwd, signal });
    this.byCwd.set(cwd, { at: Date.now(), value });
    return value;
  }

  /**
   * Resolve the repository a request addresses.
   *
   * Either an explicit `repo` (an absolute directory path, used by the main page's
   * picker) or a `sessionId` (used by the sidebar tab) is accepted; at least one is
   * required.
   *
   * @param {object} request - `{sessionId?, repo?, signal?}`.
   * @returns {Promise<object>} `{root, gitDir, cwd, git, cwdLabel}`.
   * @throws {GitError} code `git/unavailable` or `repo/not-a-repository`.
   */
  async context(request) {
    const runner = await this.git(request.signal);
    if (runner === null) {
      throw new GitError('git/unavailable', 'git is not available on this Host');
    }
    let cwd;
    if (typeof request.repo === 'string' && request.repo !== '') {
      cwd = request.repo;
    } else {
      cwd = this.sessionCwd(request.sessionId);
      const cached = this.repositories.get(request.sessionId);
      if (cached !== undefined && Date.now() - cached.at < REPOSITORY_CACHE_TTL_MS) {
        if (cached.value === null) {
          throw new GitError('repo/not-a-repository', `${cwd} is not inside a Git repository`, { path: cwd });
        }
        return { ...cached.value, cwd, git: runner, cwdLabel: cwd };
      }
    }
    const repository = await this.repositoryForCwd(cwd, request.signal);
    if (typeof request.sessionId === 'string' && request.sessionId !== '') {
      this.repositories.set(request.sessionId, { at: Date.now(), value: repository });
    }
    if (repository === null) {
      throw new GitError('repo/not-a-repository', `${cwd} is not inside a Git repository`, { path: cwd });
    }
    return { ...repository, cwd, git: runner, cwdLabel: cwd };
  }

  /**
   * Prove every caller-supplied path stays inside the repository, returning the
   * repository-relative forms git receives.
   *
   * This is the single choke point for path authority: an operation that takes
   * paths must obtain them here.
   *
   * @param {string} root - absolute repository root.
   * @param {unknown} paths - the caller's path list.
   * @param {object} [options] - `{limit}` maximum accepted entries.
   * @returns {Promise<string[]>} repository-relative paths.
   * @throws {GitError} code `path/invalid` or `path/outside-repository`.
   */
  async withPaths(root, paths, options = {}) {
    const limit = options.limit ?? 2000;
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new GitError('path/invalid', 'at least one path is required');
    }
    if (paths.length > limit) {
      throw new GitError('path/invalid', `at most ${limit} paths are accepted at once`, { count: paths.length });
    }
    const checked = [];
    for (const path of paths) checked.push(await assertInside(root, path));
    return checked;
  }

  /**
   * Drop cached repository facts for one Session, or all of them.
   * @param {string} [sessionId] - the Session to forget.
   */
  invalidate(sessionId) {
    if (typeof sessionId === 'string') {
      this.repositories.delete(sessionId);
      return;
    }
    this.repositories.clear();
    this.byCwd.clear();
  }

  // -------------------------------------------------------------------------
  // The operation set, as one API with two callers.
  //
  // The HTTP routes and the agent tool both call THESE methods, so an operation
  // has exactly one implementation and the two callers cannot drift. Each takes
  // the same request shape the routes receive: a `sessionId` or an explicit
  // `repo`, plus its own arguments. Every path argument passes through
  // {@link withPaths}, which is why the guard has no second entrance.
  // -------------------------------------------------------------------------

  /**
   * Report git availability and the repositories the live Sessions offer.
   * @param {object} request - `{signal}`.
   * @returns {Promise<object>} `{available, executable, repositories}`.
   */
  async describe({ signal } = {}) {
    const info = await this.gitInfo();
    const candidates = [];
    const seen = new Set();
    for (const session of this.ctx.sessions.list()) {
      const cwd = session.header?.cwd;
      if (typeof cwd !== 'string' || cwd === '') continue;
      let repository = null;
      try {
        repository = await this.repositoryForCwd(cwd, signal);
      } catch {
        repository = null;
      }
      const key = repository?.root ?? cwd;
      if (seen.has(key)) {
        const existing = candidates.find((row) => row.root === key);
        if (existing !== undefined && !existing.sessionIds.includes(session.id)) existing.sessionIds.push(session.id);
        continue;
      }
      seen.add(key);
      candidates.push({
        root: repository?.root ?? null,
        cwd,
        label: (repository?.root ?? cwd).split('/').filter(Boolean).pop() ?? (repository?.root ?? cwd),
        sessionIds: [session.id],
        isRepository: repository !== null,
      });
    }
    return { available: info.available, executable: info.executable, repositories: candidates };
  }

  /**
   * The working-tree summary, with the repository facts the UI shows.
   * @param {object} request - `{sessionId, repo, signal}`.
   * @returns {Promise<object>} `{repository, status}`.
   */
  async status(request) {
    const context = await this.context(request);
    const ops = this.operations;
    const head = await ops.head({ root: context.root, signal: request.signal });
    const summary = await ops.status({ root: context.root, signal: request.signal });
    return {
      repository: {
        root: context.root,
        cwd: context.cwd,
        branch: head.branch,
        head: head.head,
        hasCommits: head.hasCommits,
      },
      status: summary,
    };
  }

  /**
   * Compare one path against the index or HEAD.
   * @param {object} request - `{sessionId, repo, path, staged, untracked, signal}`.
   * @returns {Promise<object>} the parsed diff.
   */
  async diff(request) {
    const context = await this.context(request);
    const [path] = await this.withPaths(context.root, [request.path], { limit: 1 });
    return this.operations.diff({
      root: context.root,
      path,
      staged: request.staged === true,
      untracked: request.untracked === true,
      signal: request.signal,
    });
  }

  /**
   * Recent commits, newest first.
   * @param {object} request - `{sessionId, repo, skip, signal}`.
   * @returns {Promise<object>} `{commits}`.
   */
  async log(request) {
    const context = await this.context(request);
    const skip = Number.isSafeInteger(request.skip) && request.skip > 0 ? request.skip : 0;
    return { commits: await this.operations.log({ root: context.root, skip, signal: request.signal }) };
  }

  /**
   * Stage paths.
   * @param {object} request - `{sessionId, repo, paths, signal}`.
   * @returns {Promise<object>} `{paths, staged, alreadyStaged}`.
   */
  async stage(request) {
    const context = await this.context(request);
    const paths = await this.withPaths(context.root, request.paths);
    return this.operations.stage({ root: context.root, paths, signal: request.signal });
  }

  /**
   * Unstage paths, leaving the working tree untouched.
   * @param {object} request - `{sessionId, repo, paths, signal}`.
   * @returns {Promise<object>} `{paths, unstaged, alreadyUnstaged}`.
   */
  async unstage(request) {
    const context = await this.context(request);
    const paths = await this.withPaths(context.root, request.paths);
    return this.operations.unstage({ root: context.root, paths, signal: request.signal });
  }

  /**
   * Discard uncommitted changes.
   *
   * Reached only from the HTTP routes. The agent tool deliberately does not
   * expose this operation: discarding is irreversible and destroys work the user
   * has not committed.
   *
   * @param {object} request - `{sessionId, repo, paths, signal}`.
   * @returns {Promise<object>} `{restored, removed, unchanged}`.
   */
  async discard(request) {
    const context = await this.context(request);
    const paths = await this.withPaths(context.root, request.paths);
    return this.operations.discard({ root: context.root, paths, signal: request.signal });
  }

  /**
   * Stage one hunk of a path's unstaged change.
   * @param {object} request - `{sessionId, repo, path, hunkIndex, signal}`.
   * @returns {Promise<object>} `{path, hunkIndex, total}`.
   */
  async stageHunk(request) {
    const context = await this.context(request);
    const [path] = await this.withPaths(context.root, [request.path], { limit: 1 });
    return this.operations.stageHunk({ root: context.root, path, hunkIndex: request.hunkIndex, signal: request.signal });
  }

  /**
   * Unstage one hunk of a path's staged change.
   * @param {object} request - `{sessionId, repo, path, hunkIndex, signal}`.
   * @returns {Promise<object>} `{path, hunkIndex, total}`.
   */
  async unstageHunk(request) {
    const context = await this.context(request);
    const [path] = await this.withPaths(context.root, [request.path], { limit: 1 });
    return this.operations.unstageHunk({ root: context.root, path, hunkIndex: request.hunkIndex, signal: request.signal });
  }

  /**
   * Discard one hunk of a path's unstaged change.
   *
   * Reached only from the HTTP routes, like whole-file discard: irreversible, so
   * the agent tool has no action for it.
   *
   * @param {object} request - `{sessionId, repo, path, hunkIndex, signal}`.
   * @returns {Promise<object>} `{path, hunkIndex, total}`.
   */
  async discardHunk(request) {
    const context = await this.context(request);
    const [path] = await this.withPaths(context.root, [request.path], { limit: 1 });
    return this.operations.discardHunk({ root: context.root, path, hunkIndex: request.hunkIndex, signal: request.signal });
  }

  /**
   * Commit the staged index.
   * @param {object} request - `{sessionId, repo, message, signal}`.
   * @returns {Promise<object>} `{hash, short, subject}`.
   */
  async commit(request) {
    const context = await this.context(request);
    return this.operations.commit({ root: context.root, message: request.message, signal: request.signal });
  }

  /** The complete operation table, bound to this service's config. */
  get operations() {
    return createOperations(this.operationsRunner, this.config);
  }

  /**
   * Run git through a runner resolved on demand, so the operation table can be
   * built before the executable is known.
   */
  get operationsRunner() {
    const service = this;
    return {
      executable: '',
      /**
       * @param {string[]} args - git arguments.
       * @param {object} options - run options.
       * @returns {Promise<object>} exit facts.
       */
      async run(args, options) {
        const runner = await service.git(options?.signal);
        if (runner === null) throw new GitError('git/unavailable', 'git is not available on this Host');
        return runner.run(args, options);
      },
      /**
       * @param {string[]} args - git arguments.
       * @param {object} options - run options.
       * @param {string} [what] - command description.
       * @returns {Promise<object>} exit facts.
       */
      async ok(args, options, what) {
        const runner = await service.git(options?.signal);
        if (runner === null) throw new GitError('git/unavailable', 'git is not available on this Host');
        return runner.ok(args, options, what);
      },
    };
  }
}
