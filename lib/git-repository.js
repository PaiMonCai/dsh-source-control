import { githubRemote } from './github-remote.js';

/** Approved repository reads and narrowly constrained branch/transport mutations.
 * Inputs are argv only. Historic paths are selected from Git metadata, not the
 * current filesystem. Transport errors deliberately omit Git's URL-bearing text.
 */
export function createRepositoryOperations(git, config, { GitError, parseDiff, splitNul, status, head }) {
  // `immutable` is a per-read intention (no `refs/replace`, no lazy fetch), so
  // it must survive this mapping rather than being dropped with the extra keys.
  const options = ({ root, signal, immutable }) => ({ cwd: root, signal, ...(immutable === true ? { immutable: true } : {}) });
  const fail = (code, message) => { throw new GitError(`git/${code}`, message); };
  const text = (result) => result.stdout.replace(/\n$/, '');

  async function validateBranch(io, branch) {
    if (typeof branch !== 'string' || !branch || /^[+\-]/.test(branch) || branch.startsWith('refs/') || /[:\s\u0000-\u001f\u007f]/u.test(branch)) {
      fail('invalid-branch', 'a safe branch name is required, not an option, URL, or refspec');
    }
    const result = await git.run(['check-ref-format', '--branch', branch], options(io));
    if (result.exitCode !== 0 || text(result) !== branch) fail('invalid-branch', 'the branch name is invalid');
    return branch;
  }

  async function remoteNames(io) {
    const result = await git.ok(['remote'], options(io), 'list remote names');
    const names = result.stdout.split('\n').filter(Boolean);
    const configured = [];
    for (const name of names) {
      // `git remote` can list an empty section. It is not a usable endpoint.
      const urls = await git.run(['config', '--get-all', `remote.${name}.url`], options(io));
      const pushUrls = await git.run(['config', '--get-all', `remote.${name}.pushurl`], options(io));
      if ([urls, pushUrls].some((value) => value.exitCode === 0 && value.stdout.split('\n').some((url) => url.trim()))) configured.push(name);
    }
    return configured;
  }

  async function validateRemote(io, remote, push = false) {
    if (typeof remote !== 'string' || !remote || /^[+\-]/.test(remote) || /[:\s\u0000-\u001f\u007f]/u.test(remote)) {
      fail('invalid-remote', 'a configured remote name is required, not an option or URL');
    }
    const valid = await git.run(['check-ref-format', `refs/remotes/${remote}/endpoint`], options(io));
    if (valid.exitCode !== 0 || !(await remoteNames(io)).includes(remote)) fail('invalid-remote', 'the remote is not configured');
    const urls = await git.run(['config', '--get-all', `remote.${remote}.${push ? 'pushurl' : 'url'}`], options(io));
    if (push && (urls.exitCode !== 0 || !urls.stdout.trim())) {
      const fetchUrls = await git.run(['config', '--get-all', `remote.${remote}.url`], options(io));
      if (fetchUrls.exitCode !== 0 || !fetchUrls.stdout.trim()) fail('invalid-remote', 'the remote has no configured push URL');
    } else if (urls.exitCode !== 0 || !urls.stdout.trim()) fail('invalid-remote', 'the remote has no configured URL');
    return remote;
  }

  async function refs(io) {
    const format = ['%(refname)', '%(objectname)', '%(symref)', '%(upstream:short)', '%(upstream:remotename)', '%(upstream:remoteref)'].join('%00');
    const result = await git.ok(['for-each-ref', `--format=${format}`, 'refs/heads/', 'refs/remotes/', 'refs/tags/'], options(io), 'read repository refs');
    return result.stdout.split('\n').filter(Boolean).map((line) => {
      const [ref, hash, symbolic, upstream, upstreamRemote, upstreamRef] = line.split('\u0000');
      return { ref, hash, symbolic, upstream, upstreamRemote, upstreamRef };
    });
  }

  /**
   * The remote branch a local branch actually tracks, as STRUCTURED data.
   *
   * The display name (`%(upstream:short)`) is abbreviated and may be ambiguous
   * when two remotes share a last path segment; it also stays non-null when the
   * tracking ref happens to be missing. This pair is the canonical target for a
   * pull/push dialog, and the single place the "is this a usable remote
   * upstream" rule lives — `branches()` and `target()` both use it.
   *
   * @param {object} row - one `for-each-ref` row.
   * @returns {{remote: string, branch: string}|null} the target, or null when
   *   the branch has no remote upstream (including a `.` local upstream).
   */
  function remoteUpstreamTarget(row) {
    if (typeof row.upstreamRemote !== 'string' || row.upstreamRemote === '' || row.upstreamRemote === '.') return null;
    if (typeof row.upstreamRef !== 'string' || !row.upstreamRef.startsWith('refs/heads/')) return null;
    const branch = row.upstreamRef.slice(11);
    return branch === '' ? null : { remote: row.upstreamRemote, branch };
  }

  async function branches(io) {
    const currentHead = await head(io);
    const names = await remoteNames(io);
    const local = [];
    const remote = [];
    for (const row of await refs(io)) {
      if (row.ref.startsWith('refs/heads/')) {
        const name = row.ref.slice(11);
        local.push({
          name,
          ref: row.ref,
          hash: row.hash,
          current: name === currentHead.branch,
          // Display name, kept for compatibility; not a reliable target.
          upstream: row.upstream || null,
          // Canonical structured target, independent of whether the local
          // remote-tracking ref currently exists.
          upstreamTarget: remoteUpstreamTarget(row),
        });
      } else if (row.ref.startsWith('refs/remotes/') && !row.symbolic) {
        const name = row.ref.slice(13);
        const owner = names.filter((candidate) => name.startsWith(`${candidate}/`)).sort((a, b) => b.length - a.length)[0] ?? name.split('/')[0];
        remote.push({ name, ref: row.ref, hash: row.hash, remote: owner, branch: name.slice(owner.length + 1) });
      }
    }
    // Only share credential-free, normalized GitHub navigation URLs. A remote
    // configured with a custom host, URL credentials or path escapes remains
    // present as a name, but does not become a browser link.
    const remotes = [];
    for (const name of names) {
      const configured = await git.run(['config', '--get', `remote.${name}.url`], options(io));
      const github = configured.exitCode === 0 ? githubRemote(text(configured)) : null;
      remotes.push(github ? { name, github } : { name });
    }
    return { current: currentHead.branch, head: currentHead.head, local, remote, remotes };
  }

  async function graph({ root, skip = 0, signal }) {
    const io = { root, signal };
    if (!Number.isSafeInteger(skip) || skip < 0) fail('invalid-pagination', 'skip must be a non-negative safe integer');
    // Reads are immutable: `refs/replace` must not rewrite the history a user
    // is inspecting, and a partial clone must not fetch to answer a local read.
    const immutable = { ...io, immutable: true };
    const currentHead = await head(immutable);
    const decorations = new Map();
    const decorate = (hash, ref) => {
      if (!decorations.has(hash)) decorations.set(hash, []);
      decorations.get(hash).push(ref);
    };
    for (const row of await refs(immutable)) {
      if (row.symbolic) continue;
      if (row.ref.startsWith('refs/heads/')) decorate(row.hash, { name: row.ref.slice(11), kind: 'local' });
      else if (row.ref.startsWith('refs/remotes/')) decorate(row.hash, { name: row.ref.slice(13), kind: 'remote' });
      else if (row.ref.startsWith('refs/tags/')) {
        const peeled = await git.run(['rev-parse', '--verify', `${row.ref}^{commit}`], options(immutable));
        if (peeled.exitCode === 0) decorate(text(peeled), { name: row.ref.slice(10), kind: 'tag' });
      }
    }
    if (currentHead.head) decorate(currentHead.head, { name: 'HEAD', kind: 'head' });
    const format = ['%H', '%h', '%P', '%an', '%aI', '%s'].join('%x00');
    // `--no-show-signature`: with `log.showSignature=true`, Git writes the
    // signature program's diagnostics to stdout BEFORE `%H`, which would become
    // part of the parsed hash. Machine parsing needs that display disabled.
    // The walk names its starting points explicitly instead of using `--all`.
    // `--all` also walks `refs/replace/*` and `refs/stash`: the first appends a
    // phantom commit for the replacement object, and the second leaks stashed
    // work into the history view. Branches, remotes, tags and HEAD are the refs
    // this view decorates, so they are exactly the refs it walks.
    const result = await git.ok(['log', '--no-show-signature', '--branches', '--remotes', '--tags', ...(currentHead.head ? ['HEAD'] : []), '--topo-order', '--no-color', '--no-decorate', '-z', `--max-count=${config.maxLogEntries + 1}`, `--skip=${skip}`, `--format=${format}`, '--'], options(immutable), 'read commit graph');
    const fields = splitNul(result.stdout);
    const commits = [];
    for (let at = 0; at < fields.length; at += 6) {
      const [hash, short, parents, author, date, subject] = fields.slice(at, at + 6);
      commits.push({ hash, short, parents: parents ? parents.split(' ') : [], author, date, subject, refs: decorations.get(hash) ?? [] });
    }
    return { commits: commits.slice(0, config.maxLogEntries), hasMore: commits.length > config.maxLogEntries };
  }

  /**
   * Resolve an exact full object ID to the commit it names.
   *
   * The input must already LOOK like a full object ID (40 or 64 hex digits), but
   * Git resolves any unambiguous abbreviation: in a SHA-256 repository the first
   * 40 characters of a 64-character ID is a legal abbreviation. Requiring the
   * resolved ID to equal the request keeps "exact object ID" an honest promise
   * for both object formats, and the raw object type is read with replacement
   * objects disabled so a `refs/replace` entry cannot disguise a blob as a
   * commit (or an old root commit as a descendant).
   *
   * @param {object} io - `{root, signal}`.
   * @param {string} hash - the requested full object ID.
   * @returns {Promise<string>} the resolved full object ID.
   */
  async function resolveCommitId(io, hash) {
    if (typeof hash !== 'string' || !/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(hash)) fail('invalid-hash', 'an exact full commit object ID is required');
    const immutable = { ...io, immutable: true };
    const resolved = await git.run(['rev-parse', '--verify', '--quiet', `${hash}^{object}`], options(immutable));
    const id = text(resolved);
    if (resolved.exitCode !== 0 || id.toLowerCase() !== hash.toLowerCase()) fail('invalid-hash', 'the object ID is not an exact full object ID in this repository');
    const type = await git.run(['cat-file', '-t', id], options(immutable));
    if (type.exitCode !== 0 || text(type) !== 'commit') fail('invalid-hash', 'the object ID does not identify a commit');
    return id;
  }

  async function commitDetails({ root, hash, signal }) {
    const io = { root, signal };
    const id = await resolveCommitId(io, hash);
    const immutable = { ...io, immutable: true };
    const format = ['%H', '%h', '%P', '%an', '%aI', '%s', '%B'].join('%x00');
    const shown = await git.ok(['show', '--no-show-signature', '--no-patch', '--no-color', '--no-decorate', `--format=${format}`, id, '--'], options(immutable), 'read commit details');
    const [shownId, short, parentText, author, date, subject, message] = shown.stdout.split('\u0000');
    const parents = parentText ? parentText.split(' ') : [];
    const commit = { hash: shownId, short, parents, author, date, subject, message: message.replace(/\n$/, '') };
    const changed = await git.ok(['diff-tree', '--no-commit-id', '--root', '-r', '-M', '--name-status', '-z', ...(parents.length ? [parents[0], shownId] : [shownId]), '--'], options(immutable), 'read commit files');
    const tokens = splitNul(changed.stdout);
    const files = [];
    for (let at = 0; at < tokens.length;) {
      const state = tokens[at++];
      const first = tokens[at++];
      const renamed = /^[RC]/.test(state);
      files.push({ path: renamed ? tokens[at++] : first, status: state, oldPath: renamed ? first : null });
    }
    return { commit, files };
  }

  async function commitDiff({ root, hash, path, signal }) {
    const details = await commitDetails({ root, hash, signal });
    const selected = details.files.find((file) => file.path === path || file.oldPath === path);
    if (typeof path !== 'string' || !selected) fail('invalid-path', 'the historic path is not listed in this commit');
    const { commit } = details;
    const result = await git.ok(['diff-tree', '--no-commit-id', '--root', '-r', '-M', '-p', '--no-color', '--no-ext-diff', '--no-textconv', ...(commit.parents.length ? [commit.parents[0], commit.hash] : [commit.hash]), '--', selected.path, ...(selected.oldPath ? [selected.oldPath] : [])], options({ root, signal, immutable: true }), 'read historic diff');
    const parsed = parseDiff(result.stdout);
    const lines = parsed.hunks.reduce((count, hunk) => count + hunk.lines.length, 0);
    if (lines > config.maxDiffLines) fail('diff-too-large', `historic diff exceeds the ${config.maxDiffLines}-line limit`);
    return { path, staged: false, untracked: false, ...parsed };
  }

  async function clean(io) {
    const state = await status(io);
    if (state.staged.length || state.changes.length || state.untracked.length || state.conflicted.length) fail('dirty-tree', 'a clean working tree and index are required (including untracked files)');
    return state;
  }

  async function current(io, requireClean = false) {
    const state = requireClean ? await clean(io) : await status(io);
    if (!state.branch || !state.oid) fail('not-on-branch', 'a current local branch with a commit is required');
    return state;
  }

  async function switchBranch({ root, branch, remoteBranch, signal }) {
    const io = { root, signal };
    await validateBranch(io, branch);
    await clean(io);
    const metadata = await branches(io);
    if (remoteBranch !== undefined) {
      if (typeof remoteBranch !== 'string') fail('unknown-branch', 'a known remote branch is required');
      const selected = metadata.remote.find((row) => row.name === remoteBranch);
      if (!selected) fail('unknown-branch', 'the remote branch is not known in this repository');
      if (metadata.local.some((row) => row.name === branch)) fail('invalid-branch', 'the requested local branch already exists');
      await git.ok(['switch', '--no-guess', '--track', '-c', branch, selected.ref, '--'], options(io), 'switch to tracking branch');
    } else {
      const selected = metadata.local.find((row) => row.name === branch);
      if (!selected) fail('unknown-branch', 'the local branch is not known in this repository');
      await git.ok(['switch', '--no-guess', branch, '--'], options(io), 'switch local branch');
    }
    return { branch };
  }

  async function createBranch({ root, branch, signal }) {
    const io = { root, signal };
    await validateBranch(io, branch);
    await current(io, true);
    await git.ok(['switch', '--no-guess', '--no-track', '-c', branch, 'HEAD', '--'], options(io), 'create local branch');
    return { branch };
  }

  async function target(io, sourceBranch, remote, branch, setUpstream = false, push = false) {
    // Intent is captured when the confirmation opens, not reinterpreted after a
    // queued switch. Never infer a missing source from the current branch.
    await validateBranch(io, sourceBranch);
    const state = await current(io, !push);
    if (state.branch !== sourceBranch) fail('source-branch-changed', 'the current branch changed; reopen the confirmation before retrying');
    const local = (await refs(io)).find((row) => row.ref === `refs/heads/${state.branch}`);
    // One rule, shared with `branches()`: only a real remote `refs/heads/*`
    // upstream counts. A `.` local upstream is not a remote target.
    const upstream = local === undefined ? null : remoteUpstreamTarget(local);
    if (upstream === null && (remote === undefined || branch === undefined || (push && !setUpstream))) fail('missing-upstream', push ? 'without an upstream, supply remote and branch and setUpstream=true' : 'without an upstream, supply both remote and branch');
    remote = remote ?? upstream?.remote;
    branch = branch ?? upstream?.branch;
    await validateRemote(io, remote, push);
    await validateBranch(io, branch);
    return { remote, branch, current: state.branch };
  }

  async function transport(io, remote, push, argv, description) {
    // get-url resolves insteadOf/pushInsteadOf locally; no endpoint is returned
    // to callers. Inspect the actual selected transport, not its URL alias.
    const urls = await git.run(['remote', 'get-url', '--all', ...(push ? ['--push'] : []), '--', remote], options(io));
    if (urls.exitCode !== 0 || !urls.stdout.trim()) fail('invalid-remote', 'the configured remote has no usable endpoint');
    if (urls.stdout.split('\n').some((url) => /^(?:ssh|git\+ssh|ssh\+git):\/\//i.test(url) || (!url.includes('://') && /^[^/]+:/.test(url)))) {
      const custom = await git.run(['config', '--get', 'core.sshCommand'], options(io));
      // Arbitrary shell commands/wrappers cannot safely be rewritten to add
      // OpenSSH options. Refuse instead of silently replacing an identity or
      // allowing a terminal prompt. Standard ~/.ssh/config and agents are kept.
      if (custom.stdout.trim() || process.env.GIT_SSH_COMMAND || process.env.GIT_SSH) {
        fail('unsupported-ssh-command', 'custom SSH commands cannot guarantee batch authentication; configure host keys and identities in the host SSH config instead');
      }
    }
    const result = await git.run(['-c', 'protocol.ext.allow=never', ...argv], { ...options(io), transportBatchMode: true });
    if (result.exitCode === 0) return;
    // Classify only the bounded diagnostic tail. Return fixed text, never URLs,
    // credentials, helper output, or credential configuration from stderr.
    const diagnostic = `${result.stderr ?? ''}\n${result.stdout ?? ''}`.slice(-32768);
    let code = 'failed';
    let advice = 'check the configured remote, host credentials, and repository state';
    if (/host key verification failed|remote host identification has changed/i.test(diagnostic)) {
      code = 'host-key'; advice = 'verify the remote host key in the host SSH known_hosts configuration; host-key checking was not disabled';
    } else if (/authentication failed|permission denied|could not read (?:username|password)|terminal prompts disabled|invalid username or password|access denied|http (?:401|403)|returned error: (?:401|403)/i.test(diagnostic)) {
      code = 'authentication'; advice = 'configure host credentials or an unlocked SSH key/agent; interactive authentication is disabled';
    } else if (/non-fast-forward|fetch first|not possible to fast-forward|cannot fast-forward/i.test(diagnostic)) {
      code = 'non-fast-forward'; advice = 'local and remote histories require reconciliation outside this panel; no force push or merge was attempted';
    } else if (/could not resolve host|could not resolve hostname|name or service not known|connection refused|connection timed out|unable to access/i.test(diagnostic)) {
      code = 'connection'; advice = 'check host connectivity and the configured remote endpoint';
    }
    throw new GitError(`git/${code}`, `${description} failed (exit ${result.exitCode}); ${advice}`, { exitCode: result.exitCode });
  }

  async function fetch({ root, remote, signal }) {
    const io = { root, signal };
    await validateRemote(io, remote);
    await transport(io, remote, false, ['fetch', '--no-recurse-submodules', '--', remote], 'git fetch');
    return { remote };
  }

  async function pull({ root, sourceBranch, remote, branch, signal }) {
    const io = { root, signal };
    const selected = await target(io, sourceBranch, remote, branch);
    await transport(io, selected.remote, false, ['pull', '--ff-only', '--no-rebase', '--no-autostash', '--no-recurse-submodules', '--', selected.remote, selected.branch], 'git pull');
    return { remote: selected.remote, branch: selected.branch };
  }

  async function push({ root, sourceBranch, remote, branch, setUpstream = false, signal }) {
    const io = { root, signal };
    if (typeof setUpstream !== 'boolean') fail('invalid-boolean', 'setUpstream must be a boolean');
    const selected = await target(io, sourceBranch, remote, branch, setUpstream, true);
    await transport(io, selected.remote, true, ['-c', `remote.${selected.remote}.mirror=false`, '-c', 'push.followTags=false', '-c', 'push.default=nothing', '-c', 'push.autoSetupRemote=false', 'push', '--porcelain', '--no-force', '--no-mirror', '--no-prune', '--no-follow-tags', '--recurse-submodules=no', ...(setUpstream ? ['--set-upstream'] : []), '--', selected.remote, `refs/heads/${sourceBranch}:refs/heads/${selected.branch}`], 'git push');
    return { remote: selected.remote, branch: selected.branch };
  }

  return { branches, graph, commitDetails, commitDiff, switchBranch, createBranch, fetch, pull, push };
}
