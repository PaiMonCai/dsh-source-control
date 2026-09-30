/**
 * The agent tool: one operation set, two callers.
 *
 * This tool and the HTTP routes call the same `SourceControlService` methods, so
 * an operation has exactly one implementation and the two callers cannot drift.
 * What differs between them is authority, and that difference is stated here:
 *
 * - **Scope.** The tool acts on the CALLING AGENT's own Session working
 *   directory. It takes no repository argument, so it cannot be pointed at a
 *   checkout the agent happens to know the path of. `assertAgentScope` ignores
 *   any `repo` a caller might smuggle in through an unlisted argument.
 * - **No discard.** The action enum carries `status`, `stage`, `unstage`, and
 *   `commit`. Discarding is irreversible and destroys uncommitted work, so it
 *   stays a human-only action in the UI; this module has no code path to it.
 */

import { GitError } from './git.js';

/** The wire name the model calls. */
export const TOOL_NAME = 'source_control';

/** The actions the model may name. `discard` is deliberately absent. */
export const ACTIONS = ['status', 'stage', 'unstage', 'diff', 'commit'];

/**
 * Lines of one diff the model is shown before the rest is cut.
 *
 * The service already refuses a diff past its own much larger cap, but a
 * 20 000-line result would swamp the context for no benefit. A cut is stated in
 * the text rather than applied silently — the same rule the rest of this package
 * follows.
 */
export const MAX_DIFF_LINES = 500;

/** Bounds one call's `paths` list, matching the route layer's cap. */
const MAX_PATHS = 2000;

/**
 * Resolve the calling agent's own Session, refusing anything else.
 *
 * Every action is scoped this way; there is no argument that widens it.
 * @param {object} exec - the tool run context.
 * @returns {string} the calling Session id.
 * @throws {GitError} code `tool/no-agent` when the call has no owning Session.
 */
export function assertAgentScope(exec) {
  const sessionId = exec?.agent?.id;
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new GitError('tool/no-agent', 'source_control requires an owning agent session');
  }
  return sessionId;
}

/**
 * Run one operation, carrying a refusal code into the message the model reads.
 *
 * The tool registry attaches a structured `{name, code}` only to its own
 * `HarnessError`, and this package cannot import that class: it is installed
 * from the workspace as a `link:`, so a bare `@deepseek-ai/...` specifier would
 * resolve against the workspace rather than the profile. Prefixing the code
 * keeps it visible instead of dropping it, while the HTTP routes keep their
 * structured envelope untouched.
 *
 * @param {() => Promise<unknown>} operation - the call to run.
 * @returns {Promise<unknown>} its result.
 * @throws {Error} the same error with its code prefixed to the message.
 */
async function run(operation) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof GitError) throw new Error(`${error.code}: ${error.message}`);
    throw error;
  }
}

/**
 * Read one action's arguments, refusing anything malformed.
 * @param {unknown} args - the model-supplied arguments.
 * @returns {{action: string, paths: string[]|undefined, message: string|undefined}} the request.
 * @throws {GitError} code `tool/invalid-arguments`.
 */
