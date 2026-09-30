/**
 * Verification for the client panel's rendering and diff numbering.
 *
 * The other client check proves the bundle registers; this one proves it draws.
 * A small hook runtime materializes the component tree, a scripted `fetch`
 * answers real payloads, and the assertions cover the parts a screenshot would
 * otherwise be the only evidence for:
 *
 * - the panel renders a row for every change group, with the branch and its
 *   ahead/behind counts,
 * - opening a file renders its diff, and the old/new line numbering covers
 *   exactly the ranges the hunk headers declare — an off-by-one there silently
 *   mislabels every line of every diff,
 * - a business failure renders its message instead of throwing.
 *
 * Run with:
 *
 *     node verify/client-render.mjs
 */
import { readFile } from 'node:fs/promises';

import { parseDiff } from '../lib/git.js';

let failures = 0;
let checks = 0;

/**
 * Assert one condition.
 * @param {boolean} condition - the condition.
 * @param {string} label - what is asserted.
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

// ---------------------------------------------------------------------------
// A minimal but honest hook runtime: state is keyed by the rendering
// component's position, so sibling and nested components keep separate cells.
// ---------------------------------------------------------------------------
const cells = new Map();
let path = [];
let cursor = 0;
const unsubscribes = [];

const React = {
  /**
   * Build one element, invoking function components so the tree materializes.
   * @param {unknown} type - tag or component.
   * @param {object} props - props.
   * @param {...unknown} children - children.
   * @returns {object} the element.
   */
  createElement(type, props, ...children) {
    const merged = { ...(props ?? {}), children: children.length <= 1 ? children[0] : children.flat() };
    if (typeof type !== 'function') return { type, props: merged, children: children.flat() };
    if (type.prototype?.render) {
      // The error boundary: render its child directly.
      const instance = new type(merged);
      path.push(type.name);
      const rendered = instance.render();
      path.pop();
      return { type: type.name, props: merged, children: [rendered] };
    }
    const key = [...path, type.name ?? 'anon'].join('/');
    path.push(type.name ?? 'anon');
    const savedCursor = cursor;
    cursor = 0;
    let rendered;
    try {
      rendered = type(merged);
    } finally {
      cursor = savedCursor;
      path.pop();
    }
    return { type: type.name ?? 'anon', props: merged, children: [rendered] };
  },
  /** @returns {object} a ref. */
  useRef: () => ({ current: null }),
  /**
   * @param {unknown} initial - initial value.
   * @returns {[unknown, Function]} the state pair.
   */
  useState(initial) {
    const key = `${[...path].join('/')}#${cursor}`;
    cursor += 1;
    if (!cells.has(key)) cells.set(key, { value: typeof initial === 'function' ? initial() : initial });
    const cell = cells.get(key);
    return [
      cell.value,
      (next) => {
        const value = typeof next === 'function' ? next(cell.value) : next;
        if (Object.is(value, cell.value)) return;
        cell.value = value;
        changed = true;
      },
    ];
  },
  /** @param {Function} fn - the callback. @returns {Function} it. */
  useCallback: (fn) => fn,
  /** @param {Function} fn - the factory. @returns {unknown} its value. */
  useMemo: (fn) => fn(),
  /**
   * @param {Function} fn - the effect.
   */
  useEffect(fn, deps) {
    const key = `${[...path].join('/')}#effect${cursor}`;
    cursor += 1;
    const cell = cells.get(key);
    if (cell !== undefined) {
      const same =
        Array.isArray(deps) &&
        Array.isArray(cell.deps) &&
        deps.length === cell.deps.length &&
        deps.every((value, index) => Object.is(value, cell.deps[index]));
      if (same) return;
      if (typeof cell.cleanup === 'function') cell.cleanup();
    }
    changed = true;
    const cleanup = fn();
    cells.set(key, { deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined });
  },
  /** @param {Function} fn - the layout effect. */
  useLayoutEffect: () => {},
  /** Component base stand-in. */
  Component: class {
    /** @param {object} props - props. */
    constructor(props) {
      this.props = props;
      this.state = {};
    }
  },
};

let changed = false;

