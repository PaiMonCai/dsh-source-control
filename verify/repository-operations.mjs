/** Standalone repository command verification. All transport is local or spied;
 * user-repository state and real networks are never touched. */
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { GitError, GitRunner, createOperations, redactDiagnostic } from '../lib/git.js';

let checks = 0;
let failures = 0;
function check(value, label, detail) {
  checks++;
  if (value) console.log(`ok   ${label}`);
  else { failures++; console.log(`FAIL ${label}${detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`); }
}
async function rejects(run, code, label) {
  try { await run(); check(false, label, `resolved; expected ${code}`); }
  catch (error) { check(error instanceof GitError && error.code === code, label, { code: error.code, message: error.message }); return error; }
}
const specs = [];
const adapter = {
  spawn(spec) {
    specs.push(spec);
    const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env: { ...process.env, ...spec.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end(typeof spec.stdio.stdin === 'object' ? spec.stdio.stdin.data : undefined);
    let stdout = '', stderr = '', lossy = false;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > spec.stdio.stdout.maxBytes) { stdout = stdout.slice(0, spec.stdio.stdout.maxBytes); lossy = true; }
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-spec.stdio.stderr.maxBytes); });
    const abort = () => child.kill('SIGTERM');
    if (spec.signal.aborted) abort(); else spec.signal.addEventListener('abort', abort, { once: true });
    return {
      done: new Promise((res, rej) => {
        child.on('error', rej);
        child.on('close', (exitCode, signal) => { spec.signal.removeEventListener('abort', abort); res({ exitCode, signal }); });
      }),
      collected: { stdout: { readFrom: () => ({ text: stdout, lossy }) }, stderr: { readFrom: () => ({ text: stderr }) } },
    };
  },
};
const scratch = await realpath(await mkdtemp(join(tmpdir(), 'dsh-repository-operations-')));
const origin = join(scratch, 'origin.git');
const repo = join(scratch, 'one');
const peer = join(scratch, 'two');
const limits = { timeoutMs: 30000, maxOutputBytes: 8 * 1024 * 1024 };
const config = { ...limits, maxDiffLines: 20000, maxLogEntries: 50 };
const runner = new GitRunner(adapter, 'git', limits);
const ops = createOperations(runner, config);
const io = { root: repo };
async function raw(root, ...argv) { return (await runner.ok(argv, { cwd: root })).stdout.replace(/\n$/, ''); }
/** Fixture scaffolding that genuinely moves objects, through real Git transport.
 * The production runner only reaches a network when a caller asks for transport
 * explicitly, which is exactly what this flag means. */
