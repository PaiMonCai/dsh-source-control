/**
 * Public GitHub REST reader used by the Source Control Host.
 *
 * All network destinations are constructed from an allowlisted github.com
 * remote; caller-supplied URLs, tokens and arbitrary API paths are forbidden.
 * Redirects are rejected. No mutations, cookies, GitHub authentication or
 * browser-to-GitHub requests are performed here.
 */
const MAX_BODY_BYTES = 640 * 1024;
const REQUEST_TIMEOUT_MS = 10000;
const LIMIT = 30;

export class GitHubReadError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GitHubReadError';
    this.code = code;
  }
}

/** Trust only canonical URLs returned by githubRemote(), not arbitrary hosts. */
export function githubIdentity(remote) {
  const url = remote?.url;
  if (typeof url !== 'string') return null;
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(url);
  if (!match || match[1] === '.' || match[1] === '..' || match[2] === '.' || match[2] === '..') return null;
  return { owner: match[1], repo: match[2], url };
}

function stateParam(value) {
  return ['open', 'closed', 'all'].includes(value) ? value : 'open';
}

function pullNumber(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) {
    throw new GitHubReadError('github/invalid-number', 'A positive Pull Request number is required.');
  }
  return value;
}

async function readBounded(response) {
  if (Number(response.headers?.get?.('content-length')) > MAX_BODY_BYTES) {
    throw new GitHubReadError('github/response-too-large', 'GitHub response exceeds the size limit.');
  }
  if (!response.body?.getReader) {
    const content = await response.text();
    if (Buffer.byteLength(content) > MAX_BODY_BYTES) throw new GitHubReadError('github/response-too-large', 'GitHub response exceeds the size limit.');
    return content;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let result = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) throw new GitHubReadError('github/response-too-large', 'GitHub response exceeds the size limit.');
      result += decoder.decode(value, { stream: true });
    }
    return result + decoder.decode();
  } finally {
    reader.releaseLock();
    if (bytes > MAX_BODY_BYTES) await reader.cancel().catch(() => {});
  }
}

function text(value, max = 1200) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function user(value) {
  return text(value?.login, 100);
}

function pullRow(item) {
  return {
    number: item.number,
    title: text(item.title, 500),
    state: item.state === 'closed' ? 'closed' : 'open',
    draft: item.draft === true,
    author: user(item.user),
    createdAt: text(item.created_at, 40),
    updatedAt: text(item.updated_at, 40),
    url: text(item.html_url, 300),
    head: text(item.head?.ref, 250),
    base: text(item.base?.ref, 250),
  };
}

function issueRow(item) {
  return {
    number: item.number,
    title: text(item.title, 500),
    state: item.state === 'closed' ? 'closed' : 'open',
    author: user(item.user),
    createdAt: text(item.created_at, 40),
    labels: Array.isArray(item.labels) ? item.labels.slice(0, 8).map((label) => text(label.name, 60)) : [],
    url: text(item.html_url, 300),
  };
}

export function createGitHubReader({ fetchImpl = globalThis.fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation required');
  async function request(identity, endpoint, signal) {
    const repo = githubIdentity(identity);
    if (repo === null) throw new GitHubReadError('github/not-configured', 'Select a repository with a recognized GitHub remote.');
    // The endpoint is assembled internally, never received as a URL from UI.
    const url = `https://api.github.com/repos/${repo.owner}/${repo.repo}/${endpoint}`;
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (signal) signals.push(signal);
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'error',
        credentials: 'omit',
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'dsh-source-control',
        },
        signal: AbortSignal.any(signals),
      });
    } catch (error) {
      if (signal?.aborted) throw new GitHubReadError('github/aborted', 'GitHub request was cancelled.');
      if (signals[0].aborted) throw new GitHubReadError('github/timeout', 'GitHub took too long to respond.');
      throw new GitHubReadError('github/unavailable', 'GitHub could not be reached from the DSH host.');
    }
    if (response.status === 401 || response.status === 403) {
      throw new GitHubReadError('github/not-authorized', 'Public GitHub API access was refused or rate-limited; try again later.');
    }
    if (response.status === 404) {
      throw new GitHubReadError('github/not-found', 'The GitHub resource is unavailable publicly; private repositories require future account authorization.');
    }
    if (!response.ok) throw new GitHubReadError('github/upstream', `GitHub returned HTTP ${response.status}.`);
    let payload;
    try { payload = JSON.parse(await readBounded(response)); }
    catch (error) {
      if (error instanceof GitHubReadError) throw error;
      throw new GitHubReadError('github/invalid-response', 'GitHub returned an invalid response.');
    }
    return payload;
  }

  return {
    async pulls(identity, { state, signal } = {}) {
      const data = await request(identity, `pulls?state=${stateParam(state)}&sort=updated&direction=desc&per_page=${LIMIT}`, signal);
      if (!Array.isArray(data)) throw new GitHubReadError('github/invalid-response', 'GitHub returned an unexpected Pull Request list.');
      return { items: data.slice(0, LIMIT).filter((item) => Number.isSafeInteger(item.number)).map(pullRow), limit: LIMIT };
    },
    async issues(identity, { state, signal } = {}) {
      const data = await request(identity, `issues?state=${stateParam(state)}&sort=updated&direction=desc&per_page=${LIMIT}`, signal);
      if (!Array.isArray(data)) throw new GitHubReadError('github/invalid-response', 'GitHub returned an unexpected Issue list.');
      return { items: data.filter((item) => !item.pull_request && Number.isSafeInteger(item.number)).slice(0, LIMIT).map(issueRow), limit: LIMIT };
    },
    async pullDetail(identity, { number, signal } = {}) {
      const id = pullNumber(number);
      const pull = await request(identity, `pulls/${id}`, signal);
      if (pull.number !== id) throw new GitHubReadError('github/invalid-response', 'GitHub returned a mismatched Pull Request.');
      const sha = pull.head?.sha;
      const [files, checks] = await Promise.all([
        request(identity, `pulls/${id}/files?per_page=100`, signal),
        typeof sha === 'string' && /^[a-f0-9]{40}$/.test(sha)
          ? request(identity, `commits/${sha}/check-runs?per_page=100`, signal).catch((error) => {
              // Some public repositories expose PRs but not checks. Keep review available.
              if (['github/not-authorized', 'github/not-found'].includes(error.code)) return { check_runs: [], unavailable: true };
              throw error;
            })
          : Promise.resolve({ check_runs: [], unavailable: true }),
      ]);
      if (!Array.isArray(files)) throw new GitHubReadError('github/invalid-response', 'GitHub returned an unexpected changed-file list.');
      const list = files.slice(0, 100).map((file) => ({
        filename: text(file.filename, 400),
        status: text(file.status, 50),
        additions: Number.isSafeInteger(file.additions) ? file.additions : 0,
        deletions: Number.isSafeInteger(file.deletions) ? file.deletions : 0,
        patch: text(file.patch, 14000),
        truncated: typeof file.patch === 'string' && file.patch.length > 14000,
      }));
      const runs = Array.isArray(checks.check_runs) ? checks.check_runs.slice(0, 100).map((run) => ({
        name: text(run.name, 200),
        status: text(run.status, 40),
        conclusion: text(run.conclusion, 40),
        url: text(run.html_url, 300),
      })) : [];
      return {
        pull: { ...pullRow(pull), body: text(pull.body, 4500), merged: pull.merged === true, changedFiles: pull.changed_files ?? list.length },
        files: list,
        checks: runs,
        checksUnavailable: checks.unavailable === true,
        filesLimited: files.length === 100,
      };
    },
  };
}