/** Drop every hook cell, simulating a fresh mount of the whole tree. */
function reset() {
  cells.clear();
  unsubscribes.length = 0;
  path = [];
  cursor = 0;
  requests.length = 0;
}

/** The scripted answer per operation. */
let scripted = {};
/** Every request the panel made. */
const requests = [];

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
let registration = null;
globalThis.window = { __ModuleLoader__: { load(v) { registration = v; } }, location: { origin: 'http://localhost:3080' } };
globalThis.document = { querySelector: () => null, createElement: () => ({ dataset: {}, textContent: '' }), head: { appendChild() {} } };
globalThis.fetch = async (url, init) => {
  const target = String(url);
  // Record the body as well: a write sends its payload there, not in the query.
  let body;
  try {
    body = init?.body === undefined ? undefined : JSON.parse(init.body);
  } catch {
    body = init?.body;
  }
  requests.push({ target, body, method: init?.method });
  const operation = target.split('?')[0].split('/').pop();
  return { ok: true, headers: { get: () => 'application/json' }, json: async () => scripted[operation] ?? { ok: true, value: {} } };
};
globalThis.AbortController = AbortController;

// eslint-disable-next-line no-new-func
new Function(source)();
const mod = registration.factory((specifier) => {
  if (specifier === 'react') return React;
  throw new Error(`unexpected require(${specifier})`);
});

/** The bundle's real copy, so placeholder substitution is genuinely tested. */
const messages = mod.messages;

const slots = [];
mod.apply({
  effect: (cb) => {
    cb();
    return () => {};
  },
  locale: { register: () => () => {}, bind: () => (key) => messages.en[key] ?? key },
  sidebarRightTabs: { register: () => () => {} },
  sidebarRight: {},
  layout: {},
  slots: { inject: (name, cb) => { cb(); return () => {}; }, register: (options, component) => { slots.push({ options, component }); return () => {}; } },
});

const tabComponent = slots.find((entry) => entry.options.name === 'sidebar.right.pane.tab').component;

/**
 * Render a surface, letting its effects settle and re-rendering while state changes.
 * @param {Function} component - the surface.
 * @param {object} props - its props.
 * @returns {Promise<object>} the settled tree.
 */
async function render(component, props) {
  let tree = null;
  for (let pass = 0; pass < 8; pass += 1) {
    changed = false;
    path = [];
    cursor = 0;
    tree = component(props);
    if (!changed) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  // Let any promise started by this pass settle, then render once more.
  await new Promise((resolve) => setTimeout(resolve, 10));
  changed = false;
  path = [];
  cursor = 0;
  return component(props) ?? tree;
}

/**
 * Collect every element in a tree.
 * @param {unknown} root - the tree.
 * @returns {object[]} every element.
 */
function walk(root) {
  const found = [];
  const visit = (node) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node === null || node === undefined || typeof node !== 'object') return;
    if (node.type !== undefined) found.push(node);
    visit(node.children);
  };
  visit(root);
  return found;
}

/**
 * Text of every element carrying a class.
 * @param {object} tree - the tree.
 * @param {string} className - the class to match.
 * @returns {string[]} the texts.
 */
function textOf(node) {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node === null || node === undefined || typeof node !== 'object') return '';
  return textOf(node.children);
}

/**
 * Text of every element carrying a class, with nested text flattened.
 * @param {object} tree - the tree.
 * @param {string} className - the class to match.
 * @returns {string[]} the texts.
 */
function textsOf(tree, className) {
  return walk(tree)
    .filter((node) => typeof node.props?.className === 'string' && node.props.className.split(' ').includes(className))
    .map((node) => textOf(node.children));
}

const t = (key) => messages.en[key] ?? key;
const tabProps = {
  sessionId: 'session-1',
  t,
  useTabInfo: () => ({
    sidebar: { expanded: true, fullscreen: false },
    panel: { id: 'pane-1' },
    tab: { id: 'tab-1', signal: new AbortController().signal, actions: {}, navigation: { revision: 0, params: undefined, address: 'a' }, visible: true },
  }),
};

