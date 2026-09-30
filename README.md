# dsh-source-control

VS Code-style **Source Control** for the DeepSeek Harness Web UI: manage the Git
repository of a Session's working directory without leaving the app.

Two surfaces over one panel:

- a **Source Control tab** in the right sidebar, whose repository follows the
  Session the tab lives in, and
- a **Source Control page** in the main column, with its own repository picker
  and the commit history, reached from a sidebar icon.

Both offer: branch display with ahead/behind counts, Staged / Changes /
Untracked / Conflicts groups, per-file stage, unstage, discard (with a
confirmation dialog), **per-hunk** stage, unstage, and discard from the diff
viewer, a diff viewer with old/new line numbers, a commit message box, and
commit history.

## Agent tool

`source_control` exposes the same operations to the agent, through the same
service methods the UI calls — one implementation, two callers:

| | |
|---|---|
| Actions | `status`, `stage`, `unstage`, `diff`, `commit` |
| Scope | the **calling agent's own Session working directory**; there is no repository argument, so it cannot be pointed at another checkout |
| Not available | `discard` — irreversible, so it stays a human-only action in the UI |

`diff` returns one file's comparison — hunk headers verbatim, `+`/`-`/space
prefixes kept — so the agent can read a change before writing a commit message.
Past `MAX_DIFF_LINES` (500) the rest is cut and the cut is **stated with its
count**, because a silently shortened diff reads as the whole change.

It is registered through an optional inject, so a composition without the tools
registry still loads the plugin and simply has no agent-facing surface.

A refusal reaches the model with its code prefixed to the message
(`repo/not-a-repository: …`). The tool registry attaches a structured `code` only
to its own `HarnessError`, which this package cannot import — it is installed
from the workspace as a `link:`, so a bare `@deepseek-ai/...` specifier would
resolve against the workspace instead of the profile. The HTTP routes keep their
structured envelope untouched.

## Scope boundary

**Commits are local.** There is no `fetch`, `pull`, `push`, `remote`, or `clone`
anywhere in this package — no route and no code path — so nothing here can
contact a network or touch a remote. Adding one is a deliberate design change,
not a configuration toggle.

Staging is **whole-file**. Per-hunk staging, amend, rebase, merge, stash, and
branch/tag operations are out of scope.

## Install

```
plugin_manager install_bundle /workspace/dsh-source-control
```

> The package directory must stay where it was installed: `plugin_manager` links
> it into the profile, so moving or deleting it breaks the bundle.

If the profile was already running, the bundle selection lands in
`package.json` but its fiber may stay inactive. Toggle the bundle off and on
(`plugin_manager set_bundle`) to apply it live, or restart `dsh web`.

Verify it is live rather than merely saved:

- `cordis_inspect_query` → host `Config.listConfigs` with `name:
  "dsh-source-control"` should list the `include:source-control` entry;
- `cordis_inspect_query` → client `Slots.listSubTree` should show an active
  occupant keyed `dsh-source-control` in `sidebar.right.pane.tab`, an active
  `source-control` key in `main`, and `source-control` in `sidebar.panellist`.

### Making a change live

Host-side and client-side code have different rules, and the difference is easy
to get wrong:

- **Client (`lib/client.js`)** — the bundle is served under a content-addressed
  revision, so a page refresh picks up a change.
- **Host (`lib/index.js` and everything it imports)** — only loaded at process
  start. The loader's `import()` is not cache-busted and Node's ESM cache is keyed
  by URL, so re-importing returns the module already evaluated. **A change here
  needs a `dsh web` restart.**

The profile ships `hmr.config.root: []`, which disables module watching
altogether. This package's `cordis.patch.yml` note in the profile patch sets a
scoped root so watching is on:

```yaml
- id: hmr
  config:
    root:
      - /workspace/dsh-source-control
```

With that in place, touching `lib/index.js` reloads the entry, and HMR
invalidates the file's **descendants** too — so editing `lib/tool.js` and then
touching the entry is enough. Node's `node_modules` ignore rule is why the
package's real path is named rather than the profile's symlink to it.

