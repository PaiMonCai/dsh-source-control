/**
 * The Source Control service: repository resolution, the containment guard, and
 * the operation table the routes expose.
 *
 * Current worktree paths pass through this service's containment guard. Historic
 * paths are checked lexically here and against the commit's files by the git
 * layer, without consulting today's filesystem. Mutations share one queue per
 * canonical repository root; this does not lock out external git processes.
 */
import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import { GitError, GitRunner, createOperations } from './git.js';
import { assertInside, resolveRepository } from './repo.js';
import { createGitHubReader, GitHubReadError } from './github-api.js';
import { createGitHubAuthorization } from './github-auth.js';

/**
 * How long one resolved `sessionId -> repository` fact is reused. A Session's cwd
 * never changes, so the entry only becomes stale when the directory stops being a
 * repository; a `turn/end` event clears it.
 */
const REPOSITORY_CACHE_TTL_MS = 30000;
const MAX_GRAPH_SKIP = 1000000;

/** Reject malformed scalars before the command layer validates git semantics. */
function stringArgument(value, name, optional = false) {
  if (optional && value === undefined) return undefined;
  if (typeof value !== 'string' || value === '' || value.includes('\u0000')) {
    throw new GitError('request/invalid-argument', `${name} must be a nonempty string without NUL bytes`);
  }
  return value;
}

function commitHash(value) {
  if (typeof value !== 'string' || !/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(value)) {
    throw new GitError('request/invalid-argument', 'hash must be a full commit object ID');
  }
  return value;
}

/** Historic names are literal repository paths, not current filesystem entries. */
function historicPath(value) {
  stringArgument(value, 'path');
  if (isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\') ||
      value.split(/[\\/]/).some((part) => part === '' || part === '.' || part === '..') ||
      value.split(/[\\/]/)[0] === '.git') {
    throw new GitError('path/invalid', 'path must name a file within the historic repository');
  }
  return value;
}