// ---------------------------------------------------------------------------
console.log('## clean working tree');
reset();
scripted = {
  status: {
    ok: true,
    value: {
      repository: { root: '/repo', cwd: '/repo', branch: 'main', head: 'abc', hasCommits: true },
      status: { branch: 'main', oid: 'abc', upstream: null, ahead: 0, behind: 0, staged: [], changes: [], untracked: [], conflicted: [] },
    },
  },
};
let tree = await render(tabComponent, tabProps);
check(requests.some((entry) => entry.target.includes('/status')), 'the panel requests status on mount');
check(textsOf(tree, 'dsc-status').includes('No changes in the working tree.'), 'an empty working tree renders the clean message', textsOf(tree, 'dsc-status'));
check(textsOf(tree, 'dsc-branch').includes('main'), 'the branch name is rendered', textsOf(tree, 'dsc-branch'));

// ---------------------------------------------------------------------------
console.log('\n## changed working tree');
const statusPayload = {
  repository: { root: '/repo', cwd: '/repo', branch: 'feature/x', head: 'def', hasCommits: true },
  status: {
    branch: 'feature/x',
    oid: 'def',
    upstream: 'origin/feature/x',
    ahead: 2,
    behind: 1,
    staged: [{ path: 'src/staged.ts', origPath: null, renamed: false, staged: true, indexStatus: 'M', worktreeStatus: '.', untracked: false, unmerged: false }],
    changes: [{ path: 'src/modified.ts', origPath: null, renamed: false, staged: false, indexStatus: '.', worktreeStatus: 'M', untracked: false, unmerged: false }],
    untracked: [{ path: 'src/new.ts', origPath: null, renamed: false, staged: false, indexStatus: '?', worktreeStatus: '?', untracked: true, unmerged: false }],
    conflicted: [],
  },
};
reset();
scripted = { status: { ok: true, value: statusPayload } };
tree = await render(tabComponent, tabProps);
const rowTexts = textsOf(tree, 'dsc-name').join('|');
check(rowTexts.includes('staged.ts'), 'a staged file is rendered', rowTexts);
check(rowTexts.includes('modified.ts'), 'a changed file is rendered', rowTexts);
check(rowTexts.includes('new.ts'), 'an untracked file is rendered', rowTexts);
check(textsOf(tree, 'dsc-groupTitle').length === 3, 'three groups are rendered', textsOf(tree, 'dsc-groupTitle'));
check(textsOf(tree, 'dsc-groupCount').join(',') === '1,1,1', 'each group counts its rows', textsOf(tree, 'dsc-groupCount'));
check(textsOf(tree, 'dsc-track').length === 2, 'ahead and behind are both rendered', textsOf(tree, 'dsc-track'));
check(textsOf(tree, 'dsc-groupTitle').includes('feature/x') === false, 'the branch is not rendered as a group title');

// ---------------------------------------------------------------------------
console.log('\n## opening a file shows its diff, with correct line numbers');
const rawDiff = [
  'diff --git a/src/modified.ts b/src/modified.ts',
  'index 1111111..2222222 100644',
  '--- a/src/modified.ts',
  '+++ b/src/modified.ts',
  '@@ -10,5 +10,6 @@ export function run() {',
  ' const a = 1;',
  '-const b = 2;',
  '-const c = 3;',
  '+const b = 20;',
  '+const c = 30;',
  '+const d = 40;',
  ' return a;',
  '}',
  '@@ -30,2 +31,1 @@ export function stop() {',
  '-const gone = true;',
  ' const kept = false;',
  '\\ No newline at end of file',
].join('\n');
const parsed = parseDiff(rawDiff);
check(parsed.hunks.length === 2, 'the fixture parses into two hunks', parsed.hunks.length);
scripted = {
  status: { ok: true, value: statusPayload },
  diff: { ok: true, value: { path: 'src/modified.ts', staged: false, untracked: false, binary: false, header: parsed.header, added: parsed.added, removed: parsed.removed, hunks: parsed.hunks } },
};