async function seeding(root, ...argv) { return (await runner.ok(argv, { cwd: root, transportBatchMode: true })).stdout.replace(/\n$/, ''); }
async function commit(root, message) { await raw(root, 'add', '-A'); await raw(root, 'commit', '-qm', message); return raw(root, 'rev-parse', 'HEAD'); }
async function put(root, path, body) { await writeFile(join(root, path), body); }
async function pristine() { await raw(repo, 'reset', '--hard', 'HEAD'); await raw(repo, 'clean', '-fd'); }
async function refs(root) { return raw(root, 'for-each-ref', '--format=%(refname) %(objectname)'); }
const transportCommands = new Set(['fetch', 'pull', 'push']);
function spyOperations(diagnostic, extra = {}) {
  const calls = [];
  const proxy = {
    async run(argv, options) {
      if (argv.some((value) => transportCommands.has(value))) { calls.push({ argv, options }); return { exitCode: 1, stdout: '', stderr: diagnostic, ...extra }; }
      return runner.run(argv, options);
    },
    async ok(argv, options, what) { return runner.ok(argv, options, what); },
  };
  return { calls, operations: createOperations(proxy, config) };
}
try {
  console.log(`# local scratch: ${scratch}`);
  await mkdir(repo);
  await raw(scratch, 'init', '--bare', '-q', origin);
  await raw(repo, 'init', '-q', '-b', 'main');
  for (const root of [repo]) { await raw(root, 'config', 'user.name', 'Verify'); await raw(root, 'config', 'user.email', 'verify@example.invalid'); }
  await put(repo, 'kept.txt', 'base\n');
  await put(repo, 'old.txt', 'rename this unchanged content\n');
  await put(repo, 'delete.txt', 'historic deleted content\n');
  await put(repo, 'literal[1].txt', 'literal root\n');
  const rootHash = await commit(repo, 'root subject\n\nroot body');
  await raw(repo, 'remote', 'add', 'origin', origin);
  await seeding(repo, 'push', '-q', '-u', 'origin', 'main');
  await raw(origin, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  await seeding(scratch, 'clone', '-q', origin, peer);
  await raw(peer, 'config', 'user.name', 'Peer'); await raw(peer, 'config', 'user.email', 'peer@example.invalid');

  console.log('\n## branch metadata, validation and dirty safety');
  const initial = await ops.branches(io);
  check(initial.current === 'main' && initial.local[0].upstream === 'origin/main', 'local branch/current/upstream metadata is real');
  check(initial.remote.some((row) => row.name === 'origin/main') && !initial.remote.some((row) => row.name === 'origin/HEAD'), 'remote symbolic HEAD is not a selectable branch');
  check(JSON.stringify(initial.remotes) === '[{"name":"origin"}]' && !JSON.stringify(initial).includes(origin), 'remote metadata exposes names, not endpoints');
  // A GitHub fetch remote exposes canonical navigation only, never raw tokens
  // or credentials; restore the bare local remote before transport tests.
  await raw(repo, 'config', 'remote.origin.url', 'git@github.com:PaiMonCai/dsh-source-control.git');
  const hosted = await ops.branches(io);
  check(hosted.remotes[0].github?.pullsUrl === 'https://github.com/PaiMonCai/dsh-source-control/pulls', 'GitHub PR navigation derived from SSH remote');
  await raw(repo, 'config', 'remote.origin.url', 'https://token@github.com/PaiMonCai/dsh-source-control.git');
  const withSecret = await ops.branches(io);
  check(withSecret.remotes[0].github === undefined && !JSON.stringify(withSecret).includes('token'), 'credential-bearing GitHub remote never reaches browser');
  await raw(repo, 'config', 'remote.origin.url', origin);
  await ops.createBranch({ ...io, branch: 'topic/国际' });
  check((await ops.head(io)).branch === 'topic/国际', 'create switches to Unicode/slash branch');
  check((await ops.branches(io)).local.find((row) => row.name === 'topic/国际').upstream === null, 'local creation does not silently assign an upstream');
  await ops.switchBranch({ ...io, branch: 'main' });
  for (const branch of ['--force', '+main', 'main:evil', 'refs/heads/main', 'https://bad', 'bad name', '..', '', 12, null]) {
    await rejects(() => ops.createBranch({ ...io, branch }), 'git/invalid-branch', `unsafe branch refused: ${JSON.stringify(branch)}`);
  }
  await rejects(() => ops.switchBranch({ ...io, branch: 'absent' }), 'git/unknown-branch', 'unknown local branch refused');
  await rejects(() => ops.switchBranch({ ...io, branch: 'new', remoteBranch: '--bad' }), 'git/unknown-branch', 'unknown remote tracking selection refused');
  await rejects(() => ops.createBranch({ ...io, branch: 'main' }), 'git/failed', 'duplicate local branch refused');
  const dirtyCases = [
    ['unstaged edit', async () => put(repo, 'kept.txt', 'dirty\n')],
    ['staged edit', async () => { await put(repo, 'kept.txt', 'dirty\n'); await raw(repo, 'add', 'kept.txt'); }],
    ['untracked nested file', async () => { await mkdir(join(repo, 'nested'), { recursive: true }); await put(repo, 'nested/new.txt', 'new\n'); }],
    ['staged addition', async () => { await put(repo, 'new.txt', 'new\n'); await raw(repo, 'add', 'new.txt'); }],
    ['unstaged deletion', async () => rm(join(repo, 'kept.txt'))],
    ['staged deletion', async () => raw(repo, 'rm', '-q', 'kept.txt')],
    ['staged rename', async () => raw(repo, 'mv', 'old.txt', 'renamed.txt')],
  ];
  for (const [label, mutate] of dirtyCases) {
    await mutate();
    const before = await raw(repo, 'status', '--porcelain');
    await rejects(() => ops.switchBranch({ ...io, branch: 'topic/国际' }), 'git/dirty-tree', `${label}: switch refused`);
    await rejects(() => ops.createBranch({ ...io, branch: 'unsafe-dirty' }), 'git/dirty-tree', `${label}: creation refused`);
    await rejects(() => ops.pull({ ...io, sourceBranch: 'main' }), 'git/dirty-tree', `${label}: pull refused`);
    check(await raw(repo, 'status', '--porcelain') === before, `${label}: index/tree preserved`);
    await pristine();
  }
  await raw(peer, 'switch', '-qc', 'remote/topic'); await put(peer, 'remote-only.txt', 'remote topic\n'); await commit(peer, 'remote topic'); await seeding(peer, 'push', '-q', 'origin', 'remote/topic'); await raw(peer, 'switch', '-q', 'main');
  await put(repo, 'kept.txt', 'dirty fetch survivor\n');
  const fetchBefore = await readFile(join(repo, 'kept.txt'), 'utf8'); const fetchHead = await raw(repo, 'rev-parse', 'HEAD');
  await ops.fetch({ ...io, remote: 'origin' });
  check((await ops.branches(io)).remote.some((row) => row.name === 'origin/remote/topic'), 'fetch updates remote refs');
  check(await readFile(join(repo, 'kept.txt'), 'utf8') === fetchBefore && await raw(repo, 'rev-parse', 'HEAD') === fetchHead, 'fetch preserves dirty files and current HEAD');
  await pristine();
  await ops.switchBranch({ ...io, branch: 'tracking-local', remoteBranch: 'origin/remote/topic' });
  check((await ops.status(io)).upstream === 'origin/remote/topic', 'tracking creation binds selected actual remote ref');
  await ops.pull({ ...io, sourceBranch: 'tracking-local' });
  await ops.push({ ...io, sourceBranch: 'tracking-local' });
  check(await raw(origin, 'rev-parse', 'refs/heads/remote/topic') === await raw(repo, 'rev-parse', 'tracking-local'), 'different-named valid upstream pull/push is supported');
  await ops.switchBranch({ ...io, branch: 'main' });

  console.log('\n## source intent and transport target refusal');
  for (const operation of ['pull', 'push']) {
    await rejects(() => ops[operation](io), 'git/invalid-branch', `${operation}: missing source refused without default`);
    await rejects(() => ops[operation]({ ...io, sourceBranch: 7 }), 'git/invalid-branch', `${operation}: non-string source refused`);
    await rejects(() => ops[operation]({ ...io, sourceBranch: 'topic/国际' }), 'git/source-branch-changed', `${operation}: mismatched source refused`);
    for (const remote of ['--all', 'https://user:secret@host/repo', 'origin:evil', 'missing', 3]) await rejects(() => ops[operation]({ ...io, sourceBranch: 'main', remote }), 'git/invalid-remote', `${operation}: unsafe/unconfigured remote ${JSON.stringify(remote)} refused`);
    await rejects(() => ops[operation]({ ...io, sourceBranch: 'main', branch: 'main:evil' }), 'git/invalid-branch', `${operation}: refspec target injection refused`);
  }
  await rejects(() => ops.push({ ...io, sourceBranch: 'main', setUpstream: 'true' }), 'git/invalid-boolean', 'non-boolean upstream confirmation refused');
  const beforeQueued = await refs(origin);
  const queue = Promise.resolve().then(() => ops.switchBranch({ ...io, branch: 'topic/国际' }));
  await rejects(() => queue.then(() => ops.push({ ...io, sourceBranch: 'main', remote: 'origin', branch: 'main' })), 'git/source-branch-changed', 'queued switch then stale push refuses supplied old source');
  await rejects(() => ops.pull({ ...io, sourceBranch: 'main', remote: 'origin', branch: 'main' }), 'git/source-branch-changed', 'queued switch then stale pull refuses supplied old source');
  check(await refs(origin) === beforeQueued, 'stale queued push does not alter remote refs');
  await rejects(() => ops.push({ ...io, sourceBranch: 'topic/国际' }), 'git/missing-upstream', 'first push requires explicit remote/branch/upstream confirmation');
  await rejects(() => ops.push({ ...io, sourceBranch: 'topic/国际', remote: 'origin', branch: 'published' }), 'git/missing-upstream', 'first push without setUpstream is refused');
  await rejects(() => ops.pull({ ...io, sourceBranch: 'topic/国际' }), 'git/missing-upstream', 'pull without upstream or explicit target is refused');
  await ops.push({ ...io, sourceBranch: 'topic/国际', remote: 'origin', branch: 'published', setUpstream: true });
  check((await ops.status(io)).upstream === 'origin/published', 'confirmed first push records actual different-named upstream');
  await ops.switchBranch({ ...io, branch: 'main' });

  console.log('\n## FF-only pull, divergence, normal current-only push');
  await put(peer, 'kept.txt', 'peer fast forward\n'); const peerTip = await commit(peer, 'peer FF'); await seeding(peer, 'push', '-q', 'origin', 'main');
  await raw(repo, 'config', 'pull.rebase', 'true'); await raw(repo, 'config', 'pull.ff', 'false'); await raw(repo, 'config', 'rebase.autoStash', 'true');
  await ops.pull({ ...io, sourceBranch: 'main' });
  check(await raw(repo, 'rev-parse', 'HEAD') === peerTip && await readFile(join(repo, 'kept.txt'), 'utf8') === 'peer fast forward\n', 'FF pull advances branch and working files');
  await put(repo, 'local-only.txt', 'local divergent\n'); const divergentHead = await commit(repo, 'local divergent');
  await put(peer, 'peer-only.txt', 'peer divergent\n'); const divergentRemote = await commit(peer, 'peer divergent'); await seeding(peer, 'push', '-q', 'origin', 'main');
  const treeBefore = await raw(repo, 'write-tree');
  await rejects(() => ops.pull({ ...io, sourceBranch: 'main' }), 'git/non-fast-forward', 'divergent pull returns actionable FF refusal');
  check(await raw(repo, 'rev-parse', 'HEAD') === divergentHead && await raw(repo, 'write-tree') === treeBefore && (await ops.status(io)).changes.length === 0, 'divergent pull preserves HEAD/index/worktree despite rebase/merge defaults');
  for (const key of ['pull.rebase', 'pull.ff', 'rebase.autoStash']) await raw(repo, 'config', '--unset', key);
  await raw(repo, 'config', 'remote.origin.mirror', 'true');
  await raw(repo, 'config', 'remote.origin.push', '+refs/heads/*:refs/heads/*');
  await raw(repo, 'config', 'push.default', 'matching'); await raw(repo, 'config', 'push.followTags', 'true');
  await raw(repo, 'tag', '-a', 'must-not-push', '-m', 'private tag');
  const nonFFBefore = await refs(origin);
  await rejects(() => ops.push({ ...io, sourceBranch: 'main' }), 'git/non-fast-forward', 'non-FF push refuses even malicious mirror/default/force-refspec config');
  check(await refs(origin) === nonFFBefore && await raw(origin, 'rev-parse', 'main') === divergentRemote, 'non-FF push changes no remote refs');
  await ops.switchBranch({ ...io, branch: 'topic/国际' }); await put(repo, 'published.txt', 'safe branch push\n'); const published = await commit(repo, 'publish current only');
  const ordinaryBefore = (await refs(origin)).split('\n').filter((row) => !row.startsWith('refs/heads/published '));
  await put(repo, 'kept.txt', 'uncommitted push survivor\n');
  await ops.push({ ...io, sourceBranch: 'topic/国际' });
  check(await raw(origin, 'rev-parse', 'published') === published, 'ordinary push publishes explicitly confirmed current source');
  check(JSON.stringify((await refs(origin)).split('\n').filter((row) => !row.startsWith('refs/heads/published '))) === JSON.stringify(ordinaryBefore), 'ordinary push excludes other heads/tags/deletions despite dangerous config');
  check(await readFile(join(repo, 'kept.txt'), 'utf8') === 'uncommitted push survivor\n', 'push preserves uncommitted working files');
  await pristine();
  for (const key of ['remote.origin.mirror', 'remote.origin.push', 'push.default', 'push.followTags']) await raw(repo, 'config', '--unset-all', key);

  console.log('\n## immutable historic details/diffs and real graph topology');
  await ops.switchBranch({ ...io, branch: 'main' });
  await raw(repo, 'mv', 'old.txt', 'new.txt'); const renameHash = await commit(repo, 'rename subject\n\nrename body');
  await raw(repo, 'rm', '-q', 'delete.txt'); const deletionHash = await commit(repo, 'delete historic');
  await raw(repo, 'switch', '-qc', 'merge-side'); await put(repo, 'side.txt', 'side contribution\n'); const sideHash = await commit(repo, 'side commit');
  await raw(repo, 'switch', '-q', 'main'); await put(repo, 'main-only.txt', 'main contribution\n'); const firstParent = await commit(repo, 'main commit');
  await raw(repo, 'merge', '-q', '--no-ff', 'merge-side', '-m', 'real merge'); const mergeHash = await raw(repo, 'rev-parse', 'HEAD');
  await raw(repo, 'tag', '-a', 'annotated', '-m', 'annotated', rootHash); await raw(repo, 'tag', 'lightweight', deletionHash);
  const rootDetails = await ops.commitDetails({ ...io, hash: rootHash });
  check(rootDetails.commit.parents.length === 0 && rootDetails.commit.message.includes('root body') && rootDetails.files.some((row) => row.path === 'delete.txt'), 'root details retain full message and root file list');
  check((await ops.commitDiff({ ...io, hash: rootHash, path: 'literal[1].txt' })).added === 1, 'root diff handles literal wildcard filename');
  const renamed = await ops.commitDetails({ ...io, hash: renameHash });
  check(renamed.files.some((row) => row.path === 'new.txt' && row.oldPath === 'old.txt' && row.status.startsWith('R')), 'historic rename membership comes from Git metadata');
  check((await ops.commitDiff({ ...io, hash: renameHash, path: 'old.txt' })).header.some((line) => line.startsWith('rename from')), 'historic rename diff accepts immutable old path');
  check((await ops.commitDiff({ ...io, hash: renameHash, path: 'new.txt' })).header.some((line) => line.startsWith('rename to')), 'historic rename diff accepts immutable new path');
  const deleted = await ops.commitDetails({ ...io, hash: deletionHash });
  check(deleted.files.some((row) => row.path === 'delete.txt' && row.status === 'D'), 'historic deletion file membership is retained');
  check((await ops.commitDiff({ ...io, hash: deletionHash, path: 'delete.txt' })).removed === 1, 'deleted file diff works without a current filesystem file');
  const merged = await ops.commitDetails({ ...io, hash: mergeHash });
  check(JSON.stringify(merged.commit.parents) === JSON.stringify([firstParent, sideHash]) && merged.files.some((row) => row.path === 'side.txt') && !merged.files.some((row) => row.path === 'main-only.txt'), 'merge details expose actual parents and first-parent files');
  check((await ops.commitDiff({ ...io, hash: mergeHash, path: 'side.txt' })).added === 1, 'merge historic diff compares first parent');
  await put(repo, 'new.txt', 'current unrelated replacement\n');
  check((await ops.commitDiff({ ...io, hash: rootHash, path: 'old.txt' })).added === 1, 'historic diff ignores current file content and renamed filesystem');
  await rejects(() => ops.commitDiff({ ...io, hash: deletionHash, path: 'kept.txt' }), 'git/invalid-path', 'unchanged existing file rejected by immutable changed-file membership');
  await rejects(() => ops.commitDiff({ ...io, hash: deletionHash, path: '../outside' }), 'git/invalid-path', 'non-member historical path traversal refused');
  for (const hash of ['HEAD', '--all', 'a'.repeat(40), 2]) await rejects(() => ops.commitDetails({ ...io, hash }), 'git/invalid-hash', `non-exact/noncommit hash refused: ${JSON.stringify(hash)}`);
  const blob = await raw(repo, 'rev-parse', `${rootHash}:kept.txt`);
  await rejects(() => ops.commitDetails({ ...io, hash: blob }), 'git/invalid-hash', 'exact blob hash rejected as noncommit');
  await pristine();
  const graph = await ops.graph(io); const index = new Map(graph.commits.map((row, at) => [row.hash, at]));
  check(graph.commits.some((row) => row.hash === mergeHash && row.parents.length === 2), 'graph includes real merge parent topology');
  check(graph.commits.some((row) => row.hash === divergentRemote) && graph.commits.some((row) => row.hash === published), 'graph includes all-ref remote and noncurrent local history');
  check(graph.commits.every((row, at) => row.parents.every((parent) => !index.has(parent) || index.get(parent) > at)), 'graph ordering is topological rather than invented lanes');
  check(graph.commits.find((row) => row.hash === rootHash).refs.some((ref) => ref.kind === 'tag' && ref.name === 'annotated'), 'annotated tag is peeled to its commit');
  check(graph.commits.find((row) => row.hash === deletionHash).refs.some((ref) => ref.kind === 'tag' && ref.name === 'lightweight'), 'lightweight tag decorates actual commit');
  const paged = createOperations(runner, { ...config, maxLogEntries: 2 }); let all = [], more = true;
  while (more) { const page = await paged.graph({ ...io, skip: all.length }); check(page.commits.length <= 2, `graph page ${all.length}: bounded`); all.push(...page.commits); more = page.hasMore; }
  check(JSON.stringify(all.map((row) => row.hash)) === JSON.stringify(graph.commits.map((row) => row.hash)), 'graph pagination has no duplicates/omissions and correct hasMore');
  for (const skip of [-1, 1.5, '2', Number.MAX_SAFE_INTEGER + 1]) await rejects(() => ops.graph({ ...io, skip }), 'git/invalid-pagination', `invalid graph skip refused: ${skip}`);
  await rejects(() => createOperations(runner, { ...config, maxDiffLines: 0 }).commitDiff({ ...io, hash: rootHash, path: 'kept.txt' }), 'git/diff-too-large', 'historic line cap refuses oversized diff');
  const tiny = new GitRunner(adapter, 'git', { ...limits, maxOutputBytes: 32 });
  await rejects(() => createOperations(tiny, config).graph(io), 'git/output-too-large', 'bounded runner refuses truncated graph metadata');
  check((await ops.log(io))[0].hash === mergeHash, 'existing log/readback API remains compatible');

  console.log('\n## immutable reads: replacement objects, signatures, exact IDs, local-only policy');

  // `refs/replace` rewrites history for every ordinary reader. An exact-ID
  // request must see the object it named, not a substituted descendant.
  const rewrite = join(scratch, 'rewrite'); await mkdir(rewrite);
  await raw(rewrite, 'init', '-q', '-b', 'main');
  await raw(rewrite, 'config', 'user.name', 'Verify'); await raw(rewrite, 'config', 'user.email', 'verify@example.invalid');
  await put(rewrite, 'root.txt', 'root file\n');
  const rewriteRoot = await commit(rewrite, 'original root subject');
  await put(rewrite, 'child.txt', 'child file\n');
  const rewriteChild = await commit(rewrite, 'child subject');
  await raw(rewrite, 'replace', rewriteRoot, rewriteChild);
  const rewriteIo = { root: rewrite };
  const replaced = await ops.commitDetails({ ...rewriteIo, hash: rewriteRoot });
  check(replaced.commit.hash === rewriteRoot && replaced.commit.subject === 'original root subject', 'a replacement ref cannot rewrite an exact commit ID');
  check(replaced.commit.parents.length === 0 && replaced.files.some((row) => row.path === 'root.txt'), 'a replaced root commit keeps its real parents and file list');
  await put(rewrite, 'blob.txt', 'blob body\n');
  const blobId = await raw(rewrite, 'hash-object', '-w', 'blob.txt');
  // `git replace` refuses a cross-type mapping, but a replace ref can be written
  // directly — and a reader that honours replacement objects would then treat a
  // blob request as a commit.
  await raw(rewrite, 'update-ref', `refs/replace/${blobId}`, rewriteChild);
  await rejects(() => ops.commitDetails({ ...rewriteIo, hash: blobId }), 'git/invalid-hash', 'a blob hidden behind a replacement ref is still not a commit');
  check((await ops.graph(rewriteIo)).commits.find((row) => row.hash === rewriteRoot)?.subject === 'original root subject', 'the graph ignores replacement objects');
  check((await ops.commitDiff({ ...rewriteIo, hash: rewriteRoot, path: 'root.txt' })).added === 1, 'historic diff of a replaced root commit reads the real object');

  // A host-wide `log.showSignature=true` makes Git run the signature program
  // during machine reads. That program is an external command whose output
  // lands in stdout ahead of `%H`, so structured readers must disable it.
  const signed = join(scratch, 'signed'); await mkdir(signed);
  await raw(signed, 'init', '-q', '-b', 'main');
  await raw(signed, 'config', 'user.name', 'Verify'); await raw(signed, 'config', 'user.email', 'verify@example.invalid');
  await put(signed, 'signed.txt', 'signed body\n');
  const signedBase = await commit(signed, 'base subject');
  // A crafted signed commit whose tree really differs from its parent, so the
  // changed-file list proves the signature object was parsed, not just accepted.
  await put(signed, 'signed-change.txt', 'signed change\n');
  await raw(signed, 'add', '--', 'signed-change.txt');
  const signedTree = await raw(signed, 'write-tree');
  await writeFile(join(signed, 'commit-object.txt'), [
    `tree ${signedTree}`,
    `parent ${signedBase}`,
    'author Verify <verify@example.invalid> 1700000000 +0000',
    'committer Verify <verify@example.invalid> 1700000000 +0000',
    'gpgsig -----BEGIN PGP SIGNATURE-----',
    ' ',
    ' deadbeefdeadbeef',
    ' -----END PGP SIGNATURE-----',
    '',
    'signed subject',
  ].join('\n') + '\n');
  const signedHash = await raw(signed, 'hash-object', '-t', 'commit', '-w', 'commit-object.txt');
  await raw(signed, 'update-ref', 'refs/heads/main', signedHash);
  const signatureSentinel = join(signed, 'signature-program-ran');
  const signatureProgram = join(signed, 'gpg-stub.sh');
  await writeFile(signatureProgram, `#!/bin/sh\ntouch ${signatureSentinel}\necho "gpg: controlled signature diagnostic"\nexit 1\n`);
  await chmod(signatureProgram, 0o755);
  await raw(signed, 'config', 'log.showSignature', 'true');
  await raw(signed, 'config', 'gpg.program', signatureProgram);
  const signatureRan = () => readFile(signatureSentinel).then(() => true, () => false);
  const signedIo = { root: signed };
  const signedGraph = await ops.graph(signedIo);
  check(signedGraph.commits.length > 0 && signedGraph.commits.every((row) => /^[0-9a-f]{40}$/.test(row.hash)), 'signature display cannot corrupt structured graph hashes');
  check(signedGraph.commits.some((row) => row.hash === signedHash && row.subject === 'signed subject'), 'a signed commit keeps its real hash and subject');
  const signedDetails = await ops.commitDetails({ ...signedIo, hash: signedHash });
  check(signedDetails.commit.subject === 'signed subject' && signedDetails.files.some((row) => row.path === 'signed-change.txt'), 'signed commit details still parse');
  check(!(await signatureRan()), 'machine reads never execute the signature program');

  // A partial (promisor) clone must answer reads from local objects only. Its
  // remote is pointed at a helper that records any execution, so a read that
  // silently fetches is detectable rather than merely surprising.
  const partialSource = join(scratch, 'partial-source'); await mkdir(partialSource);
  await raw(partialSource, 'init', '-q', '-b', 'main');
  await raw(partialSource, 'config', 'user.name', 'Verify'); await raw(partialSource, 'config', 'user.email', 'verify@example.invalid');
  await put(partialSource, 'history.txt', 'first body\n');
  await commit(partialSource, 'first subject');
  await put(partialSource, 'history.txt', 'second body\n');
  await commit(partialSource, 'second subject');
  await raw(partialSource, 'config', 'uploadpack.allowFilter', 'true');
  const partialFirst = await raw(partialSource, 'rev-parse', 'HEAD~1');
  const partial = join(scratch, 'partial');
  await seeding(scratch, 'clone', '-q', '--filter=blob:none', '--no-checkout', '--bare', `file://${partialSource}`, partial);
  const fetchSentinel = join(scratch, 'promisor-helper-ran');
  const fetchHelper = join(scratch, 'promisor-helper.sh');
  await writeFile(fetchHelper, `#!/bin/sh\ntouch ${fetchSentinel}\necho "controlled-secret-diagnostic for https://user:secret@private.invalid/x?token=credential"\nexit 1\n`);
  await chmod(fetchHelper, 0o755);
  await raw(partial, 'config', 'protocol.ext.allow', 'always');
  await raw(partial, 'remote', 'set-url', 'origin', `ext::${fetchHelper}`);
  const helperRan = () => readFile(fetchSentinel).then(() => true, () => false);
  const objectsBefore = await raw(partial, 'count-objects', '-v');
  check(!(await helperRan()), 'the scratch partial clone has not contacted its promisor remote yet');
  const lazyError = await rejects(() => ops.commitDiff({ root: partial, hash: partialFirst, path: 'history.txt' }), 'git/object-unavailable', 'a partial clone refuses a missing object instead of fetching it');
  check(!/controlled-secret-diagnostic|ext::|private\.invalid|secret|token=credential/.test(`${lazyError?.message ?? ''}`), 'the local-object refusal exposes no helper diagnostic or endpoint');
  check(!(await helperRan()), 'a read never executes the promisor helper');
  check(await raw(partial, 'count-objects', '-v') === objectsBefore, 'a read fetches no objects into the partial clone');

  // "Exact full object ID" must stay honest in a SHA-256 repository, where the
  // first 40 characters of a 64-character ID is a legal abbreviation.
  const sha256Root = join(scratch, 'sha256'); await mkdir(sha256Root);
  const sha256Init = await runner.run(['init', '-q', '-b', 'main', '--object-format=sha256'], { cwd: sha256Root });
  if (sha256Init.exitCode === 0) {
    await raw(sha256Root, 'config', 'user.name', 'Verify'); await raw(sha256Root, 'config', 'user.email', 'verify@example.invalid');
    await put(sha256Root, 'sha.txt', 'sha body\n');
    const sha256Head = await commit(sha256Root, 'sha256 subject');
    check(sha256Head.length === 64, 'fixture really uses SHA-256 object IDs');
    check((await ops.commitDetails({ root: sha256Root, hash: sha256Head })).commit.hash === sha256Head, 'a full SHA-256 object ID resolves');
    check((await ops.commitDetails({ root: sha256Root, hash: sha256Head.toUpperCase() })).commit.hash === sha256Head, 'a full object ID is accepted case-insensitively');
    await rejects(() => ops.commitDetails({ root: sha256Root, hash: sha256Head.slice(0, 40) }), 'git/invalid-hash', 'a truncated SHA-256 ID is not an exact full object ID');
  } else {
    console.log(`skip SHA-256 object format not supported by this git (exit ${sha256Init.exitCode})`);
  }

  console.log('\n## structured upstream target');
  const meta = join(scratch, 'meta'), metaOrigin = join(scratch, 'meta-origin.git');
  await raw(scratch, 'init', '--bare', '-q', metaOrigin);
  await mkdir(meta);
  await raw(meta, 'init', '-q', '-b', 'main');
  await raw(meta, 'config', 'user.name', 'Verify'); await raw(meta, 'config', 'user.email', 'verify@example.invalid');
  await put(meta, 'meta.txt', 'meta body\n');
  await commit(meta, 'meta subject');
  await raw(meta, 'remote', 'add', 'origin', metaOrigin);
  await seeding(meta, 'push', '-q', '-u', 'origin', 'main');
  const metaIo = { root: meta };
  const metaMain = (await ops.branches(metaIo)).local.find((row) => row.name === 'main');
  check(metaMain.upstream === 'origin/main' && JSON.stringify(metaMain.upstreamTarget) === '{"remote":"origin","branch":"main"}', 'branches reports a structured upstream target next to the display name');
  check(!(await ops.branches(metaIo)).local.some((row) => 'upstreamTarget' in row === false), 'every local branch reports the field explicitly, including null');

  // A configured upstream survives a missing/pruned local tracking ref. The
  // display name alone cannot decide this: it is abbreviated and can be stale.
  const metaBackup = join(scratch, 'meta-backup.git');
  await raw(scratch, 'init', '--bare', '-q', metaBackup);
  await raw(meta, 'remote', 'add', 'backup', metaBackup);
  await raw(meta, 'switch', '-qc', 'release-track');
  await raw(meta, 'config', 'branch.release-track.remote', 'backup');
  await raw(meta, 'config', 'branch.release-track.merge', 'refs/heads/release');
  const releaseRow = (await ops.branches(metaIo)).local.find((row) => row.name === 'release-track');
  check(JSON.stringify(releaseRow.upstreamTarget) === '{"remote":"backup","branch":"release"}', 'an upstream without any local tracking ref still yields a structured target');
  check(!(await ops.branches(metaIo)).remote.some((row) => row.remote === 'backup'), 'no remote-tracking ref is invented for that target');
  const upstreamSpy = spyOperations('', { exitCode: 0 });
  await upstreamSpy.operations.pull({ root: meta, sourceBranch: 'release-track' });
  check(upstreamSpy.calls.length === 1 && upstreamSpy.calls[0].argv.at(-2) === 'backup' && upstreamSpy.calls[0].argv.at(-1) === 'release', 'pull defaults to the configured upstream rather than the first configured remote');

  // A remote name may itself contain a slash; splitting the display name would
  // guess the wrong remote or the wrong branch.
  const metaTeam = join(scratch, 'meta-team.git');
  await raw(scratch, 'init', '--bare', '-q', metaTeam);
  await raw(meta, 'remote', 'add', 'team/one', metaTeam);
  await raw(meta, 'switch', '-qc', 'team-track');
  await raw(meta, 'config', 'branch.team-track.remote', 'team/one');
  await raw(meta, 'config', 'branch.team-track.merge', 'refs/heads/feature/deep');
  const teamRow = (await ops.branches(metaIo)).local.find((row) => row.name === 'team-track');
  check(JSON.stringify(teamRow.upstreamTarget) === '{"remote":"team/one","branch":"feature/deep"}', 'a slashed remote name and slashed branch stay unambiguous');

  // A `.` upstream tracks a LOCAL branch. It is not a remote target, so a
  // remote operation without an explicit target must be refused.
  await raw(meta, 'switch', '-qc', 'local-track');
  await raw(meta, 'config', 'branch.local-track.remote', '.');
  await raw(meta, 'config', 'branch.local-track.merge', 'refs/heads/main');
  const localRow = (await ops.branches(metaIo)).local.find((row) => row.name === 'local-track');
  check(localRow.upstreamTarget === null && localRow.upstream === 'main', 'a local (.) upstream is displayed but is not a remote target');
  await rejects(() => ops.pull({ root: meta, sourceBranch: 'local-track' }), 'git/missing-upstream', 'a local upstream cannot silently become a remote pull target');
  const explicitSpy = spyOperations('', { exitCode: 0 });
  await explicitSpy.operations.pull({ root: meta, sourceBranch: 'local-track', remote: 'backup', branch: 'release' });
  check(explicitSpy.calls.length === 1 && explicitSpy.calls[0].argv.at(-2) === 'backup' && explicitSpy.calls[0].argv.at(-1) === 'release', 'an explicit target still works without any configured upstream');

  console.log('\n## local-only policy and diagnostic redaction');
  const policySpecs = [];
  const policyFake = { spawn(spec) { policySpecs.push(spec); return { done: Promise.resolve({ exitCode: 0 }), collected: { stdout: { readFrom: () => ({ text: '', lossy: false }) }, stderr: { readFrom: () => ({ text: '' }) } } }; } };
  const policyRunner = new GitRunner(policyFake, 'git', limits);
  await policyRunner.run(['status'], { cwd: repo });
  check(policySpecs.at(-1).env.GIT_NO_LAZY_FETCH === '1' && policySpecs.at(-1).env.GIT_CONFIG_KEY_0 === 'protocol.allow' && policySpecs.at(-1).env.GIT_CONFIG_VALUE_0 === 'never', 'ordinary calls get fixed local-only protocol policy');
  await policyRunner.run(['show', 'HEAD'], { cwd: repo, immutable: true });
  check(policySpecs.at(-1).env.GIT_NO_REPLACE_OBJECTS === '1' && policySpecs.at(-1).env.GIT_NO_LAZY_FETCH === '1', 'immutable reads disable replacement objects and stay local');
  await policyRunner.run(['fetch', 'origin'], { cwd: repo, transportBatchMode: true });
  check(policySpecs.at(-1).env.GIT_NO_LAZY_FETCH === undefined && policySpecs.at(-1).env.GIT_NO_REPLACE_OBJECTS === undefined && policySpecs.at(-1).env.GIT_CONFIG_COUNT === '0', 'only explicit transport is exempt from the local-only policy');
  check(redactDiagnostic('fatal: unable to access https://user:secret@example.invalid/r.git?token=abc') === 'fatal: unable to access https://example.invalid/r.git?…', 'diagnostics drop URL credentials and query tokens');
  check(redactDiagnostic('x'.repeat(1000)).length <= 401 && redactDiagnostic('').length === 0, 'diagnostics stay bounded and empty input stays empty');
  // A credential survives in more shapes than a URL query string. Each of these
  // is a form a real helper or transport prints.
  for (const [raw, secret] of [
    ['http.extraheader=Authorization: Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNzd29yZA=='],
    ['Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk', 'dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'],
    ['fatal: could not read from https://user:pa/ss@host.invalid/x', 'pa/ss'],
    ['fatal: could not read from https://user:p@ss@host.invalid/x', 'p@ss'],
    ['user:pa/ss@host.invalid/path', 'pa/ss'],
  ]) {
    check(!redactDiagnostic(raw).includes(secret), `redaction removes the secret from ${raw.slice(0, 34)}…`, redactDiagnostic(raw));
  }
  check(redactDiagnostic('bad object 0a515b34cd68e555fe79936bc250ea510b2b88fb').includes('0a515b34cd68e555fe79936bc250ea510b2b88fb'), 'redaction keeps a plain object ID that names the problem');
  check(redactDiagnostic('note: see foo@bar.com') === 'note: see foo@bar.com', 'redaction does not mangle ordinary prose with an address');
  // Both directions matter: a survivor leaks a password, and an over-eager rule
  // destroys the diagnostic that says what actually went wrong.
  for (const survivor of [
    'fatal: could not read from user:secret@localhost/repo.git',
    'fatal: could not read from user:secret@myhost',
    'Authentication failed for user:secret@no-dot-host/repo',
    'scheme Basic dXNlcjpwYXNz',
  ]) {
    check(!redactDiagnostic(survivor).includes('secret') && !redactDiagnostic(survivor).includes('dXNlcjpwYXNz'), `redaction removes the scheme-less credential in ${survivor.slice(0, 34)}…`, redactDiagnostic(survivor));
  }
  // Labelled and context-bearing credentials, including forms that are not a
  // URL at all: a scheme word, a secret-named assignment, a signed query.
  for (const [labelled, secret] of [
    ['Basic dXNlcjpwYXNz', 'dXNlcjpwYXNz'],
    ['scheme Digest username="u", response="0123456789abcdef"', '0123456789abcdef'],
    ['host.invalid/x?X-Amz-Signature=deadbeefcafe', 'deadbeefcafe'],
    ['api-key=SECRETVALUE', 'SECRETVALUE'],
    ['remote: password=hunter2', 'hunter2'],
  ]) {
    check(!redactDiagnostic(labelled).includes(secret), `redaction removes the labelled credential in ${labelled.slice(0, 34)}…`, redactDiagnostic(labelled));
  }
  for (const useful of [
    'fatal: cannot open /workspace/dsh-source-control/lib/git.js',
    'CONFLICT (content): Merge conflict in src/components/panel.ts',
    "pathspec 'feature/very-long-branch-name' did not match any file(s) known to git",
    'warning: adding embedded git repository: /tmp/x/vendor/repo',
    'fatal: your current branch main does not have any commits yet',
    'M\tsrc/renamed.ts',
    // The other direction of the same trade-off: a rule eager enough to catch an
    // unlabelled blob destroys these, so an unlabelled blob is deliberately out
    // of scope instead (see the function's own scope note).
    'fatal: basic authentication is not supported by this remote',
    'error: digest mismatch while verifying object',
    'note: negotiate failed with the proxy',
    "pathspec 'token=value' did not match",
    "pathspec 'src/components/verylongdirectoryname/file=' did not match",
    'warning: file abcdefghijklmnopqrstuvwx= is corrupt',
    'refspec refs/heads/a:refs/heads/b',
  ]) {
    check(redactDiagnostic(useful) === useful.trim(), `redaction preserves the useful diagnostic ${useful.slice(0, 34)}…`, redactDiagnostic(useful));
  }

  // The staged-index probe that decides "nothing to commit" must not run a
  // repository-configured external diff driver either.
  const commitArgv = [];
  const commitAdapter = {
    spawn(spec) {
      commitArgv.push(spec.argv);
      const quiet = spec.argv.includes('--quiet');
      return {
        done: Promise.resolve({ exitCode: quiet ? 1 : 0 }),
        collected: {
          stdout: { readFrom: () => ({ text: quiet ? '' : 'abcdef1234567890\n', lossy: false }) },
          stderr: { readFrom: () => ({ text: '' }) },
        },
      };
    },
  };
  await createOperations(new GitRunner(commitAdapter, 'git', limits), config)
    .commit({ root: repo, message: 'argv probe' })
    .then(() => {}, () => {});
  const quietArgv = commitArgv.find((argv) => argv.includes('--quiet'));
  check(quietArgv !== undefined && quietArgv.includes('--no-ext-diff') && quietArgv.includes('--no-textconv'), 'the commit pre-check disables repository-defined diff drivers', quietArgv);

  // A repository can declare an external diff driver in its own config. Git runs
  // it for a full diff unless the caller opts out, so this is the real test that
  // a read does not execute a program the repository names.
  const driverRan = join(scratch, 'external-diff-ran');
  const driver = join(scratch, 'external-diff.sh');
  await writeFile(driver, `#!/bin/sh\ntouch ${driverRan}\necho "fatal: external diff died, stopping at tracked.txt" >&2\nexit 1\n`);
  await chmod(driver, 0o755);
  await raw(repo, 'config', 'diff.external', driver);
  await pristine();
  await put(repo, 'kept.txt', 'driver probe\n');
  await raw(repo, 'add', '--', 'kept.txt');
  const driverSeen = () => readFile(driverRan).then(() => true, () => false);
  await rm(driverRan, { force: true });
  const driverDiff = await ops.diff({ ...io, path: 'kept.txt', staged: true, untracked: false });
  check(driverDiff.hunks.length > 0, 'the staged diff still returns the real change with an external driver configured');
  check(!(await driverSeen()), 'a reviewable diff never runs a repository-configured external diff driver');
  // The hunk path must really slice and apply: a wrong field name throws before
  // reaching git, and a swallowed error would hide exactly that.
  await pristine();
  await put(repo, 'kept.txt', 'hunk probe\n');
  await rm(driverRan, { force: true });
  const hunkResult = await ops.stageHunk({ ...io, path: 'kept.txt', hunkIndex: 0 });
  check(hunkResult.total === 1 && hunkResult.hunkIndex === 0, 'the hunk path slices the real unstaged change', hunkResult);
  check(!(await driverSeen()), 'the hunk path never runs a repository-configured external diff driver either');
  await raw(repo, 'config', '--unset', 'diff.external');
  await pristine();

  console.log('\n## a failed read is a GitError, not a caller-visible TypeError');
  // The failure mapping lives on the runner; the parsed-read helpers call it
  // through their captured runner. A wiring mistake here turns every failed
  // read into "internal" instead of the documented code.
  // Exit code 2 is a real failure for `diff`, which treats only 0 and 1 as
  // "no difference" and "differences".
  const failing = {
    spawn() {
      return {
        done: Promise.resolve({ exitCode: 2 }),
        collected: {
          stdout: { readFrom: () => ({ text: '', lossy: false }) },
          stderr: { readFrom: () => ({ text: 'fatal: bad object HEAD' }) },
        },
      };
    },
  };
  const failingOps = createOperations(new GitRunner(failing, 'git', limits), config);
  const failingRunner = new GitRunner(failing, 'git', limits);
  await rejects(() => failingOps.log({ root: repo }), 'git/failed', 'a failed log read reports a GitError');
  await rejects(() => failingOps.diff({ root: repo, path: 'kept.txt', staged: false, untracked: false }), 'git/failed', 'a failed diff read reports a GitError');
  await rejects(() => failingOps.stageHunk({ root: repo, path: 'kept.txt', hunk: 0 }), 'git/failed', 'a failed hunk read reports a GitError');
  const promisorOps = createOperations(new GitRunner({
    spawn() {
      return {
        done: Promise.resolve({ exitCode: 128 }),
        collected: {
          stdout: { readFrom: () => ({ text: '', lossy: false }) },
          stderr: { readFrom: () => ({ text: 'fatal: could not fetch 5626abf0f72e58d7a153368ba57db4c673c0e171 from promisor remote' }) },
        },
      };
    },
  }, 'git', limits), config);
  await rejects(() => promisorOps.log({ root: repo }), 'git/object-unavailable', 'a missing promisor object maps to the actionable code through every read path');
  await rejects(() => failingRunner.ok(['log', '-1'], { cwd: repo }), 'git/failed', 'the runner itself still maps a failed read');
  check(!/this\.readFailure|is not a function/.test(
    await failingOps.log({ root: repo }).then(() => '', (error) => String(error.message)),
  ), 'no read failure leaks a JavaScript wiring error');

  console.log('\n## every machine-parsed history read resists host configuration');
  // The legacy `log` read shares the hazard: `log.showSignature=true` made Git
  // run the signature program for graph/details, and a replacement ref changed
  // what the list reported while the detail view showed the real commit.
  const signatureProgram2 = join(signed, 'gpg-stub2.sh');
  await writeFile(signatureProgram2, `#!/bin/sh\ntouch ${signatureSentinel}\necho "gpg: controlled signature diagnostic"\nexit 1\n`);
  await chmod(signatureProgram2, 0o755);
  await raw(signed, 'config', 'gpg.program', signatureProgram2);
  await rm(signatureSentinel, { force: true });
  const signedLog = await ops.log(signedIo);
  check(!(await signatureRan()), 'the legacy log read never executes the signature program');
  check(signedLog.every((row) => /^[0-9a-f]{40}$/.test(row.hash)) && signedLog.some((row) => row.hash === signedHash && row.subject === 'signed subject'), 'the legacy log read keeps a clean hash and subject');
  const rewriteLog = await ops.log(rewriteIo);
  check(rewriteLog.find((row) => row.hash === rewriteRoot)?.subject === 'original root subject', 'the legacy log read agrees with the exact-ID detail view about a replaced commit');
  check(!(await ops.graph(rewriteIo)).commits.some((row) => row.hash === rewriteChild && row.subject === 'REPLACEMENT subject'), 'no phantom replacement row is invented');
  check((await ops.graph(rewriteIo)).commits.length === rewriteLog.length, 'graph and log agree about how many commits exist');

  // The case that actually distinguishes an explicit ref list from `--all`: a
  // replacement target reachable from NO other ref, and stashed work. Both live
  // under refs that `--all` walks and this view must not.
  const phantom = join(scratch, 'phantom'); await mkdir(phantom);
  await raw(phantom, 'init', '-q', '-b', 'main');
  await raw(phantom, 'config', 'user.name', 'Verify'); await raw(phantom, 'config', 'user.email', 'verify@example.invalid');
  await put(phantom, 'real.txt', 'real root\n');
  const phantomRoot = await commit(phantom, 'REAL root subject');
  await raw(phantom, 'switch', '-qc', 'throwaway');
  await put(phantom, 'phantom.txt', 'phantom body\n');
  const phantomTip = await commit(phantom, 'PHANTOM replacement subject');
  await raw(phantom, 'switch', '-q', 'main');
  await raw(phantom, 'branch', '-D', 'throwaway');
  await raw(phantom, 'update-ref', `refs/replace/${phantomRoot}`, phantomTip);
  const phantomIo = { root: phantom };
  const phantomGraph = await ops.graph(phantomIo);
  const phantomLog = await ops.log(phantomIo);
  check(!phantomGraph.commits.some((row) => row.subject === 'PHANTOM replacement subject'), 'an unreachable replacement object adds no phantom graph row');
  check(phantomGraph.commits.length === phantomLog.length && phantomGraph.commits.every((row) => phantomLog.some((entry) => entry.hash === row.hash)), 'graph rows are exactly the committed history rows');

  // Stashed work is not history either; it lives under refs/stash.
  await put(phantom, 'real.txt', 'real root\nstashed work\n');
  await raw(phantom, 'stash', 'push', '-q', '-u', '-m', 'WIP secret stash');
  const stashGraph = await ops.graph(phantomIo);
  check(stashGraph.commits.every((row) => !/WIP secret stash|index on |untracked files on /.test(row.subject)), 'stashed work never leaks into the history view');
  check(stashGraph.commits.length === phantomLog.length, 'a stash does not change how much history the graph reports');
  await raw(phantom, 'stash', 'drop', '-q');


  console.log('\n## conflict, detached and unborn behaviors');
  await raw(repo, 'switch', '-qc', 'conflict-side'); await put(repo, 'kept.txt', 'side conflict\n'); await commit(repo, 'conflict side');
  await raw(repo, 'switch', '-q', 'main'); await put(repo, 'kept.txt', 'main conflict\n'); await commit(repo, 'conflict main');
  const conflict = await runner.run(['merge', 'conflict-side'], { cwd: repo });
  check(conflict.exitCode !== 0 && (await ops.status(io)).conflicted.length > 0, 'fixture creates a real conflicted index');
  await rejects(() => ops.switchBranch({ ...io, branch: 'topic/国际' }), 'git/dirty-tree', 'conflicted index blocks switch');
  await rejects(() => ops.createBranch({ ...io, branch: 'conflict-new' }), 'git/dirty-tree', 'conflicted index blocks creation');
  await rejects(() => ops.pull({ ...io, sourceBranch: 'main' }), 'git/dirty-tree', 'conflicted index blocks pull');
  await raw(repo, 'merge', '--abort');
  await raw(repo, 'switch', '--detach', '-q', mergeHash);
  check((await ops.branches(io)).current === null, 'detached branch metadata reports null current');
  check((await ops.graph(io)).commits.find((row) => row.hash === mergeHash).refs.some((ref) => ref.kind === 'head'), 'detached graph includes/decorates actual HEAD');
  await put(repo, 'detached-only.txt', 'unreferenced detached history\n'); const detachedTip = await commit(repo, 'detached-only commit');
  check(!(await refs(repo)).includes(detachedTip) && (await ops.graph(io)).commits.some((row) => row.hash === detachedTip && row.refs.some((ref) => ref.kind === 'head')), 'graph includes actual detached HEAD even when no ref reaches it');
  for (const operation of ['pull', 'push']) await rejects(() => ops[operation]({ ...io, sourceBranch: 'main', remote: 'origin', branch: 'main' }), 'git/not-on-branch', `detached ${operation} refused`);
  await ops.createBranch({ ...io, branch: 'from-detached' }).then(() => check(false, 'detached create refused'), (error) => check(error.code === 'git/not-on-branch', 'detached create refused'));
  await ops.switchBranch({ ...io, branch: 'main' });
  const unborn = join(scratch, 'unborn'); await mkdir(unborn); await raw(unborn, 'init', '-q', '-b', 'main');
  const unbornIo = { root: unborn };
  check((await ops.branches(unbornIo)).current === 'main' && (await ops.branches(unbornIo)).local.length === 0, 'unborn metadata keeps named HEAD without invented branch refs');
  check((await ops.graph(unbornIo)).commits.length === 0 && !(await ops.graph(unbornIo)).hasMore, 'unborn graph is empty');
  await rejects(() => ops.createBranch({ ...unbornIo, branch: 'new' }), 'git/not-on-branch', 'unborn creation requires committed source');
  for (const operation of ['pull', 'push']) await rejects(() => ops[operation]({ ...unbornIo, sourceBranch: 'main', remote: 'origin', branch: 'main' }), 'git/not-on-branch', `unborn ${operation} refused`);
  await rejects(() => ops.fetch({ ...unbornIo, remote: 'origin' }), 'git/invalid-remote', 'unconfigured remote refused');
  await raw(unborn, 'config', 'remote.empty.fetch', '+refs/heads/*:refs/remotes/empty/*');
  await rejects(() => ops.fetch({ ...unbornIo, remote: 'empty' }), 'git/invalid-remote', 'remote section without actual URL refused');
  await raw(unborn, 'config', 'remote.push-only.pushurl', origin);
  await rejects(() => ops.fetch({ ...unbornIo, remote: 'push-only' }), 'git/invalid-remote', 'push-only endpoint cannot be fetched');

  console.log('\n## diagnostics, batch/prompt controls, abort and protocol policy');
  await raw(repo, 'remote', 'add', 'private', 'https://user:secret@private.invalid/path?token=credential');
  const diagnostics = [
    ['fatal: Authentication failed for https://user:secret@private.invalid/path?token=credential', 'git/authentication'],
    ['Permission denied (publickey). user:secret@private.invalid', 'git/authentication'],
    ['fatal: unable to access https://user:secret@private.invalid: The requested URL returned error: 403', 'git/authentication'],
    ['Host key verification failed. https://user:secret@private.invalid', 'git/host-key'],
    ['REMOTE HOST IDENTIFICATION HAS CHANGED!', 'git/host-key'],
    ['Could not resolve hostname private.invalid: Name or service not known', 'git/connection'],
    ['fatal: Not possible to fast-forward, aborting. token=credential', 'git/non-fast-forward'],
    ['rejected (non-fast-forward) secret', 'git/non-fast-forward'],
    ['opaque credential helper error https://user:secret@private.invalid', 'git/failed'],
  ];
  for (const [diagnostic, code] of diagnostics) {
    const spy = spyOperations(diagnostic);
    const error = await rejects(() => spy.operations.fetch({ ...io, remote: 'private' }), code, `safe diagnostic class ${code}`);
    check(!/private\.invalid|secret|token=credential|user:|https:\/\//.test(JSON.stringify(error?.details) + error?.message), `${code}: URL/credential content does not leak`);
    check(spy.calls.length === 1 && spy.calls[0].argv.includes('protocol.ext.allow=never') && spy.calls[0].options.transportBatchMode === true, `${code}: fixed transport safety options used`);
  }
  const pushSpy = spyOperations('', { exitCode: 0 });
  await pushSpy.operations.push({ ...io, sourceBranch: 'main', remote: 'private', branch: 'different-target' });
  check(pushSpy.calls[0].argv.at(-1) === 'refs/heads/main:refs/heads/different-target', 'push argv uses confirmed source and independently chosen target');
  const aborter = new AbortController(); aborter.abort();
  await rejects(() => ops.fetch({ ...io, remote: 'origin', signal: aborter.signal }), 'git/aborted', 'aborted request refuses command execution');
  let captured;
  const fake = { spawn(spec) { captured = spec; return { done: Promise.resolve({ exitCode: 0 }), collected: { stdout: { readFrom: () => ({ text: '', lossy: false }) }, stderr: { readFrom: () => ({ text: '' }) } } }; } };
  await new GitRunner(fake, 'git', limits).run(['fetch', 'origin'], { cwd: repo, transportBatchMode: true, env: { GIT_TERMINAL_PROMPT: '1', GIT_SSH_COMMAND: 'unsafe' } });
  check(captured.env.GIT_TERMINAL_PROMPT === '0' && captured.env.GIT_ASKPASS === 'true' && captured.env.SSH_ASKPASS_REQUIRE === 'never', 'trusted batch options disable Git/SSH terminal and askpass UI');
  check(captured.env.GIT_SSH_COMMAND === 'ssh -oBatchMode=yes' && captured.env.GIT_SSH_VARIANT === 'ssh' && !captured.env.GIT_SSH_COMMAND.includes('StrictHostKeyChecking=no'), 'batch SSH retains host key checking and default host config/keys');
  check(captured.env.GIT_CONFIG_COUNT === '0' && captured.env.GIT_LITERAL_PATHSPECS === '1' && captured.stdio.stdin === 'ignore' && captured.stdio.stderr.maxBytes === 16384, 'request env cannot override bounded runner policy; stdin ignored');
  const timeoutFake = { spawn(spec) { return { done: new Promise((res) => setTimeout(() => res({ exitCode: 0 }), 15)), collected: { stdout: { readFrom: () => ({ text: '', lossy: false }) } } }; } };
  await rejects(() => new GitRunner(timeoutFake, 'git', { ...limits, timeoutMs: 1 }).run(['fetch', 'origin'], { cwd: repo, transportBatchMode: true }), 'git/timeout', 'runner bounds noninteractive transport lifetime');
  await raw(repo, 'remote', 'add', 'ssh-spy', 'ssh://host.invalid/repository');
  await raw(repo, 'config', 'core.sshCommand', 'ssh -i /private/identity');
  const custom = spyOperations('', { exitCode: 0 });
  await rejects(() => custom.operations.fetch({ ...io, remote: 'ssh-spy' }), 'git/unsupported-ssh-command', 'custom SSH command refused rather than replacing host identity or risking prompts');
  check(custom.calls.length === 0, 'custom SSH refusal occurs before transport');
  await raw(repo, 'config', 'url.ssh://host.invalid/.insteadOf', 'https://alias.invalid/');
  await raw(repo, 'remote', 'add', 'ssh-alias', 'https://alias.invalid/repository');
  await rejects(() => custom.operations.fetch({ ...io, remote: 'ssh-alias' }), 'git/unsupported-ssh-command', 'SSH URL rewrite is detected before custom identity can be overwritten');
  await raw(repo, 'config', '--unset', 'core.sshCommand');
  for (const key of ['GIT_SSH_COMMAND', 'GIT_SSH']) {
    const prior = process.env[key]; process.env[key] = 'custom-identity-wrapper';
    try { await rejects(() => custom.operations.fetch({ ...io, remote: 'ssh-spy' }), 'git/unsupported-ssh-command', `${key} custom identity wrapper is refused safely`); }
    finally { if (prior === undefined) delete process.env[key]; else process.env[key] = prior; }
  }
  await custom.operations.fetch({ ...io, remote: 'ssh-spy' });
  check(custom.calls.length === 1, 'ordinary SSH config uses spied batch transport without network');
  await raw(repo, 'remote', 'add', 'ext-spy', 'ext::must-not-execute');
  const ext = await rejects(() => ops.fetch({ ...io, remote: 'ext-spy' }), 'git/failed', 'ext protocol is refused locally without executing a helper');
  check(!ext?.message.includes('must-not-execute'), 'ext diagnostic does not leak endpoint');
  const transportSpecs = specs.filter((spec) => spec.argv.includes('protocol.ext.allow=never'));
  check(transportSpecs.length > 0 && transportSpecs.every((spec) => spec.env.GIT_SSH_COMMAND === 'ssh -oBatchMode=yes' && spec.env.GIT_TERMINAL_PROMPT === '0'), 'every real local transport receives fixed prompt/protocol policy');
} catch (error) {
  failures++; console.error(`FAIL unexpected fixture/test error: ${error.stack}`);
} finally {
  // Resolve and verify the sole cleanup target; never compute deletion from an
  // unset environment variable or remove anything outside this mkdtemp root.
  const target = resolve(scratch);
  if (target !== scratch || !target.startsWith(`${resolve(tmpdir())}/dsh-repository-operations-`)) throw new Error('unsafe scratch cleanup target');
  await rm(target, { recursive: true, force: true });
}
console.log(`\n${checks} checks, ${failures} failures`);
process.exitCode = failures ? 1 : 0;