Verify a reload rather than assuming it: change a model-visible string, touch the
entry, and read the tool list back.

## Configuration

All values live in the `source-control` row of `cordis.patch.yml` and are
validated at activation; an unknown field or a non-positive value fails the row
rather than being ignored.

| Field | Default | Meaning |
|---|---|---|
| `timeoutMs` | `30000` | Milliseconds one git command may run before it is abandoned. |
| `maxOutputBytes` | `8388608` | Bytes of stdout retained per command. A larger diff is **refused, never truncated**, because a silently cut diff reads as the whole change. |
| `maxDiffLines` | `20000` | Lines one file's diff may carry before the viewer is told it is too large. |
| `maxLogEntries` | `50` | Commits returned per history page. |

```yaml
- id: source-control
  config:
    timeoutMs: 30000
    maxLogEntries: 100
```

## Architecture

```
React panel ──fetch('/api/source-control/<op>?sessionId=…|repo=…')
                     │  cookie-authenticated, inside the Host/Origin fence
                     ▼
        connection.fetch exact route ──► SourceControlService
                     │                      │ cwd from ctx.sessions
                     │                      │ assertInside() on every path
                     ▼                      ▼
              JSON envelope            git.js ── ctx.subprocess (argv only)
```

| File | Owns |
|---|---|
| `lib/git.js` | argv-only git invocation and the status/diff/log parsers. No Cordis, no HTTP — testable against a scratch repo. |
| `lib/repo.js` | `assertInside`, the **single** path-authority guard, and repository location. |
| `lib/service.js` | Session→repository resolution, the containment choke point, the operation table. |
| `lib/routes.js` | The eight `/api/source-control/*` routes and the JSON envelope. |
| `lib/index.js` | Cordis entry: config validation, wiring, teardown. |
| `lib/tool.js` | The agent tool: action set, argument validation, diff rendering. |
| `lib/client.js` | Browser half: tab type, page, shared panel, hunk controls, styles. |

### Contracts worth knowing before editing

