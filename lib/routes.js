/**
 * The HTTP surface the browser half calls.
 *
 * Routes are registered on `ctx.connection.fetch`, which mounts them on the
 * authenticated `/api` channel: Connection applies its Host/Origin fence and the
 * browser-session cookie check before a handler runs, so this module owns no
 * authentication code. Every route answers the same JSON envelope —
 * `{ok: true, value}` or `{ok: false, error: {code, message, details}}` — with
 * HTTP 200 either way, because a business refusal such as "nothing is staged" is
 * a result, not a transport failure.
 *
 * Reads inspect only local repository data. Network operations are explicit
 * authenticated POST routes, never automatic side effects of reads.
 */
import { GitError } from './git.js';
import { GitHubReadError } from './github-api.js';

/** Where every route lives, below the authenticated `/api` channel. */
export const ROUTE_PREFIX = '/api/source-control';

/**
 * Write one JSON response.
 * @param {number} status - HTTP status.
 * @param {object} body - JSON body.
 * @returns {Response} the response.
 */
function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/**
 * Turn any thrown value into the failure envelope.
 * @param {unknown} error - the thrown value.
 * @returns {Response} a 200 response carrying the failure.
 */
function failure(error) {
  if (error instanceof GitError || error instanceof GitHubReadError) {
    return json(200, {
      ok: false,
      error: { code: error.code, message: error.message, details: error.details ?? {} },
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  return json(200, { ok: false, error: { code: 'internal', message, details: {} } });
}

/**
 * Read the JSON body of a POST request.
 * @param {Request} request - the incoming request.
 * @returns {Promise<object>} the parsed body.
 * @throws {GitError} code `request/invalid-body` when the body is not a JSON object.
 */
async function readBody(request) {
  let parsed;
  try {
    parsed = await request.json();
  } catch {
    throw new GitError('request/invalid-body', 'the request body is not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new GitError('request/invalid-body', 'the request body must be a JSON object');
  }
  return parsed;
}

/**
 * Read the session/repository selector shared by every route.
 *
 * The sidebar tab sends `sessionId` (its repository follows the Session); the
 * main page sends `repo` (its own picker chose a directory).
 *
 * @param {URL} url - the request URL.
 * @param {object} body - the parsed body, for POST routes.
 * @returns {object} `{sessionId, repo}`.
 * @throws {GitError} code `request/invalid-selector` when neither is present.
 */
function selector(url, body = {}) {
  const sessionId = body.sessionId ?? url.searchParams.get('sessionId') ?? undefined;
  const repo = body.repo ?? url.searchParams.get('repo') ?? undefined;
  if ((sessionId === undefined || sessionId === '') && (repo === undefined || repo === '')) {
    throw new GitError('request/invalid-selector', 'a sessionId or a repo is required');
  }
  return { sessionId: sessionId ?? undefined, repo: repo ?? undefined };
}

/**
 * Build the route table.
 *
 * Every entry is `{path, methods, requestBody, read}` where `read` is `true` for
 * operations that never mutate the repository. That flag is the authority
 * boundary: it is the only thing that distinguishes a read from a write, so a
 * reviewer can enumerate every mutation by looking for `read: false`.
 *
 * @param {object} service - the {@link import('./service.js').SourceControlService}.
 * @returns {object[]} route descriptors.
 */
export function routeTable(service) {
  return [
    {
      path: `${ROUTE_PREFIX}/git`,
      methods: ['GET'],
      requestBody: 'buffered',
      read: true,
      /**
       * Report git availability and the pickable repositories.
       * @param {object} io - `{signal}`.
       * @returns {Promise<object>} the discovery payload.
       */
      handle: ({ signal }) => service.describe({ signal }),
    },
    {
      path: `${ROUTE_PREFIX}/status`,
      methods: ['GET'],
      requestBody: 'buffered',
      read: true,
      /**
       * The working-tree summary.
       * @param {object} io - `{url, body, signal}`.
       * @returns {Promise<object>} `{repository, status}`.
       */
      handle: ({ url, body, signal }) => service.status({ ...selector(url, body), signal }),
    },
    {
      path: `${ROUTE_PREFIX}/diff`,
      methods: ['GET'],
      requestBody: 'buffered',
      read: true,
      /**
       * One file's comparison against the index or HEAD.
       * @param {object} io - `{url, body, signal}`.
       * @returns {Promise<object>} the parsed diff.
       */
      handle: ({ url, body, signal }) =>
        service.diff({
          ...selector(url, body),
          path: url.searchParams.get('path'),
          staged: url.searchParams.get('staged') === 'true',
          untracked: url.searchParams.get('untracked') === 'true',
          signal,
        }),
    },
    {
      path: `${ROUTE_PREFIX}/log`,
      methods: ['GET'],
      requestBody: 'buffered',
      read: true,
      /**
       * Recent commits, newest first.
       * @param {object} io - `{url, body, signal}`.
       * @returns {Promise<object>} `{commits}`.
       */
      handle: ({ url, body, signal }) => {
        const skip = Number(url.searchParams.get('skip') ?? 0);
        return service.log({ ...selector(url, body), skip, signal });
      },
    },
    ...[
      ['branches', 'branches'],
      ['graph', 'graph'],
      ['commit-details', 'commitDetails'],
      ['commit-diff', 'commitDiff'],
    ].map(([segment, method]) => ({
      path: `${ROUTE_PREFIX}/${segment}`,
      methods: ['GET'],
      requestBody: 'buffered',
      read: true,
      handle: ({ url, body, signal }) => {
        const request = { ...selector(url, body), signal };
        if (method === 'graph') {
          const raw = url.searchParams.get('skip');
          if (raw !== null && !/^\d+$/.test(raw)) {
            throw new GitError('request/invalid-argument', 'skip must be a nonnegative integer');
          }
          request.skip = raw === null ? 0 : Number(raw);
        }
        if (method === 'commitDetails' || method === 'commitDiff') request.hash = url.searchParams.get('hash');
        if (method === 'commitDiff') request.path = url.searchParams.get('path');
        return service[method](request);
      },
    })),
    ...[
      ['switch-branch', 'switchBranch', ['branch', 'remoteBranch']],
      ['create-branch', 'createBranch', ['branch']],
      ['fetch', 'fetch', ['remote']],
      ['pull', 'pull', ['remote', 'branch', 'sourceBranch']],
      ['push', 'push', ['remote', 'branch', 'setUpstream', 'sourceBranch']],
    ].map(([segment, method, fields]) => ({
      path: `${ROUTE_PREFIX}/${segment}`,
      methods: ['POST'],
      requestBody: 'buffered',
      read: false,
      handle: ({ url, body, signal }) => {
        const request = { ...selector(url, body), signal };
        for (const field of fields) request[field] = body[field];
        return service[method](request);
      },
    })),
    // Pure reads. No GitHub Token and no Git mutations from these endpoints.
    ...[
      ['github-pulls', 'githubPulls'],
      ['github-issues', 'githubIssues'],
      ['github-pull-detail', 'githubPullDetail'],
    ].map(([segment, method]) => ({
      path: `${ROUTE_PREFIX}/${segment}`,
      methods: ['GET'],
      requestBody: 'buffered',
      read: true,
      handle: ({ url, body, signal }) => {
        const request = { ...selector(url, body), signal };
        if (method === 'githubPullDetail') {
          const number = url.searchParams.get('number');
          if (!/^[1-9]\d{0,9}$/.test(number ?? '')) throw new GitError('request/invalid-argument', 'number must be a positive PR number');
          request.number = Number(number);
        } else {
          request.state = url.searchParams.get('state') ?? 'open';
        }
        return service[method](request);
      },
    })),
    {
      path: `${ROUTE_PREFIX}/stage`,
      methods: ['POST'],
      requestBody: 'buffered',
      read: false,
      /**
       * Stage paths.
       * @param {object} io - `{url, body, signal}`.
       * @returns {Promise<object>} the stage outcome.
       */
      handle: ({ url, body, signal }) => service.stage({ ...selector(url, body), paths: body.paths ?? [], signal }),
    },
    {
      path: `${ROUTE_PREFIX}/unstage`,
      methods: ['POST'],
      requestBody: 'buffered',
      read: false,
      /**
       * Unstage paths, leaving the working tree as it is.
       * @param {object} io - `{url, body, signal}`.
       * @returns {Promise<object>} the unstage outcome.
       */
      handle: ({ url, body, signal }) => service.unstage({ ...selector(url, body), paths: body.paths ?? [], signal }),
    },
    {
      path: `${ROUTE_PREFIX}/discard`,
      methods: ['POST'],
      requestBody: 'buffered',
      read: false,
      /**
       * Discard uncommitted changes. Reachable only from here: the agent tool
       * has no discard action, because the operation is irreversible.
       * @param {object} io - `{url, body, signal}`.
       * @returns {Promise<object>} `{restored, removed, unchanged}`.
       */
      handle: ({ url, body, signal }) => service.discard({ ...selector(url, body), paths: body.paths ?? [], signal }),
    },
    ...[
      ['stage-hunk', 'stageHunk', 'Stage one hunk of a path\'s unstaged change.'],
      ['unstage-hunk', 'unstageHunk', 'Unstage one hunk of a path\'s staged change.'],
      ['discard-hunk', 'discardHunk', 'Discard one hunk of a path\'s unstaged change. Reachable only from here: the agent tool has no hunk discard.'],
    ].map(([segment, method, description]) => ({
      path: `${ROUTE_PREFIX}/${segment}`,
      methods: ['POST'],
      requestBody: 'buffered',
      read: false,
      /**
       * The caller names a path and a hunk NUMBER; the patch itself is rebuilt on
       * the Host from live git output, so no caller supplies patch text.
       * @param {object} io - `{url, body, signal}`.
       * @returns {Promise<object>} `{path, hunkIndex, total}`.
       */
      handle: ({ url, body, signal }) =>
        service[method]({ ...selector(url, body), path: body.path, hunkIndex: body.hunkIndex, signal }),
      description,
    })),
    {
      path: `${ROUTE_PREFIX}/commit`,
      methods: ['POST'],
      requestBody: 'buffered',
      read: false,
      /**
       * Commit the staged index.
       * @param {object} io - `{url, body, signal}`.
       * @returns {Promise<object>} `{hash, short, subject}`.
       */
      handle: ({ url, body, signal }) => service.commit({ ...selector(url, body), message: body.message, signal }),
    },
  ];
}

/**
 * Register every route for the caller's lifetime.
 *
 * Each registration returns a disposer Connection owns; keeping them inside the
 * caller's own `ctx.effect` means unloading the plugin withdraws the whole HTTP
 * surface with it.
 *
 * @param {object} ctx - the Host context carrying `connection`.
 * @param {object} service - the service the routes operate on.
 * @returns {Promise<() => Promise<void>>} disposer for every route.
 */
export async function registerRoutes(ctx, service) {
  const disposers = [];
  for (const route of routeTable(service)) {
    const dispose = await ctx.connection.fetch.register({
      path: route.path,
      methods: route.methods,
      requestBody: route.requestBody,
      /**
       * Handle one admitted request.
       * @param {Request} request - the authenticated request.
       * @returns {Promise<Response>} the envelope response.
       */
      fetch: async (request) => {
        try {
          const url = new URL(request.url);
          // A write route always reads its JSON body; a read route may still
          // receive one, and a malformed body is a request error either way.
          const body = route.methods.includes('POST') ? await readBody(request) : {};
          const value = await route.handle({ url, body, signal: request.signal });
          return json(200, { ok: true, value });
        } catch (error) {
          return failure(error);
        }
      },
    });
    disposers.push(dispose);
  }
  return async () => {
    for (const dispose of disposers.reverse()) await dispose();
  };
}