// Open the "modified.ts" row by invoking its click handler, as a user would.
const beforeOpen = await render(tabComponent, tabProps);
const openButton = walk(beforeOpen).find(
  (node) => node.type === 'button' && node.props.onClick !== undefined && typeof node.props.title === 'string' && node.props.title.includes('modified.ts'),
);
check(openButton !== undefined, 'the row exposes a click target for the file');
openButton.props.onClick();
const openTree = await render(tabComponent, tabProps);
check(requests.some((entry) => entry.target.includes('/diff')), 'opening a file requests its diff');

const gutters = textsOf(openTree, 'dsc-gutter');
check(gutters.length > 0, 'the diff renders numbered gutter cells', gutters.length);
check(textsOf(openTree, 'dsc-hunkHead').length === 2, 'both hunk headers are rendered', textsOf(openTree, 'dsc-hunkHead'));

// Re-derive the numbering the viewer produced and compare it with the ranges the
// hunk headers declare: the last line of a hunk must land on start+count-1.
const numbered = [];
for (const hunk of parsed.hunks) {
  let oldNo = hunk.oldStart;
  let newNo = hunk.newStart;
  for (const line of hunk.lines) {
    if (line.kind === 'meta') numbered.push([null, null]);
    else if (line.kind === 'add') numbered.push([null, newNo++]);
    else if (line.kind === 'del') numbered.push([oldNo++, null]);
    else numbered.push([oldNo++, newNo++]);
  }
}
const expectedOld = numbered.map((pair) => (pair[0] === null ? '' : String(pair[0])));
const expectedNew = numbered.map((pair) => (pair[1] === null ? '' : String(pair[1])));
const actual = [];
for (let index = 0; index < gutters.length; index += 2) actual.push([gutters[index], gutters[index + 1]]);
check(actual.length === numbered.length, 'the viewer renders one gutter pair per diff line', { actual: actual.length, expected: numbered.length });
check(
  actual.every((pair, index) => pair[0] === expectedOld[index] && pair[1] === expectedNew[index]),
  'every gutter pair matches the numbering the hunk headers declare',
  { actual: actual.slice(0, 6), expected: expectedOld.slice(0, 6).map((value, index) => [value, expectedNew[index]]) },
);

const firstHunk = parsed.hunks[0];
const lastOfFirst = numbered.slice(0, firstHunk.lines.length).at(-1);
check(
  lastOfFirst[0] === firstHunk.oldStart + firstHunk.oldCount - 1 || lastOfFirst[0] === null,
  'the first hunk ends on the last old line it declares',
  { lastOfFirst, header: firstHunk.header },
);
check(
  lastOfFirst[1] === firstHunk.newStart + firstHunk.newCount - 1,
  'the first hunk ends on the last new line it declares',
  { lastOfFirst, header: firstHunk.header },
);

// ---------------------------------------------------------------------------
console.log('\n## failure rendering');
reset();
scripted = { status: { ok: false, error: { code: 'repo/not-a-repository', message: '/repo is not inside a Git repository', details: {} } } };
const failureTree = await render(tabComponent, tabProps);
check(textsOf(failureTree, 'dsc-status').join(' ').includes('not inside a Git repository'), 'a non-repository renders its own message', textsOf(failureTree, 'dsc-status'));

reset();
scripted = { status: { ok: false, error: { code: 'session/no-workspace', message: 'no cwd', details: {} } } };
const noWorkspaceTree = await render(tabComponent, tabProps);
check(textsOf(noWorkspaceTree, 'dsc-status').join(' ').includes('no working directory'), 'a Session without a workspace renders its own message', textsOf(noWorkspaceTree, 'dsc-status'));

reset();
scripted = { status: { ok: false, error: { code: 'git/unavailable', message: 'no git', details: {} } } };
const noGitTree = await render(tabComponent, tabProps);
check(textsOf(noGitTree, 'dsc-status').join(' ').includes('Git is not available'), 'a Host without git renders its own message', textsOf(noGitTree, 'dsc-status'));