- **Envelope.** Every route answers HTTP 200 with `{ok: true, value}` or
  `{ok: false, error: {code, message, details}}`. A business refusal ("nothing is
  staged") is a *result*, not a transport failure. A non-200 means the request
  never reached a handler.
- **Read vs write.** Each route declares `read: true|false`. That flag is the
  whole authority boundary: `grep -n "read: false" lib/routes.js` enumerates
  every operation that can change a repository.
- **Path authority.** No caller path reaches git except through
  `service.withPaths()`. The guard resolves the path's nearest existing ancestor
  through the real filesystem, so a directory symlink escaping the repository is
  rejected. A leaf symlink is allowed on purpose: git stores a link as its own
  blob.
- **A hunk operation is addressed by NUMBER, never by patch text.** The client
  sends `{path, hunkIndex}`; the Host regenerates the patch from live `git diff`
  output, slices the hunk out of it, and feeds it to `git apply` on **stdin**. No
  caller can supply a patch, name a second path, or reach a file the guard did
  not already clear — which is the whole attack class that hunk staging normally
  opens. `slicePatch` takes a hunk whole (from its `@@` to the next), because
  `git apply` rejects a patch whose header disagrees with the lines beneath it.
- **Hunk discard is human-only.** `discard-hunk` exists as a route and has no
  agent action, for the same reason whole-file discard does not: it is
  irreversible. Both agent-visible action lists are asserted in
  `verify/tools.mjs`.
- **`U3` context keeps hunks separable.** Hunks closer together than the context
  git merges them, so `hunkIndex` addresses whatever git actually reported; the
  Host refuses an index it does not have rather than guessing.
- **Pathspecs are literal.** The runner sets `GIT_LITERAL_PATHSPECS=1`. Without
  it git reads a path argument as a glob: staging a file literally named
  `report[1].txt` would also stage `report1.txt`, and the `git clean -f` behind
  discard would **delete** a sibling that merely matched (`star*.txt` also
  removes `starZZZ.txt`). Do not remove that variable.
- **A loader value is not data until it is shaped.** `useLoad` stores whatever
  the route resolved, including the `null` the diff loader returns while nothing
  is selected. That `null` is still in state for the render that follows a click,
  before the effect re-runs, so anything reading the loaded value must test for
  the shape it needs (`Array.isArray(value.hunks)`), not merely `!== undefined`.
  Getting this wrong blanks the panel on the user's first click.
- **Write your own DOM ids per surface.** The sidebar tab and the main page can be
  mounted at the same time, so an id baked from the panel constant would appear
  twice and bind a `<label>` to whichever the browser found first.
- **A commit's `date` is not guaranteed.** Read it through `String(commit.date ??
  '').slice(0, 10)`; a direct `.slice` throws and the error boundary then replaces
  the whole page.
- **Idempotent writes.** `stage`/`unstage`/`discard` compute their effective set
  from the live working tree, so a stale UI row is a reported no-op
  (`alreadyStaged`, `alreadyUnstaged`) instead of a pathspec error.
- **Two discard granularities.** Whole-file discard restores tracked paths from
  HEAD or deletes untracked ones; hunk discard reverse-applies one hunk. Both ask
  for confirmation and neither is agent-reachable.
- **Discard classification.** Tracked paths are restored from HEAD; untracked
  paths are deleted with `git clean -f` scoped to exactly those paths (`-x` is
  deliberately absent, so ignored files survive). Like `stage` and `unstage`,
  discard filters **positively** against the changes git reports, so a path that
  is not a current change comes back as `unchanged` instead of reaching git.
- **A capped response is refused, not parsed.** The collect mode stops stdout at
  `maxOutputBytes`; parsing that prefix would turn a 3000-line change into "0
  added, 410 removed" and a truncated date into a corrupted one. `GitRunner.run`
  raises `git/output-too-large` instead, which is what "refuses instead of
  truncating" in `cordis.patch.yml` has always claimed.
- **The repository keeps its guardrails.** Commit does **not** pass `--no-verify`,
  so the repository's own pre-commit and commit-msg hooks run; a hook failure
  surfaces as an ordinary commit failure.
- **Reading a diff runs nothing the repository defines.** Every diff argv carries
  `--no-ext-diff` *and* `--no-textconv`, so a diff driver or textconv command
  declared in a cloned `.gitattributes`/config cannot execute merely because a
  file was clicked. (`git add` still honours `filter.<x>.clean`, for which git
  offers no opt-out flag — a documented residual, not an oversight.)
- **Nothing touches git's own metadata.** `assertInside` rejects any path whose
  first segment is `.git`, so no route can name a hook, a config file, or an
  object.
- **Client imports.** `lib/client.js` requires **only** `react` from the shell's
  module table and imports no Harness Client package (a plain-JS plugin has no
  type check, and a throwing component blanks the whole seat). Styles are its
  own, injected once under a `data-plugin-css` tag, using only `--dsw-*` tokens.
  Each surface renders inside an error boundary so a defect shows a message
  instead of blanking the panel.

## Verification

`verify/` drives the real code against real scratch repositories — no mocks of
the behaviour under test.

```bash
node verify/git-layer.mjs      # git operations, path guard, unborn branch, pathspec literals
node verify/routes.mjs         # every route through real Request objects
node verify/apply.mjs          # Host wiring: routes registered, disposed, config
node verify/client-bundle.mjs  # the browser bundle actually executes and registers
node verify/client-render.mjs  # the panel renders real payloads; diff line numbering
node verify/hardening.mjs      # regressions for the defects an adversarial review found
node verify/tools.mjs          # the agent tool, diff rendering, and both callers agreeing
node verify/hunks.mjs          # hunk stage/unstage/discard, and that no patch text is accepted
```

371 assertions in total.

They are ordinary scripts: each prints `ok`/`FAIL` per assertion and exits
non-zero on failure. `verify/routes.mjs` and `verify/client-bundle.mjs` carry
their own `node:child_process`/fake-context adapters precisely so they need no
running Host.

Not covered by them: the browser-session fence (assert with an unauthenticated
request — expect `401`, and with a foreign `Host` header — expect `403`) and
visual rendering, which needs a connected page.
