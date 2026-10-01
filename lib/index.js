/**
 * Host half of the Source Control bundle.
 *
 * Owns three things and nothing else:
 * - the git capability (argv-only, explicit human-triggered remote operations),
 * - the repository/path authority boundary,
 * - the authenticated `/api/source-control/*` routes the browser half calls.
 *
 * `ctx.connection.fetch` mounts the routes on the `/api` channel, so Connection
 * applies its Host/Origin fence and browser-session authentication before any
 * handler runs; this plugin carries no authentication code of its own.
 *
 * The package deliberately imports nothing: it is installed from the workspace as
 * a `link:`, so a bare specifier would resolve against the workspace rather than
 * against the profile that hosts it. Configuration is therefore validated here
 * instead of through a schema library.
 */
import { registerRoutes } from './routes.js';
import { SourceControlService } from './service.js';
import { TOOL_NAME, sourceControlTool } from './tool.js';

/** Cordis services this plugin cannot work without. */
export const inject = ['subprocess', 'sessions', 'connection'];

/** Every configuration field, with the default the plugin applies when absent. */
const DEFAULTS = {
  /** Milliseconds one git command may run before it is abandoned. */
  timeoutMs: 30000,
  /** Bytes of stdout retained per command; a larger diff is refused, never truncated. */
  maxOutputBytes: 8 * 1024 * 1024,
  /** Lines one file's diff may carry before the viewer is told it is too large. */
  maxDiffLines: 20000,
  /** Commits returned by the history view. */
  maxLogEntries: 50,
};

/**
 * Merge one row's raw config over the defaults, rejecting a malformed value.
 * @param {object|undefined} raw - the row's `config` from `cordis.patch.yml`.
 * @returns {object} the complete, validated config.
 * @throws {Error} when a field is present but not a positive finite number.
 */
function resolveConfig(raw) {
  const config = { ...DEFAULTS };
  for (const field of Object.keys(DEFAULTS)) {
    const value = raw?.[field];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
      throw new Error(`source-control requires a positive integer ${field}, got ${JSON.stringify(value)}`);
    }
    config[field] = value;
  }
  for (const field of Object.keys(raw ?? {})) {
    if (!(field in DEFAULTS)) throw new Error(`source-control has no configuration field ${field}`);
  }
  return config;
}

/**
 * Mount the git capability and its HTTP surface.
 * @param {object} ctx - Host context carrying `subprocess`, `sessions`, `connection`.
 * @param {object} [raw] - the row's config; absent fields take their default.
 */
export function apply(ctx, raw) {
  const config = resolveConfig(raw);
  const service = new SourceControlService(ctx, config);

  // A Session's repository is resolved from its header on first use; a finished
  // turn is the point at which the working directory may have become (or stopped
  // being) a repository, so the cached fact is dropped there.
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/end') service.invalidate(session.id);
  });

  ctx.effect(() => {
    let dispose = null;
    let disposed = false;
    registerRoutes(ctx, service).then(
      (teardown) => {
        if (disposed) teardown().catch(() => {});
        else dispose = teardown;
      },
      (error) => ctx.logger.error(`source-control: routes failed to register: ${String(error)}`),
    );
    return async () => {
      disposed = true;
      if (dispose !== null) await dispose();
    };
  }, 'source-control: /api/source-control routes');

  // The agent tool rides an OPTIONAL inject: a composition without the tools
  // registry still loads this plugin, it simply has no agent-facing surface.
  // Registering it globally means every agent sees it; the tool itself bounds
  // every call to the calling agent's own Session.
  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.effect(() => toolCtx.tools.register(sourceControlTool(service)), 'source-control: agent tool');
  });

  ctx.effect(() => {
    return () => service.invalidate();
  }, 'source-control: repository cache');
}

export { ROUTE_PREFIX } from './routes.js';
export { SourceControlService } from './service.js';
export { createOperations, GitRunner, parseStatus, parseDiff } from './git.js';
export { assertInside, isInside, resolveRepository } from './repo.js';
export { DEFAULTS, resolveConfig };
export { TOOL_NAME, ACTIONS, sourceControlTool, summarize, readArguments } from './tool.js';