function checkSignal(signal) {
  if (signal?.aborted) throw new GitError('git/aborted', 'the repository operation was aborted');
}

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
    /** Canonical root -> {running, jobs}; only this service's mutations serialize. */
    this.mutationQueues = new Map();
    /** Read-only public GitHub API; never supplied with host credentials. */
    this.github = createGitHubReader({ authFor: createGitHubAuthorization(config.githubAuth ?? { repositories: [], allowWrites: false }) });
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
   * required. An explicit `repo` wins when both are present, which is why it must
   * never publish its result under the Session identity: the next Session-only
   * request would then address a repository that belongs to nobody's Session.
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
    const explicit = typeof request.repo === 'string' && request.repo !== '';
    // Only a request actually resolved through the Session may populate or read
    // the Session cache, and the cached fact is bound to the cwd it was
    // resolved for so a changed working directory cannot reuse a stale root.
    // `sessionCwd` still owns the selector errors (`session/required`,
    // `session/unknown`, `session/no-workspace`) for a request that names no
    // repository.
    let sessionCwd = null;
    let cwd;
    if (explicit) {
      cwd = request.repo;
    } else {
      sessionCwd = this.sessionCwd(request.sessionId);
      cwd = sessionCwd;
      const cached = this.repositories.get(request.sessionId);
      if (cached !== undefined && cached.cwd === cwd && Date.now() - cached.at < REPOSITORY_CACHE_TTL_MS) {
        if (cached.value === null) {
          throw new GitError('repo/not-a-repository', `${cwd} is not inside a Git repository`, { path: cwd });
        }
        return { ...cached.value, cwd, git: runner, cwdLabel: cwd };
      }
    }
    const repository = await this.repositoryForCwd(cwd, request.signal);
    if (sessionCwd !== null) {
      this.repositories.set(request.sessionId, { at: Date.now(), cwd: sessionCwd, value: repository });
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
   * This is the single choke point for current worktree path authority. Historic
   * commit paths instead use lexical validation and the git layer's membership
   * check, because those files need not exist in the current worktree.
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

  /**
   * Resolve context once, then serialize all mutations of its real root.
   * Pending cancellation rejects promptly and removes its job/listener; failures
   * never poison the next job. Different roots continue independently.
   */
  async mutate(request, operation) {
    checkSignal(request.signal);
    const context = await this.context(request);
    const root = await realpath(context.root);
    checkSignal(request.signal);
    let queue = this.mutationQueues.get(root);
    if (queue === undefined) {
      queue = { running: false, jobs: [] };
      this.mutationQueues.set(root, queue);
    }
    return new Promise((resolve, reject) => {
      const job = { operation: () => operation({ ...context, root }), signal: request.signal, resolve, reject, abort: null };
      job.abort = () => {
        const index = queue.jobs.indexOf(job);
        if (index === -1) return;
        queue.jobs.splice(index, 1);
        job.signal.removeEventListener('abort', job.abort);
        reject(new GitError('git/aborted', 'the queued repository operation was aborted'));
        if (!queue.running && queue.jobs.length === 0) this.mutationQueues.delete(root);
      };
      queue.jobs.push(job);
      job.signal?.addEventListener('abort', job.abort, { once: true });
      if (job.signal?.aborted) job.abort();
      this.drainMutations(root, queue);
    });
  }

  /** Execute one queued job; the settled promise cannot retain an idle queue. */
  drainMutations(root, queue) {
    if (queue.running) return;
    const job = queue.jobs.shift();
    if (job === undefined) {
      if (this.mutationQueues.get(root) === queue) this.mutationQueues.delete(root);
      return;
    }
    queue.running = true;
    job.signal?.removeEventListener('abort', job.abort);
    Promise.resolve().then(() => {
      checkSignal(job.signal);
      return job.operation();
    }).then((value) => {
      queue.running = false;
      this.drainMutations(root, queue);
      job.resolve(value);
    }, (error) => {
      queue.running = false;
      this.drainMutations(root, queue);
      job.reject(error);
    });
  }

  // -------------------------------------------------------------------------
  // The operation set, as one API with two callers.
  //
  // The HTTP routes and the agent tool both call THESE methods, so an operation
  // has exactly one implementation and the two callers cannot drift. Each takes
  // the same request shape the routes receive: a `sessionId` or an explicit
  // `repo`, plus its own arguments. Current worktree paths pass through
  // {@link withPaths}; historic reads additionally require commit membership.
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
    return this.mutate(request, async ({ root }) => {
      const paths = await this.withPaths(root, request.paths);
      checkSignal(request.signal);
      return this.operations.stage({ root, paths, signal: request.signal });
    });
  }

  /**
   * Unstage paths, leaving the working tree untouched.
   * @param {object} request - `{sessionId, repo, paths, signal}`.
   * @returns {Promise<object>} `{paths, unstaged, alreadyUnstaged}`.
   */
  async unstage(request) {
    return this.mutate(request, async ({ root }) => {
      const paths = await this.withPaths(root, request.paths);
      checkSignal(request.signal);
      return this.operations.unstage({ root, paths, signal: request.signal });
    });
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
    return this.mutate(request, async ({ root }) => {
      const paths = await this.withPaths(root, request.paths);
      checkSignal(request.signal);
      return this.operations.discard({ root, paths, signal: request.signal });
    });
  }

  /**
   * Stage one hunk of a path's unstaged change.
   * @param {object} request - `{sessionId, repo, path, hunkIndex, signal}`.
   * @returns {Promise<object>} `{path, hunkIndex, total}`.
   */
  async stageHunk(request) {
    return this.mutate(request, async ({ root }) => {
      const [path] = await this.withPaths(root, [request.path], { limit: 1 });
      checkSignal(request.signal);
      return this.operations.stageHunk({ root, path, hunkIndex: request.hunkIndex, signal: request.signal });
    });
  }

  /**
   * Unstage one hunk of a path's staged change.
   * @param {object} request - `{sessionId, repo, path, hunkIndex, signal}`.
   * @returns {Promise<object>} `{path, hunkIndex, total}`.
   */
  async unstageHunk(request) {
    return this.mutate(request, async ({ root }) => {
      const [path] = await this.withPaths(root, [request.path], { limit: 1 });
      checkSignal(request.signal);
      return this.operations.unstageHunk({ root, path, hunkIndex: request.hunkIndex, signal: request.signal });
    });
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
    return this.mutate(request, async ({ root }) => {
      const [path] = await this.withPaths(root, [request.path], { limit: 1 });
      checkSignal(request.signal);
      return this.operations.discardHunk({ root, path, hunkIndex: request.hunkIndex, signal: request.signal });
    });
  }

  /**
   * Commit the staged index.
   * @param {object} request - `{sessionId, repo, message, signal}`.
   * @returns {Promise<object>} `{hash, short, subject}`.
   */
  async commit(request) {
    return this.mutate(request, ({ root }) =>
      this.operations.commit({ root, message: request.message, signal: request.signal }));
  }

  /** Local and cached remote refs; never initiates network traffic. */
  async branches(request) {
    const { root } = await this.context(request);
    return this.operations.branches({ root, signal: request.signal });
  }

  /** A bounded page of local history and ref decorations. */
  async graph(request) {
    const skip = request.skip === undefined ? 0 : request.skip;
    if (!Number.isSafeInteger(skip) || skip < 0 || skip > MAX_GRAPH_SKIP) {
      throw new GitError('request/invalid-argument', `skip must be an integer from 0 to ${MAX_GRAPH_SKIP}`);
    }
    const { root } = await this.context(request);
    return this.operations.graph({ root, skip, signal: request.signal });
  }

  async commitDetails(request) {
    const hash = commitHash(request.hash);
    const { root } = await this.context(request);
    return this.operations.commitDetails({ root, hash, signal: request.signal });
  }

  async commitDiff(request) {
    const hash = commitHash(request.hash);
    const path = historicPath(request.path);
    const { root } = await this.context(request);
    return this.operations.commitDiff({ root, hash, path, signal: request.signal });
  }

  /** Public GitHub metadata is scoped to an already-configured Git remote. */
  async githubTarget(request) {
    const context = await this.context(request);
    const branchData = await this.operations.branches({ root: context.root, signal: request.signal });
    const chosen = branchData.remotes.find((remote) => remote.name === 'origin' && remote.github)
      ?? branchData.remotes.find((remote) => remote.github);
    if (!chosen) throw new GitHubReadError('github/not-configured', 'This repository has no recognized, credential-free GitHub remote.');
    return chosen.github;
  }

  async githubPulls(request) {
    const github = await this.githubTarget(request);
    return { github, capabilities: this.github.capabilities(github), ...await this.github.pulls(github, { state: request.state, signal: request.signal }) };
  }

  async githubPullDetail(request) {
    const github = await this.githubTarget(request);
    return { github, ...await this.github.pullDetail(github, { number: request.number, signal: request.signal }) };
  }

  async githubPullDiscussion(request) {
    const github = await this.githubTarget(request);
    return { github, ...await this.github.pullDiscussion(github, { number: request.number, signal: request.signal }) };
  }

  async githubIssues(request) {
    const github = await this.githubTarget(request);
    return { github, ...await this.github.issues(github, { state: request.state, signal: request.signal }) };
  }

  /** Explicit user-confirmed PR creation; no agent tool and no Git transport. */
  async githubCreatePull(request) {
    return this.mutate(request, async ({ root }) => {
      const branchData = await this.operations.branches({ root, signal: request.signal });
      const remote = branchData.remotes.find((row) => row.name === 'origin' && row.github)
        ?? branchData.remotes.find((row) => row.github);
      if (!remote) throw new GitHubReadError('github/not-configured', 'No recognized GitHub remote was found.');
      const source = branchData.local.find((row) => row.current);
      if (!source || source.upstreamTarget?.remote !== remote.name) {
        throw new GitHubReadError('github/no-pushed-branch', 'Push the current branch to the selected GitHub remote and set its upstream first.');
      }
      const tracked = branchData.remote.find((row) => row.remote === remote.name && row.branch === source.upstreamTarget.branch);
      if (!tracked || tracked.hash !== source.hash) {
        throw new GitHubReadError('github/no-pushed-branch', 'Your local branch differs from the remote-tracking branch; push or fetch and review it before creating a PR.');
      }
      const target = branchData.remote.find((row) => row.remote === remote.name && row.branch === request.base);
      if (!target) throw new GitHubReadError('github/invalid-base', 'Choose an existing remote-tracking target branch.');
      return {
        ...await this.github.createPull(remote.github, {
          head: source.upstreamTarget.branch,
          base: request.base,
          title: request.title,
          body: request.body,
          draft: request.draft,
          confirmed: request.confirmed,
          signal: request.signal,
        }),
        github: remote.github,
      };
    });
  }

  async switchBranch(request) {
    return this.mutate(request, ({ root }) => this.operations.switchBranch({
      root,
      branch: stringArgument(request.branch, 'branch'),
      remoteBranch: stringArgument(request.remoteBranch, 'remoteBranch', true),
      signal: request.signal,
    }));
  }

  async createBranch(request) {
    return this.mutate(request, ({ root }) => this.operations.createBranch({
      root, branch: stringArgument(request.branch, 'branch'), signal: request.signal,
    }));
  }

  /** Explicit user-triggered network operations; not exposed by the agent tool. */
  async fetch(request) {
    return this.mutate(request, ({ root }) => this.operations.fetch({
      root, remote: stringArgument(request.remote, 'remote'), signal: request.signal,
    }));
  }

  async pull(request) {
    return this.mutate(request, ({ root }) => this.operations.pull({
      root,
      remote: stringArgument(request.remote, 'remote', true),
      branch: stringArgument(request.branch, 'branch', true),
      sourceBranch: stringArgument(request.sourceBranch, 'sourceBranch'),
      signal: request.signal,
    }));
  }

  async push(request) {
    return this.mutate(request, ({ root }) => {
      if (request.setUpstream !== undefined && typeof request.setUpstream !== 'boolean') {
        throw new GitError('request/invalid-argument', 'setUpstream must be a boolean');
      }
      return this.operations.push({
        root,
        remote: stringArgument(request.remote, 'remote', true),
        branch: stringArgument(request.branch, 'branch', true),
        sourceBranch: stringArgument(request.sourceBranch, 'sourceBranch'),
        setUpstream: request.setUpstream ?? false,
        signal: request.signal,
      });
    });
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