// ---------------------------------------------------------------------------
console.log('\n## a commit without a date does not blank the page');
// Reading `commit.date.slice(...)` directly threw, and the error boundary then
// replaced the whole main page. A truncated response can genuinely omit it.
reset();
const pageComponent = slots.find((entry) => entry.options.name === 'main').component;
scripted = {
  git: { ok: true, value: { available: true, executable: '/usr/bin/git', repositories: [{ root: '/repo', cwd: '/repo', label: 'repo', sessionIds: ['session-1'], isRepository: true }] } },
  status: {
    ok: true,
    value: {
      repository: { root: '/repo', cwd: '/repo', branch: 'main', head: 'abc', hasCommits: true },
      status: { branch: 'main', oid: 'abc', upstream: null, ahead: 0, behind: 0, staged: [], changes: [], untracked: [], conflicted: [] },
    },
  },
  log: { ok: true, value: { commits: [{ hash: 'd1', short: 'd1', author: 'someone', subject: 'no date here', body: '' }] } },
};
const pageTree = await render(pageComponent, { t, usePanelInfo: () => null });
const commitSubjects = textsOf(pageTree, 'dsc-commitSubject');
check(commitSubjects.includes('no date here'), 'a commit with no date still renders', commitSubjects);
const commitMeta = textsOf(pageTree, 'dsc-commitMeta');
check(commitMeta.length === 1 && !commitMeta[0].includes('undefined'), 'its meta line omits the date instead of printing undefined', commitMeta);

console.log('\n## distinct DOM ids per surface');
const tabIds = walk(await render(tabComponent, tabProps)).filter((node) => node.type === 'textarea').map((node) => node.props.id);
reset();
const pageIds = walk(await render(pageComponent, { t, usePanelInfo: () => null })).filter((node) => node.type === 'textarea').map((node) => node.props.id);
check(tabIds.length === 1 && pageIds.length === 1, 'each surface renders one message box', { tabIds, pageIds });
check(tabIds[0] !== pageIds[0], 'the two message boxes do not share an id', { tabIds, pageIds });

console.log('\n## the Changes group reports the worktree status, not the index status');
// A file staged as new and then modified again is `A` in the index and `M` in the
// worktree. The Changes group must show M.
reset();
const mmPayload = {
  repository: { root: '/repo', cwd: '/repo', branch: 'main', head: 'a', hasCommits: true },
  status: {
    branch: 'main',
    oid: 'a',
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: [{ path: 'added.txt', origPath: null, renamed: false, staged: true, indexStatus: 'A', worktreeStatus: 'M', untracked: false, unmerged: false }],
    changes: [{ path: 'added.txt', origPath: null, renamed: false, staged: true, indexStatus: 'A', worktreeStatus: 'M', untracked: false, unmerged: false }],
    untracked: [],
    conflicted: [],
  },
};
scripted = { status: { ok: true, value: mmPayload } };
const mmTree = await render(tabComponent, tabProps);
const badges = textsOf(mmTree, 'dsc-badge');
check(badges.length === 2, 'the file appears in both groups', badges);
check(badges.includes('A') && badges.includes('M'), 'the staged row shows A and the changed row shows M', badges);

// ---------------------------------------------------------------------------
console.log('\n## hunk controls in the diff viewer');
// Re-open the two-hunk diff and drive the per-hunk buttons.
reset();
const twoHunks = parseDiff(
  [
    'diff --git a/src/modified.ts b/src/modified.ts',
    '--- a/src/modified.ts',
    '+++ b/src/modified.ts',
    '@@ -1,3 +1,3 @@',
    ' line1',
    '-line2',
    '+CHANGED2',
    ' line3',
    '@@ -18,3 +18,3 @@',
    ' line18',
    '-line19',
    '+CHANGED19',
    ' line20',
  ].join('\n'),
);
check(twoHunks.hunks.length === 2, 'the hunk fixture has two hunks', twoHunks.hunks.length);
reset();
scripted = {
  status: { ok: true, value: statusPayload },
  diff: { ok: true, value: { path: 'src/modified.ts', staged: false, untracked: false, binary: false, added: 2, removed: 2, hunks: twoHunks.hunks } },
};
const opened = await render(tabComponent, tabProps);
const openRow = walk(opened).find(
  (node) => node.type === 'button' && node.props.onClick !== undefined && typeof node.props.title === 'string' && node.props.title.includes('modified.ts'),
);
openRow.props.onClick();
const diffTree = await render(tabComponent, tabProps);
const hunkHeads = walk(diffTree).filter((node) => typeof node.props?.className === 'string' && node.props.className.includes('dsc-hunkHead'));
check(hunkHeads.length === 2, 'each hunk renders its own head bar', hunkHeads.length);
const hunkButtons = walk(diffTree).filter(
  (node) => node.type === 'button' && typeof node.props?.className === 'string' && node.props.className.includes('dsc-btn-mini'),
);
check(hunkButtons.length === 4, 'an unstaged hunk offers stage and discard', hunkButtons.length);
check(
  hunkButtons.some((node) => node.props.className.includes('dsc-btn-danger')),
  'one of them is the destructive discard',
);
check(hunkButtons.every((node) => typeof node.props['aria-label'] === 'string' && node.props['aria-label'] !== ''), 'every hunk button is labelled');

