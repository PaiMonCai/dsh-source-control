/**
 * Verification for the Host plugin wiring.
 *
 * Loads `lib/index.js` against a faithful fake Cordis context and asserts what
 * the plugin registers on the live seams: the twenty-three exact Fetch routes on
 * `ctx.connection.fetch`, the `session/event` listener that invalidates the
 * repository cache, and full disposal of every registration.
 *
 * This check matters because a real request cannot distinguish a missing route
 * from an unauthenticated one: the browser-session fence answers 401 for every
 * path below `/api`.
 *
 * Run with:
 *
 *     node verify/apply.mjs
 */
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply, resolveConfig } from '../lib/index.js';
import { ROUTE_PREFIX } from '../lib/routes.js';

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
 * Call a function and return the thrown message, or null.
 * @param {Function} run - the call.
 * @returns {Promise<string|null>} the message.
 */
async function thrownMessage(run) {
  try {
    await run();
    return null;
  } catch (error) {
    return error.message;
  }
}

/** Build a fake Cordis context recording every registration the plugin makes. */
function createContext() {
  const state = { fetchRoutes: [], listeners: [], effects: [], disposed: [], logs: [], tools: [], injects: [] };
  const ctx = {
    subprocess: {
      /**
       * @param {string} command - command name.
       * @returns {Promise<string>} the command as given.
       */
      async resolveExecutable(command) {
        return command;
      },
    },
    sessions: {
      /**
       * @param {string} id - session id.
       * @returns {object|undefined} the session.
       */
      get: (id) => (id === 's1' ? { id: 's1', header: { cwd: '/tmp' } } : undefined),
      /** @returns {object[]} every session. */
      list: () => [{ id: 's1', header: { cwd: '/tmp' } }],
    },
    logger: {
      /** @param {string} message - the message. */
      info: (message) => state.logs.push(message),
      /** @param {string} message - the message. */
      warn: (message) => state.logs.push(message),
      /** @param {string} message - the message. */
      error: (message) => state.logs.push(message),
    },
    connection: {
      fetch: {
        /**
         * @param {object} route - the route.
         * @returns {Promise<Function>} the disposer.
         */
        async register(route) {
          state.fetchRoutes.push(route);
          return async () => {
            state.disposed.push(route.path);
          };
        },
      },
    },
    tools: {
      /**
       * @param {object} definition - the tool definition.
       * @returns {Function} the disposer.
       */
      register(definition) {
        state.tools.push(definition);
        return () => {};
      },
    },
    /**
     * Optional-inject seam: the callback runs only when every named service is
     * present, which is how the tool stays optional.
     * @param {string[]} services - required service names.
     * @param {Function} callback - the body.
     * @returns {Function} the disposer.
     */
    inject(services, callback) {
      state.injects.push([...services]);
      const available = services.every((name) => name !== 'tools' || state.toolsAvailable !== false);
      if (available) callback({ tools: this.tools, effect: this.effect.bind(this) });
      return () => {};
    },
    /**
     * @param {Function} callback - the effect body.
     * @param {string} [label] - the effect label.
     * @returns {Function} the disposer.
     */
    effect(callback, label) {
      state.effects.push({ label, cleanup: callback() });
      return () => {};
    },
    /**
     * @param {string} event - the event name.
     * @param {Function} listener - the listener.
     * @returns {Function} the unsubscribe callback.
     */
    on(event, listener) {
      state.listeners.push({ event, listener });
      return () => {};
    },
  };
  return { ctx, state };
}

const scratch = await realpath(await mkdtemp(join(tmpdir(), 'dsh-source-control-apply-')));
await mkdir(scratch, { recursive: true });

console.log('## config');
check(resolveConfig(undefined).timeoutMs === 30000, 'absent config takes the documented default');
check(resolveConfig({ maxLogEntries: 5 }).maxLogEntries === 5, 'a provided field overrides its default');
const nonPositive = await thrownMessage(() => resolveConfig({ timeoutMs: 0 }));
check(typeof nonPositive === 'string' && nonPositive.includes('timeoutMs'), 'a non-positive field is rejected', nonPositive);
const unknown = await thrownMessage(() => resolveConfig({ unknownField: 1 }));
check(typeof unknown === 'string' && unknown.includes('unknownField'), 'an unknown field is rejected', unknown);