export function readArguments(args) {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new GitError('tool/invalid-arguments', 'arguments must be an object');
  }
  const action = args.action;
  if (typeof action !== 'string' || !ACTIONS.includes(action)) {
    throw new GitError('tool/invalid-arguments', `action must be one of ${ACTIONS.join(', ')}`, { action });
  }
  let paths;
  if (args.paths !== undefined) {
    if (!Array.isArray(args.paths) || args.paths.some((path) => typeof path !== 'string')) {
      throw new GitError('tool/invalid-arguments', 'paths must be an array of strings');
    }
    if (args.paths.length > MAX_PATHS) {
      throw new GitError('tool/invalid-arguments', `at most ${MAX_PATHS} paths are accepted at once`, { count: args.paths.length });
    }
    paths = args.paths;
  }
  let path;
  if (args.path !== undefined) {
    if (typeof args.path !== 'string' || args.path === '') {
      throw new GitError('tool/invalid-arguments', 'path must be a non-empty string');
    }
    path = args.path;
  }
  if (args.staged !== undefined && typeof args.staged !== 'boolean') {
    throw new GitError('tool/invalid-arguments', 'staged must be a boolean');
  }
  if (args.untracked !== undefined && typeof args.untracked !== 'boolean') {
    throw new GitError('tool/invalid-arguments', 'untracked must be a boolean');
  }
  let message;
  if (args.message !== undefined) {
    if (typeof args.message !== 'string') {
      throw new GitError('tool/invalid-arguments', 'message must be a string');
    }
    message = args.message;
  }
  if ((action === 'stage' || action === 'unstage') && (paths === undefined || paths.length === 0)) {
    throw new GitError('tool/invalid-arguments', `${action} requires at least one path`);
  }
  if (action === 'commit' && message === undefined) {
    throw new GitError('tool/invalid-arguments', 'commit requires a message');
  }
  if (action === 'diff' && path === undefined) {
    throw new GitError('tool/invalid-arguments', 'diff requires a path');
  }
  return { action, paths, path, staged: args.staged === true, untracked: args.untracked === true, message };
}

/**
 * Render one file's comparison as text the model can read.
 *
 * The hunk headers are kept verbatim so the numbers are git's own, and each line
 * keeps its `+`/`-`/space prefix. Past {@link MAX_DIFF_LINES} the rest is cut and
 * the cut is stated: a silently shortened diff reads as the whole change, which
 * is the failure mode this package refuses everywhere else.
 *
 * @param {object} value - the `diff` operation's value.
 * @returns {string} the rendered diff.
 */
export function renderDiff(value) {
  const where = value.staged ? 'staged' : value.untracked ? 'untracked' : 'unstaged';
  const head = `${value.path} (${where}) — ${value.added} added, ${value.removed} removed`;
  if (value.binary === true) return `${head}\nBinary file: no line diff.`;
  if (value.hunks.length === 0) return `${head}\nNo changes to show.`;
  const out = [head];
  let shown = 0;
  let cut = 0;
  for (const hunk of value.hunks) {
    out.push(hunk.header);
    for (const line of hunk.lines) {
      if (shown >= MAX_DIFF_LINES) {
        cut += 1;
        continue;
      }
      shown += 1;
      const marker = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : line.kind === 'meta' ? '\\' : ' ';
      out.push(`${marker}${line.text}`);
    }
  }
  if (cut > 0) out.push(`… ${cut} further line(s) cut at the ${MAX_DIFF_LINES}-line limit; read the file, or ask for a narrower path.`);
  return out.join('\n');
}

/**
 * Render one action's outcome as the single line the model reads.
 * @param {string} action - the action that ran.
 * @param {object} value - the operation's value.
 * @returns {string} the summary.
 */
export function summarize(action, value) {
  if (action === 'status') {
    const { repository, status } = value;
    const counts = [
      ['staged', status.staged.length],
      ['changed', status.changes.length],
      ['untracked', status.untracked.length],
      ['conflicted', status.conflicted.length],
    ]
      .filter(([, count]) => count > 0)
      .map(([label, count]) => `${count} ${label}`);
    const head = `On branch ${repository.branch ?? '(detached)'}${repository.hasCommits ? '' : ' (no commits yet)'}`;
    const body = counts.length === 0 ? 'Working tree clean.' : `${counts.join(', ')}.`;
    const rows = [
      ...status.staged.map((row) => `  staged    ${row.path}`),
      ...status.changes.map((row) => `  changed   ${row.path}`),
      ...status.untracked.map((row) => `  untracked ${row.path}`),
      ...status.conflicted.map((row) => `  conflict  ${row.path}`),
    ];
    return [head, body, ...rows].join('\n');
  }
  if (action === 'diff') return renderDiff(value);
  if (action === 'commit') return `Committed ${value.short}: ${value.subject}`;
  const done = value.staged ?? value.unstaged ?? value.paths ?? [];
  const skipped = value.alreadyStaged ?? value.alreadyUnstaged ?? value.unchanged ?? [];
  const lines = [`${action === 'stage' ? 'Staged' : 'Unstaged'} ${done.length} path(s).`];
  if (skipped.length > 0) lines.push(`No change to act on: ${skipped.join(', ')}`);
  return lines.join('\n');
}