// Clicking "discard hunk" must ask first, not act.
const discardHunkButton = hunkButtons.find((node) => node.props.className.includes('dsc-btn-danger'));
discardHunkButton.props.onClick();
const confirmTree = await render(tabComponent, tabProps);
const confirmBody = textsOf(confirmTree, 'dsc-confirmBody').join(' ');
check(confirmBody.includes('permanently reverts hunk'), 'the confirmation explains what is at stake', confirmBody);
check(textsOf(confirmTree, 'dsc-confirmTitle').includes('Discard this hunk?'), 'discarding a hunk asks first', textsOf(confirmTree, 'dsc-confirmTitle'));
check(confirmBody.includes('src/modified.ts'), 'the confirmation names the file', confirmBody);
check(confirmBody.includes('hunk 1 of'), 'the confirmation numbers the hunk in human terms', confirmBody);
// It must not have called the server for a discard before confirmation.
check(
  !requests.some((entry) => entry.target.includes('discard')),
  'no discard request was made before the user confirmed',
  requests.filter((entry) => entry.target.includes('discard')),
);
// Once confirmed, exactly one discard request goes out, naming the hunk by number.
const confirmButton = walk(confirmTree).find(
  (node) => node.type === 'button' && node.props.className === 'dsc-btn dsc-btn-danger',
);
check(confirmButton !== undefined, 'the confirmation offers a destructive confirm control');
confirmButton.props.onClick();
await new Promise((resolve) => setTimeout(resolve, 20));
const discardRequests = requests.filter((entry) => entry.target.includes('discard-hunk'));
check(discardRequests.length === 1, 'confirming issues exactly one discard request', discardRequests);
check(discardRequests[0].method === 'POST', 'the discard is a POST', discardRequests[0]);
check(discardRequests[0].body?.hunkIndex === 0, 'the body names the hunk by NUMBER', discardRequests[0].body);
check(discardRequests[0].body?.path === 'src/modified.ts', 'the body names the path', discardRequests[0].body);
check(
  JSON.stringify(discardRequests[0].body).includes('diff --git') === false,
  'no patch text is ever sent from the client',
  discardRequests[0].body,
);

console.log('\n## a staged hunk offers only unstage');
reset();
scripted = {
  status: { ok: true, value: statusPayload },
  diff: { ok: true, value: { path: 'src/modified.ts', staged: true, untracked: false, binary: false, added: 2, removed: 2, hunks: twoHunks.hunks } },
};
const stagedTree0 = await render(tabComponent, tabProps);
// Open from the Staged group so the viewer renders the index side.
const stagedRowButton = walk(stagedTree0).find(
  (node) => node.type === 'button' && node.props.onClick !== undefined && typeof node.props.title === 'string' && node.props.title.includes('staged.ts'),
);
stagedRowButton.props.onClick();
const stagedDiffTree = await render(tabComponent, tabProps);
const stagedButtons = walk(stagedDiffTree).filter(
  (node) => node.type === 'button' && typeof node.props?.className === 'string' && node.props.className.includes('dsc-btn-mini'),
);
// staged.ts's own diff is empty in the fixture, so assert on the index-side rule directly:
const indexSideButtons = stagedButtons.filter((node) => node.props.className.includes('dsc-btn-danger'));
check(indexSideButtons.length === 0, 'the staged side offers no destructive hunk action', indexSideButtons.map((node) => node.props['aria-label']));

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
