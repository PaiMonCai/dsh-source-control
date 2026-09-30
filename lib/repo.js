/**
 * Repository resolution and the single path-containment guard.
 *
 * Every path that reaches git must pass through {@link assertInside} first.
 * The guard is deliberately conservative: it rejects anything it cannot prove
 * stays inside the repository, including symbolic links that resolve outside it
 * and absolute paths that merely share a prefix with the root.
 */
import { realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { GitError } from './git.js';

/**
 * Whether `child` is the root itself or lies beneath it, by path segments.
 *
 * A string-prefix test is not enough: `/repo-other` must not pass for `/repo`.
 *
 * @param {string} root - absolute repository root.
 * @param {string} child - absolute candidate.
 * @returns {boolean} containment.
 */
export function isInside(root, child) {
  if (child === root) return true;
  return child.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/**
 * Resolve the deepest existing directory at or above a path, so containment can
 * be checked against the real filesystem even when the leaf does not exist yet.
 * @param {string} absolute - absolute path.
 * @returns {Promise<string>} the real path of the nearest existing ancestor directory.
 */
async function realAncestorDir(absolute) {
  let current = absolute;
  for (;;) {
    try {
      return await realpath(current);
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
      const parent = resolve(current, '..');
      if (parent === current) return absolute;
      current = parent;
    }
  }
}

/**
 * Prove that one caller-supplied path stays inside the repository, then return
 * its repository-relative form.
 *
 * The check resolves the path's nearest existing ancestor directory through the
 * real filesystem, so a directory symbolic link escaping the repository is
 * rejected, while a leaf symbolic link is allowed: git stores a link as its own
 * blob and replaces it on restore, so such a path never writes through to the
 * link's target. A path whose parent directory does not exist is accepted, because
 * a file deleted together with its directory is a legitimate change that
 * `git restore` recreates.
 *
 * Rejected: a path that escapes through `..`; an absolute path outside the root;
 * a path whose real ancestor directory leaves the root; the root itself; an empty
 * path; a trailing slash; and a path containing a NUL byte.
 *
 * @param {string} root - absolute repository root.
 * @param {string} candidate - repository-relative or absolute path from the caller.
 * @returns {Promise<string>} the path git receives, relative to the root.
 * @throws {GitError} code `path/outside-repository` or `path/invalid`.
 */
export async function assertInside(root, candidate) {
  if (typeof candidate !== 'string' || candidate === '') {
    throw new GitError('path/invalid', 'a path is required');
  }
  if (candidate.includes('\u0000')) {
    throw new GitError('path/invalid', 'a path may not contain a NUL byte');
  }
  if (candidate.endsWith('/') || candidate.endsWith(sep)) {
    throw new GitError('path/invalid', `${candidate} is a directory, not a file`, { path: candidate });
  }
  const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
  if (!isInside(root, absolute)) {
    throw new GitError('path/outside-repository', `${candidate} is outside the repository`, { path: candidate });
  }
  const relativePath = relative(root, absolute);
  if (relativePath === '' || relativePath.startsWith('..')) {
    // The repository root itself is never a valid file argument.
    throw new GitError('path/invalid', `${candidate} is not a file within the repository`, { path: candidate });
  }
  // Nothing this plugin offers acts on git's own metadata, and a path inside
  // `.git/` can name a hook, a config file, or an object. Refusing the whole
  // directory keeps the guard's promise ("a file within the repository") honest
  // and removes the class rather than relying on each operation to be harmless.
  const firstSegment = relativePath.split(/[\\/]/, 1)[0];
  if (firstSegment === '.git') {
    throw new GitError('path/invalid', `${candidate} is inside the repository's .git directory`, { path: candidate });
  }
  const realParent = await realAncestorDir(resolve(absolute, '..'));
  if (realParent !== root && !isInside(root, realParent)) {
    throw new GitError('path/outside-repository', `${candidate} resolves outside the repository`, {
      path: candidate,
      resolved: realParent,
    });
  }
  return relativePath;
}

/**
 * Locate the repository root enclosing one working directory.
 *
 * A directory outside any repository is a state the UI reports (`not-a-repository`),
 * not an error: a Session whose cwd is not a checkout is a normal case.
 *
 * @param {object} git - a `GitRunner`.
 * @param {object} io - `{cwd, signal}`.
 * @returns {Promise<{root: string, gitDir: string}|null>} the located repository, or null when there is none.
 * @throws {GitError} when git itself could not be run.
 */
export async function resolveRepository(git, { cwd, signal }) {
  const result = await git.run(['rev-parse', '--show-toplevel', '--absolute-git-dir'], { cwd, signal });
  if (result.exitCode !== 0) {
    if (/not a git repository/i.test(result.stderr)) return null;
    throw new GitError('git/failed', `git rev-parse failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`, {
      exitCode: result.exitCode,
    });
  }
  const [top, gitDir] = result.stdout.split('\n');
  const root = top?.trim();
  if (!root) return null;
  let canonical;
  try {
    canonical = await realpath(root);
  } catch {
    canonical = resolve(root);
  }
  return { root: canonical, gitDir: gitDir?.trim() ?? join(canonical, '.git') };
}