/**
 * Build the tool definition.
 *
 * Hand-written rather than produced by `defineTool`: this package is installed
 * from the workspace as a `link:`, so a bare `@deepseek-ai/dsh-tools` specifier
 * would resolve against the workspace instead of the profile hosting it. The
 * shape is the registry's own `ToolDefinition` — a JSON-Schema `parameters`
 * root, an `output` carrying its canonical schema plus a pure `render`, and an
 * `execute` returning that schema's value.
 *
 * @param {object} service - the {@link import('./service.js').SourceControlService}.
 * @returns {object} a registry-ready tool definition.
 */
export function sourceControlTool(service) {
  return {
    name: TOOL_NAME,
    description:
      'Manage Git for this Session\'s own working directory: read the working-tree status, stage or unstage paths, compare one file\'s changes, and commit what is staged. Acts only on the repository of the calling Session; there is no repository argument. Discarding changes is not available here — it is irreversible, so the user performs it in the UI. Commits are local: nothing here contacts a remote.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'The operation to perform.',
          enum: [...ACTIONS],
        },
        paths: {
          type: 'array',
          description:
            'Repository-relative paths to stage or unstage, exactly as the status action reports them. Required for stage and unstage; ignored by status and commit.',
          items: { type: 'string' },
        },
        path: {
          type: 'string',
          description:
            'One repository-relative path to compare, exactly as the status action reports it. Required for diff; ignored otherwise.',
        },
        staged: {
          type: 'boolean',
          description:
            'For diff: compare the staged change instead of the unstaged one. Defaults to false.',
        },
        untracked: {
          type: 'boolean',
          description:
            'For diff: set true when the path is untracked, so it is compared against empty. Defaults to false.',
        },
        message: {
          type: 'string',
          description: 'The commit message. Required for commit; ignored otherwise.',
        },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: [...ACTIONS] },
          summary: { type: 'string' },
        },
        required: ['action', 'summary'],
      },
      /**
       * @param {object} _args - validated arguments.
       * @param {object} value - the canonical value.
       * @returns {object[]} the model-facing content.
       */
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    /**
     * Run one action against the calling agent's own repository.
     * @param {unknown} rawArgs - the model-supplied arguments.
     * @param {object} exec - the tool run context carrying the owning agent.
     * @returns {Promise<object>} `{action, summary}`.
     */
    async execute(rawArgs, exec) {
      const request = await run(async () => readArguments(rawArgs));
      // The scope is the agent's Session, and nothing else: any `repo` the model
      // sends is not read, so it cannot reach another checkout.
      const sessionId = assertAgentScope(exec);
      const signal = exec?.signal;
      const scoped = { sessionId, signal };
      const value = await run(() => {
        if (request.action === 'status') return service.status(scoped);
        if (request.action === 'stage') return service.stage({ ...scoped, paths: request.paths });
        if (request.action === 'unstage') return service.unstage({ ...scoped, paths: request.paths });
        if (request.action === 'diff') {
          return service.diff({ ...scoped, path: request.path, staged: request.staged, untracked: request.untracked });
        }
        return service.commit({ ...scoped, message: request.message });
      });
      return { action: request.action, summary: summarize(request.action, value) };
    },
    /**
     * Label the pending call in the conversation.
     * @param {object} args - validated arguments.
     * @returns {object} a generic call card.
     */
    presentCall: (args) => {
      const label =
        args.action === 'commit'
          ? 'Commit'
          : args.action === 'stage'
            ? 'Stage files'
            : args.action === 'unstage'
              ? 'Unstage files'
              : args.action === 'diff'
                ? 'Show changes'
                : 'Read Git status';
      return { card: 'generic', title: label, kind: 'other', rawInput: args };
    },
    /**
     * @returns {object} a generic result card.
     */
    presentResult: () => ({ card: 'generic', title: 'Source Control' }),
  };
}