console.log('\n## wiring');
const { ctx, state } = createContext();
apply(ctx, {});
// `registerRoutes` is async and its promise is held by the effect; give it a turn.
await new Promise((resolve) => setTimeout(resolve, 50));

check(state.fetchRoutes.length === 23, 'apply registers exactly twenty-three Fetch routes', state.fetchRoutes.length);
const paths = state.fetchRoutes.map((route) => route.path);
for (const operation of ['git', 'status', 'diff', 'log', 'stage', 'unstage', 'discard', 'commit', 'stage-hunk', 'unstage-hunk', 'discard-hunk',
  'branches', 'graph', 'commit-details', 'commit-diff',
  'switch-branch', 'create-branch', 'fetch', 'pull', 'push',
  'github-pulls', 'github-issues', 'github-pull-detail']) {
  check(paths.includes(`${ROUTE_PREFIX}/${operation}`), `the ${operation} route is registered`);
}
check(
  state.fetchRoutes.every((route) => route.methods.length > 0 && route.requestBody === 'buffered'),
  'every route declares a method and buffered bodies',
);
check(state.fetchRoutes.every((route) => typeof route.fetch === 'function'), 'every route carries a Fetch handler');
check(
  state.listeners.some((entry) => entry.event === 'session/event'),
  'apply listens on session/event to invalidate the repository cache',
);
check(state.logs.length === 0, 'apply logs no error', state.logs);

console.log('\n## the agent tool');
check(state.injects.some((names) => names.includes('tools')), 'the tool rides an optional inject', state.injects);
check(state.tools.length === 1, 'apply registers exactly one tool', state.tools.length);
check(state.tools[0]?.name === 'source_control', 'the tool is source_control', state.tools[0]?.name);
check(typeof state.tools[0]?.execute === 'function', 'the registered tool is executable');
check(/discard/.test(JSON.stringify(state.tools[0]?.parameters)) === false, 'the tool exposes no discard action');

console.log('\n## a handler answers an envelope');
const statusRoute = state.fetchRoutes.find((route) => route.path.endsWith('/status'));
const response = await statusRoute.fetch(new Request(`http://localhost${ROUTE_PREFIX}/status`, { method: 'GET' }));
const body = await response.json();
check(response.status === 200, 'a handler answers HTTP 200', response.status);
check(response.headers.get('content-type')?.includes('application/json') === true, 'the response is JSON');
check(body.ok === true || typeof body.error?.code === 'string', 'the body carries the envelope', body);

console.log('\n## disposal');
let cleaned = 0;
for (const effect of state.effects) {
  if (typeof effect.cleanup === 'function') {
    await effect.cleanup();
    cleaned += 1;
  }
}
check(cleaned === state.effects.length, 'every effect exposes a cleanup', { cleaned, total: state.effects.length });
check(state.disposed.length === 23, 'disposal withdraws every registered route', state.disposed.length);

console.log('\n## a composition without the tools registry still loads');
const { ctx: ctx3, state: state3 } = createContext();
state3.toolsAvailable = false;
apply(ctx3, {});
await new Promise((resolve) => setTimeout(resolve, 50));
check(state3.fetchRoutes.length === 23, 'the routes still register without a tools registry', state3.fetchRoutes.length);
check(state3.tools.length === 0, 'no tool is registered when tools is absent', state3.tools.length);

console.log('\n## absent git is a reported state, not a load failure');
const { ctx: ctx2, state: state2 } = createContext();
ctx2.subprocess.resolveExecutable = async () => {
  throw new Error('not found');
};
apply(ctx2, {});
await new Promise((resolve) => setTimeout(resolve, 50));
check(state2.fetchRoutes.length === 23, 'routes still register when git is missing', state2.fetchRoutes.length);
const gitBody = await (
  await state2.fetchRoutes.find((route) => route.path.endsWith('/git')).fetch(new Request(`http://localhost${ROUTE_PREFIX}/git`))
).json();
check(gitBody.value?.available === false, 'the git route reports git as unavailable', gitBody);

await rm(scratch, { recursive: true, force: true });
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
