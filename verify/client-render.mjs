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
import { readFile, writeFile } from 'node:fs/promises';

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
    const identity = props?.key === undefined ? (type.name ?? 'anon') : `${type.name ?? 'anon'}:${props.key}`;
    path.push(identity);
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
  /** @returns {object} a ref, stable across renders like React's real hook. */
  useRef(initial) {
    const [ref] = React.useState(() => ({ current: initial }));
    return ref;
  },
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
const styles = [];
globalThis.document = { querySelector: () => null, createElement: () => ({ dataset: {}, textContent: '' }), head: { appendChild(node) { styles.push(node.textContent); } } };
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
  // Real JSON transport creates a new object per response. Reusing the fixture
  // reference would incorrectly make distinct status snapshots look identical.
  const answer = scripted[operation] ?? ({
    graph: { ok: true, value: { commits: [], hasMore: false } },
    branches: { ok: true, value: { current: null, head: null, local: [], remote: [], remotes: [] } },
  })[operation];
  return { ok: true, headers: { get: () => 'application/json' }, json: async () => structuredClone(
    (typeof answer === 'function' ? await answer({ target, body, init }) : answer) ?? { ok: true, value: {} },
  ) };
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
check(textsOf(tree, 'dsc-groupTitle').join(',') === 'Staged Changes,Changes', 'untracked files share the Changes group', textsOf(tree, 'dsc-groupTitle'));
check(textsOf(tree, 'dsc-groupCount').join(',') === '1,2', 'Changes counts tracked and untracked rows together', textsOf(tree, 'dsc-groupCount'));
check(textsOf(tree, 'dsc-badge').includes('U'), 'an untracked file has a distinct U status');
const initialNodes = walk(tree);
check(initialNodes.findIndex((node) => node.type === 'textarea') < initialNodes.findIndex((node) => node.props?.className === 'dsc-body'), 'the commit input appears above the change list');
const firstName = initialNodes.find((node) => node.props?.className === 'dsc-name');
check(firstName.children[0].props.className === 'dsc-base' && firstName.children[1].props.className === 'dsc-dir', 'file names precede their secondary directory');
const changesToggle = initialNodes.find((node) => node.props?.className === 'dsc-groupToggle' && textOf(node).includes('Changes2'));
check(changesToggle.props['aria-expanded'] === true, 'groups expose expanded state to assistive technology');
check(walk(changesToggle).some((node) => node.type === 'svg' && node.props.className === 'dsc-chevron dsc-chevron-open'), 'the expanded chevron carries its rotation class');
check(walk(tree).filter((node) => node.type === 'svg' && node.props.className === 'dsc-fileIcon').length === 3, 'each row has a styled file icon');
changesToggle.props.onClick();
tree = await render(tabComponent, tabProps);
check(textsOf(tree, 'dsc-name').length === 1, 'collapsing Changes hides tracked and untracked rows');
check(textsOf(tree, 'dsc-groupCount').join(',') === '1,2', 'collapsed groups keep their counts');
walk(tree).find((node) => node.props?.className === 'dsc-groupToggle' && node.props['aria-expanded'] === false).props.onClick();
tree = await render(tabComponent, tabProps);
check(textsOf(tree, 'dsc-name').length === 3, 'expanding Changes restores its rows');
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
  graph: { ok: true, value: { commits: [{ hash: 'd1', short: 'd1', parents: [], refs: [], author: 'someone', subject: 'no date here' }], hasMore: false } },
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

// ---------------------------------------------------------------------------
console.log('\n## the main page is a persistent list + diff workbench');
reset();
const catalogFixture = { ok: true, value: { available: true, repositories: [
  { root: '/repo', label: 'repo', isRepository: true },
  { root: '/other', label: 'other', isRepository: true },
] } };
scripted = {
  git: catalogFixture,
  status: { ok: true, value: statusPayload },
  graph: { ok: true, value: { commits: [{ hash: 'd2', short: 'd2', parents: [], refs: [], author: 'someone', subject: 'Improve source control layout', date: '2026-09-30' }], hasMore: false } },
  diff: { ok: true, value: { binary: false, added: 2, removed: 2, hunks: twoHunks.hunks } },
};
const pageProps = { t, usePanelInfo: () => null };
let workspaceTree = await render(pageComponent, pageProps);
check(walk(workspaceTree).some((node) => node.props?.className === 'dsc-workbench'), 'the page renders a workbench, not two cards');
check(textsOf(workspaceTree, 'dsc-editorEmpty').join(' ').includes('Select a file'), 'the empty editor explains file selection');
const navigator = walk(workspaceTree).find((node) => node.props?.className === 'dsc-navigator');
check(walk(navigator).some((node) => node.type === 'button' && node.props.className === 'dsc-historyToggle' && node.props['aria-expanded'] === true), 'history is collapsible inside the navigator');
check(textsOf(navigator, 'dsc-commitSubject').includes('Improve source control layout'), 'history stays in the same navigation column');
walk(workspaceTree).find((node) => node.type === 'button' && node.props.title === 'src/modified.ts').props.onClick();
workspaceTree = await render(pageComponent, pageProps);
check(textsOf(workspaceTree, 'dsc-name').length === 3, 'opening a diff keeps every file row visible');
check(textsOf(workspaceTree, 'dsc-hunkHead').length === 2, 'the adjacent editor renders the selected diff');
check(textsOf(workspaceTree, 'dsc-diffSide').join('') === 'Working Tree', 'the editor identifies the working-tree side');
check(walk(workspaceTree).filter((node) => node.props?.['aria-pressed'] === true).length === 1, 'the active row is highlighted and announced');
const workbenchSnapshot = workspaceTree;

// Changing selection must invalidate the previous diff before any asynchronous
// effect finishes. Otherwise old hunk numbers could act on a different file.
walk(workspaceTree).find((node) => node.type === 'button' && node.props.title === 'src/staged.ts').props.onClick();
const transientTree = pageComponent(pageProps);
check(textsOf(transientTree, 'dsc-hunkHead').length === 0, 'switching files never exposes the previous file\'s hunk actions');
workspaceTree = await render(pageComponent, pageProps);
check(textsOf(workspaceTree, 'dsc-diffPath').join('') === 'src/staged.ts', 'a second row can be opened without returning to the list');
check(textsOf(workspaceTree, 'dsc-diffSide').join('') === 'Index', 'staged diffs identify the index side');
check(walk(workspaceTree).filter((node) => node.props?.['aria-label'] === 'Unstage hunk').length === 2, 'staged diffs offer unstage per hunk');
check(walk(workspaceTree).filter((node) => node.props?.['aria-label'] === 'Discard hunk').length === 0, 'staged diffs have no hunk discard');
walk(workspaceTree).find((node) => node.props?.['aria-label'] === 'Close diff').props.onClick();
workspaceTree = await render(pageComponent, pageProps);
check(textsOf(workspaceTree, 'dsc-editorEmpty').length === 1 && textsOf(workspaceTree, 'dsc-name').length === 3, 'closing a diff preserves the list and restores the editor placeholder');

const changesBulk = walk(workspaceTree).find((node) => node.props?.['aria-label'] === 'Stage all');
await changesBulk.props.onClick();
const combinedStage = requests.filter((entry) => entry.target.includes('/stage?')).at(-1);
check(combinedStage?.body.paths.join(',') === 'src/modified.ts,src/new.ts', 'Stage all includes tracked and untracked changes');

console.log('\n## shortcut and button use the same guarded commit');
workspaceTree = await render(pageComponent, pageProps);
walk(workspaceTree).find((node) => node.type === 'textarea').props.onChange({ target: { value: 'Layout update' } });
workspaceTree = await render(pageComponent, pageProps);
const commitButton = walk(workspaceTree).find((node) => node.type === 'button' && node.props.title === t('commit.hint'));
check(commitButton.props.disabled === false, 'a staged change and message enable Commit');
const commitRequestStart = requests.filter((entry) => entry.target.includes('/commit?')).length;
const firstCommit = commitButton.props.onClick();
walk(workspaceTree).find((node) => node.type === 'textarea').props.onKeyDown({ ctrlKey: true, key: 'Enter', preventDefault() {} });
await firstCommit;
check(requests.filter((entry) => entry.target.includes('/commit?')).length === commitRequestStart + 1, 'a rapid click plus shortcut issues only one commit');
workspaceTree = await render(pageComponent, pageProps);
check(walk(workspaceTree).find((node) => node.type === 'textarea').props.value === '', 'a successful commit clears the message');

console.log('\n## switching repositories resets repository-local UI');
walk(workspaceTree).find((node) => node.type === 'textarea').props.onChange({ target: { value: 'Only for repo one' } });
workspaceTree = await render(pageComponent, pageProps);
walk(workspaceTree).find((node) => node.type === 'button' && node.props.title === 'src/modified.ts').props.onClick();
workspaceTree = await render(pageComponent, pageProps);
walk(workspaceTree).find((node) => node.type === 'select').props.onChange({ target: { value: '/other' } });
workspaceTree = await render(pageComponent, pageProps);
check(walk(workspaceTree).find((node) => node.type === 'textarea').props.value === '', 'a commit draft is not silently carried to another repository');
check(textsOf(workspaceTree, 'dsc-editorEmpty').length === 1, 'a selected file is not carried to another repository');
check(requests.some((entry) => entry.target.includes('/status?') && entry.target.includes('repo=%2Fother')), 'the new repository is explicitly selected in the request');

console.log('\n## no-index changes do not offer unsupported hunk actions');
reset();
scripted = {
  status: { ok: true, value: statusPayload },
  diff: { ok: true, value: { binary: false, added: 2, removed: 0, hunks: twoHunks.hunks } },
};
let compactTree = await render(tabComponent, tabProps);
walk(compactTree).find((node) => node.type === 'button' && node.props.title === 'src/new.ts').props.onClick();
compactTree = await render(tabComponent, tabProps);
check(textsOf(compactTree, 'dsc-hunkHead').length === 2, 'untracked file contents still appear in the diff');
check(walk(compactTree).filter((node) => node.props?.className?.includes('dsc-btn-mini')).length === 0, 'untracked files have no unsupported hunk actions');
check(walk(compactTree).some((node) => node.props?.['aria-label'] === 'Stage'), 'whole-file staging remains available for untracked files');
check(walk(compactTree).find((node) => node.type === 'textarea') !== undefined, 'the compact diff keeps the top commit box');
walk(compactTree).find((node) => node.props?.['aria-label'] === 'Back').props.onClick();
compactTree = await render(tabComponent, tabProps);
check(textsOf(compactTree, 'dsc-name').length === 3, 'Back restores the compact file list');
const compactSnapshot = compactTree;

reset();
scripted = { status: { ok: true, value: { ...statusPayload, status: { ...statusPayload.status, staged: [] } } } };
let unstagedOnly = await render(tabComponent, tabProps);
walk(unstagedOnly).find((node) => node.type === 'textarea').props.onChange({ target: { value: 'not staged' } });
unstagedOnly = await render(tabComponent, tabProps);
walk(unstagedOnly).find((node) => node.type === 'textarea').props.onKeyDown({ metaKey: true, key: 'Enter', preventDefault() {} });
check(!requests.some((entry) => entry.target.includes('/commit?')), 'the shortcut does not commit without staged changes');

check(Object.keys(messages.en).sort().join(',') === Object.keys(messages.zh).sort().join(','), 'both locales cover all UI keys');

console.log('\n## hunk actions wait for fresh status and diff after a write');
reset();
scripted = {
  status: { ok: true, value: statusPayload },
  diff: { ok: true, value: { binary: false, added: 2, removed: 2, hunks: twoHunks.hunks } },
};
let raceTree = await render(tabComponent, tabProps);
walk(raceTree).find((node) => node.type === 'button' && node.props.title === 'src/modified.ts').props.onClick();
raceTree = await render(tabComponent, tabProps);
let releaseStatus;
scripted.status = () => new Promise((resolve) => { releaseStatus = () => resolve({ ok: true, value: statusPayload }); });
const diffsBeforeWrite = requests.filter((entry) => entry.target.includes('/diff?')).length;
walk(raceTree).find((node) => node.props?.['aria-label'] === 'Stage hunk').props.onClick();
raceTree = await render(tabComponent, tabProps);
check(typeof releaseStatus === 'function', 'the test holds the post-write status refresh pending');
check(textsOf(raceTree, 'dsc-hunkHead').length === 0, 'old hunks disappear before the status refresh resolves');
check(requests.filter((entry) => entry.target.includes('/diff?')).length === diffsBeforeWrite, 'no diff is requested against the invalidated status');
releaseStatus();
scripted.status = { ok: true, value: statusPayload };
raceTree = await render(tabComponent, tabProps);
check(textsOf(raceTree, 'dsc-hunkHead').length === 2, 'fresh status and matching diff restore the hunk controls');

walk(raceTree).find((node) => node.props?.['aria-label'] === 'Discard hunk').props.onClick();
raceTree = await render(tabComponent, tabProps);
check(textsOf(raceTree, 'dsc-confirmTitle').includes('Discard this hunk?'), 'a reviewed hunk can open its confirmation');
scripted.status = () => new Promise((resolve) => { releaseStatus = () => resolve({ ok: true, value: statusPayload }); });
walk(raceTree).find((node) => node.props?.['aria-label'] === 'Refresh').props.onClick();
raceTree = await render(tabComponent, tabProps);
check(textsOf(raceTree, 'dsc-confirmTitle').length === 0, 'manual refresh immediately cancels the obsolete hunk confirmation');
check(!requests.some((entry) => entry.target.includes('/discard-hunk?')), 'refresh never submits the obsolete discard');
releaseStatus();
scripted.status = { ok: true, value: statusPayload };
raceTree = await render(tabComponent, tabProps);
check(textsOf(raceTree, 'dsc-confirmTitle').length === 0, 'a new snapshot does not revive the previous confirmation');

console.log('\n## diff failures belong only to the selection that requested them');
reset();
scripted = {
  git: catalogFixture, status: { ok: true, value: statusPayload }, graph: { ok: true, value: { commits: [], hasMore: false } },
  diff: { ok: false, error: { code: 'git/failure', message: 'specific file diff failure' } },
};
let errorSelection = await render(pageComponent, pageProps);
walk(errorSelection).find((node) => node.type === 'button' && node.props.title === 'src/modified.ts').props.onClick();
errorSelection = await render(pageComponent, pageProps);
check(textsOf(errorSelection, 'dsc-status').includes('specific file diff failure'), 'the current file displays its diff failure');
scripted.diff = { ok: true, value: { binary: false, added: 2, removed: 2, hunks: twoHunks.hunks } };
walk(errorSelection).find((node) => node.type === 'button' && node.props.title === 'src/staged.ts').props.onClick();
check(!textOf(pageComponent(pageProps)).includes('specific file diff failure'), 'another file never displays the previous selection\'s error');
errorSelection = await render(pageComponent, pageProps);
check(textsOf(errorSelection, 'dsc-hunkHead').length === 2, 'the next selection can load normally after a failure');

console.log('\n## refresh cannot restore pre-write hunks while a write is in flight');
reset();
scripted = {
  status: { ok: true, value: statusPayload },
  diff: { ok: true, value: { binary: false, added: 2, removed: 2, hunks: twoHunks.hunks } },
};
let overlapTree = await render(tabComponent, tabProps);
walk(overlapTree).find((node) => node.type === 'button' && node.props.title === 'src/modified.ts').props.onClick();
overlapTree = await render(tabComponent, tabProps);
let releaseWrite;
scripted['stage-hunk'] = () => new Promise((resolve) => { releaseWrite = () => resolve({ ok: true, value: {} }); });
walk(overlapTree).find((node) => node.props?.['aria-label'] === 'Stage hunk').props.onClick();
overlapTree = await render(tabComponent, tabProps);
const statusCountDuringWrite = requests.filter((entry) => entry.target.includes('/status?')).length;
const refreshDuringWrite = walk(overlapTree).find((node) => node.props?.['aria-label'] === 'Refresh');
check(refreshDuringWrite.props.disabled === true, 'Refresh is disabled during a write');
refreshDuringWrite.props.onClick();
overlapTree = await render(tabComponent, tabProps);
check(requests.filter((entry) => entry.target.includes('/status?')).length === statusCountDuringWrite, 'the refresh handler also rejects clicks while writing');
scripted.status = () => new Promise((resolve) => { releaseStatus = () => resolve({ ok: true, value: statusPayload }); });
releaseWrite();
overlapTree = await render(tabComponent, tabProps);
check(textsOf(overlapTree, 'dsc-hunkHead').length === 0, 'completing a held write waits for the post-write status generation');
releaseStatus();
scripted.status = { ok: true, value: statusPayload };
overlapTree = await render(tabComponent, tabProps);
check(textsOf(overlapTree, 'dsc-hunkHead').length === 2, 'post-write status and diff recover after a guarded refresh');

// A status request started BEFORE the write can still finish DURING it. Busy
// gating blocks its diff; the final reload nonce rejects its data afterward.
scripted.status = () => new Promise((resolve) => { releaseStatus = () => resolve({ ok: true, value: statusPayload }); });
walk(overlapTree).find((node) => node.props?.['aria-label'] === 'Refresh').props.onClick();
overlapTree = await render(tabComponent, tabProps);
const releasePreWriteStatus = releaseStatus;
scripted.stage = () => new Promise((resolve) => { releaseWrite = () => resolve({ ok: true, value: {} }); });
walk(overlapTree).find((node) => node.props?.['aria-label'] === 'Stage').props.onClick();
overlapTree = await render(tabComponent, tabProps);
releasePreWriteStatus();
overlapTree = await render(tabComponent, tabProps);
check(textsOf(overlapTree, 'dsc-hunkHead').length === 0, 'a pre-write refresh resolving during the write cannot load actionable hunks');
const diffsBeforeFinalStatus = requests.filter((entry) => entry.target.includes('/diff?')).length;
releaseWrite();
overlapTree = await render(tabComponent, tabProps);
check(textsOf(overlapTree, 'dsc-hunkHead').length === 0, 'intermediate status never becomes actionable after the write completes');
check(requests.filter((entry) => entry.target.includes('/diff?')).length === diffsBeforeFinalStatus, 'only the post-write status generation may start a new diff');
releaseStatus();
scripted.status = { ok: true, value: statusPayload };
overlapTree = await render(tabComponent, tabProps);
check(textsOf(overlapTree, 'dsc-hunkHead').length === 2, 'the post-write generation restores hunks after an overlapping refresh');

// ---------------------------------------------------------------------------
console.log('\n## configured branch operations and captured source contracts');
const cleanPayload = {
  repository: { ...statusPayload.repository, branch: 'main' },
  status: { ...statusPayload.status, branch: 'main', upstream: null, staged: [], changes: [], untracked: [], conflicted: [] },
};
const branchFixture = {
  current: 'main', head: 'a'.repeat(40),
  local: [
    { name: 'main', current: true, upstream: null, upstreamTarget: null },
    { name: 'topic', current: false, upstream: 'origin/review', upstreamTarget: { remote: 'origin', branch: 'review' } },
  ],
  remote: [{ name: 'origin/review', remote: 'origin', branch: 'review' }],
  remotes: [{ name: 'origin' }, { name: 'backup' }],
};
const networkWrites = () => requests.filter((entry) => entry.method === 'POST' && /\/(fetch|pull|push)(?:\?|$)/.test(entry.target));
const buttonText = (root, label) => walk(root).find((node) => node.type === 'button' && textOf(node) === label);
const labelled = (root, label) => walk(root).find((node) => node.props?.['aria-label'] === label && node.props.role !== 'dialog');
const dialogOf = (root) => walk(root).find((node) => node.props?.role === 'dialog');
const dialogConfirm = (root) => walk(dialogOf(root)).find((node) => node.type === 'button' && node.props.className === 'dsc-btn');
async function operationTree(label, { payload = cleanPayload, branches = branchFixture } = {}) {
  reset();
  scripted = { git: catalogFixture, status: { ok: true, value: payload }, branches: { ok: true, value: branches } };
  let root = await render(pageComponent, pageProps);
  if (label === t('action.branches')) labelled(root, label).props.onClick();
  else {
    labelled(root, t('action.more')).props.onClick();
    root = await render(pageComponent, pageProps);
    buttonText(root, label).props.onClick();
  }
  return render(pageComponent, pageProps);
}

console.log('\n## GitHub navigation from configured remotes');
reset();
scripted = {
  git: catalogFixture,
  status: { ok: true, value: cleanPayload },
  branches: { ok: true, value: {
    ...branchFixture,
    remotes: [
      { name: 'origin', github: {
        url: 'https://github.com/PaiMonCai/dsh-source-control',
        pullsUrl: 'https://github.com/PaiMonCai/dsh-source-control/pulls',
        issuesUrl: 'https://github.com/PaiMonCai/dsh-source-control/issues',
      } },
      { name: 'backup' },
    ],
  } },
};
let githubTree = await render(pageComponent, pageProps);
labelled(githubTree, t('action.more')).props.onClick();
githubTree = await render(pageComponent, pageProps);
const githubAnchors = walk(githubTree).filter((node) => node.type === 'a' && typeof node.props.href === 'string' && node.props.href.startsWith('https://github.com/'));
check(githubAnchors.length === 3 && githubAnchors.some((node) => node.props.href.endsWith('/pulls')) && githubAnchors.some((node) => node.props.href.endsWith('/issues')), 'GitHub repository/PR/Issue links appear in the More menu');
check(githubAnchors.every((node) => node.props.target === '_blank' && node.props.rel === 'noopener noreferrer'), 'external GitHub navigation is isolated from the DSH app');
check(networkWrites().length === 0, 'opening GitHub links does not run Git transport');

// In-app review: read-only PR details, file patch and Checks.
reset();
scripted = {
  git: catalogFixture,
  status: { ok: true, value: cleanPayload },
  branches: { ok: true, value: {
    ...branchFixture, remotes: [
      { name: 'origin', github: {
        url: 'https://github.com/PaiMonCai/dsh-source-control',
        pullsUrl: 'https://github.com/PaiMonCai/dsh-source-control/pulls',
        issuesUrl: 'https://github.com/PaiMonCai/dsh-source-control/issues',
      } },
    ],
  } },
  'github-pulls': { ok: true, value: {
    items: [{ number: 9, title: 'Add review UI', state: 'open', author: 'tester', draft: false }],
    limit: 30,
  } },
  'github-pull-discussion': { ok: true, value: {
    number: 9,
    entries: [
      { id: 1, kind: 'comment', author: 'alice', body: 'Discussion item', createdAt: '2026-10-01T00:00:00Z' },
      { id: 2, kind: 'review', author: 'bob', state: 'APPROVED', body: 'Review approved', createdAt: '2026-10-02T00:00:00Z' },
    ],
    limited: false,
  } },
  'github-pull-detail': { ok: true, value: {
    pull: { number: 9, title: 'Add review UI', state: 'open', author: 'tester', head: 'feature', base: 'main', body: 'Review this change' },
    files: [{ filename: 'file.ts', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\\n-old\\n+new' }],
    checks: [{ name: 'CI', status: 'completed', conclusion: 'success' }],
  } },
  'github-issues': { ok: true, value: { items: [{ number: 11, title: 'Issue example', state: 'open', author: 'tester' }] } },
};
let ghView = await render(pageComponent, pageProps);
const reviewButton = walk(ghView).find((node) => node.type === 'button' && node.props.title === t('github.review'));
check(reviewButton !== undefined, 'GitHub review workbench has a discoverable entry');
reviewButton?.props.onClick();
ghView = await render(pageComponent, pageProps);
check(requests.some((entry) => entry.method === 'GET' && entry.target.includes('/github-pulls?')), 'opening GitHub review loads PR list using GET');
check(textOf(ghView).includes('Add review UI'), 'PR list renders within DSH');
const selectedPr = walk(ghView).find((node) => node.type === 'button' && node.props.className === 'dsc-gh-entry');
selectedPr?.props.onClick();
ghView = await render(pageComponent, pageProps);
check(requests.some((entry) => entry.method === 'GET' && entry.target.includes('/github-pull-detail?') && entry.target.includes('number=9')), 'PR selection requests detail by number only');
check(textOf(ghView).includes('Review this change') && textOf(ghView).includes('file.ts'), 'PR detail and changed-file selector render');
check(!requests.some((entry) => entry.target.includes('/github-pull-discussion?')), 'PR detail does not prefetch discussion unnecessarily');
const showDiscussion = buttonText(ghView, t('github.discussionShow'));
check(showDiscussion !== undefined, 'discussion entry is available in PR details');
showDiscussion?.props.onClick();
ghView = await render(pageComponent, pageProps);
check(requests.some((entry) => entry.method === 'GET' && entry.target.includes('/github-pull-discussion?') && entry.target.includes('number=9')), 'review discussions load only after explicit user open');
check(textOf(ghView).includes('Discussion item') && textOf(ghView).includes('APPROVED'), 'PR discussion and review decision render in the workbench');
check(!walk(ghView).some((node) => node.type === 'button' && /submit review|post comment/i.test(textOf(node))), 'discussion remains read-only without user-scoped OAuth');

check(networkWrites().length === 0, 'GitHub read-only review never invokes Git transport');

console.log('\n## explicitly authorized GitHub PR creation');
reset();
scripted = {
  git: catalogFixture,
  status: { ok: true, value: cleanPayload },
  branches: { ok: true, value: {
    current: 'feature', head: 'abc',
    local: [{ name: 'feature', current: true, hash: 'abc', upstreamTarget: { remote: 'origin', branch: 'feature' } }],
    remote: [{ name: 'origin/feature', remote: 'origin', branch: 'feature', hash: 'abc' },
      { name: 'origin/main', remote: 'origin', branch: 'main', hash: 'def' }],
    remotes: [{ name: 'origin', github: {
      url: 'https://github.com/PaiMonCai/dsh-source-control',
      pullsUrl: 'https://github.com/PaiMonCai/dsh-source-control/pulls',
      issuesUrl: 'https://github.com/PaiMonCai/dsh-source-control/issues',
    } }],
  } },
  'github-pulls': { ok: true, value: { items: [], capabilities: { authenticated: true, canCreate: true } } },
  'github-create-pull': { ok: true, value: { pull: { number: 77, title: 'Ready to review' } } },
};
let creationTree = await render(pageComponent, pageProps);
walk(creationTree).find((node) => node.type === 'button' && node.props.title === t('github.review')).props.onClick();
creationTree = await render(pageComponent, pageProps);
const createOpen = buttonText(creationTree, t('github.create'));
check(createOpen !== undefined, 'host-approved GitHub repo shows create PR button');
createOpen?.props.onClick();
creationTree = await render(pageComponent, pageProps);
const createDialog = walk(creationTree).find((node) => node.props?.role === 'dialog' && node.props?.['aria-label'] === t('github.create'));
check(createDialog !== undefined, 'PR creation is in an explicit dialog');
const titleBox = walk(createDialog).find((node) => node.type === 'input' && node.props.className === 'dsc-input');
titleBox?.props.onChange({ target: { value: 'Ready to review' } });
creationTree = await render(pageComponent, pageProps);
buttonText(creationTree, t('github.createConfirm'))?.props.onClick();
creationTree = await render(pageComponent, pageProps);
check(!requests.some((req) => req.target.includes('/github-create-pull?')), 'first confirmation does not create a GitHub PR');
await buttonText(creationTree, t('github.createSubmit'))?.props.onClick();
check(requests.filter((req) => req.target.includes('/github-create-pull?') && req.method === 'POST').length === 1, 'second confirmation sends one GitHub PR creation POST');
check(requests.find((req) => req.target.includes('/github-create-pull?'))?.body?.confirmed === true, 'PR write carries explicit confirmation flag');
check(networkWrites().length === 0, 'GitHub PR creation never invokes git push or pull');


let opTree = await operationTree(t('action.branches'));
check(dialogOf(opTree)?.props['aria-label'] === t('action.branches'), 'the branch button opens an actual switch dialog');
check(networkWrites().length === 0, 'opening branch controls never starts a network write');
check(walk(dialogOf(opTree)).some((node) => node.type === 'option' && node.props.value === 'local:main' && node.props.disabled), 'the current branch cannot be selected as a switch target');
await dialogConfirm(opTree).props.onClick();
check(requests.some((entry) => entry.method === 'POST' && entry.target.includes('/switch-branch?') && entry.body.repo === '/repo' && entry.body.branch === 'topic' && !('remoteBranch' in entry.body)), 'a local switch sends the repository and local target only');

opTree = await operationTree(t('action.branches'));
labelled(dialogOf(opTree), t('action.branches')).props.onChange({ target: { value: 'remote:origin/review' } });
opTree = await render(pageComponent, pageProps);
check(labelled(dialogOf(opTree), t('branch.name')).props.value === 'review', 'a tracking switch proposes the remote branch basename');
labelled(dialogOf(opTree), t('branch.name')).props.onChange({ target: { value: 'local-review' } });
opTree = await render(pageComponent, pageProps);
await dialogConfirm(opTree).props.onClick();
check(requests.some((entry) => entry.target.includes('/switch-branch?') && entry.body.branch === 'local-review' && entry.body.remoteBranch === 'origin/review'), 'tracking creation sends separate local and configured remote-tracking names');

opTree = await operationTree(t('action.createBranch'));
check(dialogConfirm(opTree).props.disabled, 'creating a branch requires an explicit nonempty name');
labelled(dialogOf(opTree), t('branch.name')).props.onChange({ target: { value: '  feature/new  ' } });
opTree = await render(pageComponent, pageProps);
await dialogConfirm(opTree).props.onClick();
check(requests.some((entry) => entry.target.includes('/create-branch?') && entry.body.branch === 'feature/new' && entry.body.repo === '/repo'), 'branch creation sends the trimmed explicit local name');

for (const label of [t('action.branches'), t('action.createBranch'), t('action.pull')]) {
  opTree = await operationTree(label, { payload: { ...statusPayload, repository: cleanPayload.repository } });
  check(dialogConfirm(opTree).props.disabled && textOf(dialogOf(opTree)).includes('clean working tree'), `${label} explains and disables dirty-tree operations`);
  await dialogConfirm(opTree).props.onClick();
  check(!requests.some((entry) => entry.method === 'POST'), `${label} handler refuses a dirty tree without stash or write`);
}

opTree = await operationTree(t('action.fetch'));
check(networkWrites().length === 0, 'opening Fetch does not automatically fetch');
check(textOf(dialogOf(opTree)).includes('/repo'), 'Fetch confirmation identifies the repository');
check(walk(labelled(dialogOf(opTree), t('remote.label'))).filter((node) => node.type === 'option').map((node) => node.props.value).join(',') === 'origin,backup', 'Fetch offers configured remote names, not an arbitrary URL editor');
labelled(dialogOf(opTree), t('remote.label')).props.onChange({ target: { value: 'backup' } });
opTree = await render(pageComponent, pageProps);
let releaseFetch;
scripted.fetch = () => new Promise((resolve) => { releaseFetch = () => resolve({ ok: true, value: {} }); });
const fetchConfirm = dialogConfirm(opTree);
const fetching = fetchConfirm.props.onClick();
fetchConfirm.props.onClick();
check(networkWrites().length === 1 && networkWrites()[0].body.remote === 'backup', 'rapid Fetch confirmations share the synchronous write guard');
opTree = await render(pageComponent, pageProps);
check(dialogConfirm(opTree).props.disabled && textOf(dialogOf(opTree)).includes('Operation in progress'), 'the open operation shows progress and disables submission');
const branchReadsBeforeFetchDone = requests.filter((entry) => entry.target.includes('/branches?')).length;
let releaseBranches;
scripted.branches = () => new Promise((resolve) => { releaseBranches = () => resolve({ ok: true, value: branchFixture }); });
releaseFetch();
await fetching;
opTree = await render(pageComponent, pageProps);
check(requests.filter((entry) => entry.target.includes('/branches?')).length > branchReadsBeforeFetchDone, 'a completed network write invalidates branch data');
labelled(opTree, t('action.more')).props.onClick();
opTree = await render(pageComponent, pageProps);
buttonText(opTree, t('action.push')).props.onClick();
opTree = await render(pageComponent, pageProps);
check(!dialogOf(opTree) && textOf(opTree).includes('Branch information is unavailable'), 'obsolete branch data cannot open another operation dialog');
releaseBranches();
scripted.branches = { ok: true, value: branchFixture };
await render(pageComponent, pageProps);

opTree = await operationTree(t('action.pull'));
check(textOf(dialogOf(opTree)).includes('main → origin/main') && textOf(dialogOf(opTree)).includes('fast-forward'), 'Pull presents the captured source, configured target and fast-forward policy');
labelled(dialogOf(opTree), t('remote.branch')).props.onChange({ target: { value: 'release' } });
opTree = await render(pageComponent, pageProps);
check(networkWrites().length === 0, 'changing Pull destination performs no network operation');
await dialogConfirm(opTree).props.onClick();
check(networkWrites().length === 1 && networkWrites()[0].body.sourceBranch === 'main' && networkWrites()[0].body.branch === 'release', 'Pull sends the captured source independently of a different legitimate destination');

opTree = await operationTree(t('action.push'));
check(networkWrites().length === 0, 'opening Push never automatically pushes');
await dialogConfirm(opTree).props.onClick();
opTree = await render(pageComponent, pageProps);
check(networkWrites().length === 0 && textOf(dialogOf(opTree)).includes('no upstream'), 'first Push confirmation only explains explicit upstream setup');
check(textOf(dialogOf(opTree)).includes('/repo: main → origin/main') && textOf(dialogConfirm(opTree)) === t('remote.upstream'), 'second upstream confirmation includes repository, source and target');
labelled(dialogOf(opTree), t('remote.branch')).props.onChange({ target: { value: 'review-destination' } });
opTree = await render(pageComponent, pageProps);
check(textOf(dialogConfirm(opTree)) === t('action.confirm'), 'editing the destination resets upstream confirmation');
await dialogConfirm(opTree).props.onClick();
opTree = await render(pageComponent, pageProps);
await dialogConfirm(opTree).props.onClick();
check(networkWrites().length === 1 && networkWrites()[0].body.sourceBranch === 'main' && networkWrites()[0].body.branch === 'review-destination' && networkWrites()[0].body.setUpstream === true, 'confirmed first Push sends captured source, distinct destination and explicit setUpstream');

const trackedFixture = { ...branchFixture, local: [
  { ...branchFixture.local[0], upstream: 'origin/review', upstreamTarget: { remote: 'origin', branch: 'review' } },
  branchFixture.local[1],
] };
opTree = await operationTree(t('action.push'), { branches: trackedFixture });
check(labelled(dialogOf(opTree), t('remote.branch')).props.value === 'review', 'an existing upstream resolves its actual destination branch');
await dialogConfirm(opTree).props.onClick();
check(networkWrites().length === 1 && networkWrites()[0].body.sourceBranch === 'main' && networkWrites()[0].body.branch === 'review' && !('setUpstream' in networkWrites()[0].body), 'ordinary tracked Push sends source guard without resetting upstream');

// A conflicted path is listed for visibility only: the command layer cannot
// stage, unstage or discard an unmerged path today, so the rows must not offer
// controls that would silently do nothing.
const conflictPayload = {
  repository: { ...statusPayload.repository, branch: 'main' },
  status: {
    ...statusPayload.status, branch: 'main', upstream: null, staged: [], untracked: [], changes: [],
    conflicted: [{ path: 'src/conflict.ts', origPath: null, renamed: false, staged: false, indexStatus: 'U', worktreeStatus: 'U', untracked: false, unmerged: true }],
  },
};
reset();
opTree = await operationTree(t('action.branches'), { payload: conflictPayload });
const toolSets = (root) => walk(root).filter((node) => typeof node.props?.className === 'string' && node.props.className.includes('dsc-rowTools'));
check(walk(opTree).some((node) => node.props?.title === 'src/conflict.ts'), 'a conflicted file is still listed');
check(toolSets(opTree).length === 0, 'a conflicted row offers no inert stage/discard controls', toolSets(opTree).length);
opTree = await operationTree(t('action.branches'), { payload: statusPayload });
check(toolSets(opTree).length === 3, 'ordinary rows still offer their per-file controls', toolSets(opTree).length);

// A configured upstream survives a pruned/never-fetched tracking ref. The
// display name alone is not a target: resolving it against `branches.remote`
// would silently substitute the first configured remote.
const prunedFixture = { ...branchFixture, local: [
  { name: 'main', current: true, upstream: 'backup/release', upstreamTarget: { remote: 'backup', branch: 'release' } },
  branchFixture.local[1],
] };
opTree = await operationTree(t('action.push'), { branches: prunedFixture });
check(labelled(dialogOf(opTree), t('remote.label')).props.value === 'backup', 'a missing tracking ref does not fall back to the first configured remote');
check(labelled(dialogOf(opTree), t('remote.branch')).props.value === 'release', 'a missing tracking ref keeps its real destination branch');
await dialogConfirm(opTree).props.onClick();
check(networkWrites().length === 1 && networkWrites()[0].body.remote === 'backup' && networkWrites()[0].body.branch === 'release' && !('setUpstream' in networkWrites()[0].body), 'an ordinary tracked Push uses the structured upstream, not the display name');

// A `.` upstream tracks a local branch. It is not a remote target, so the
// first remote push still has to announce the upstream it creates.
const localUpstreamFixture = { ...branchFixture, local: [
  { name: 'main', current: true, upstream: 'topic', upstreamTarget: null },
  branchFixture.local[1],
] };
opTree = await operationTree(t('action.push'), { branches: localUpstreamFixture });
await dialogConfirm(opTree).props.onClick();
opTree = await render(pageComponent, pageProps);
check(networkWrites().length === 0 && textOf(dialogOf(opTree)).includes('no upstream'), 'a local upstream still counts as no remote upstream');
check(textOf(dialogConfirm(opTree)) === t('remote.upstream'), 'a local upstream cannot skip the explicit upstream confirmation');

// The captured target may name a remote that has since been removed. The
// recorded intent stays visible, but it must not be silently re-pointed.
const removedRemoteFixture = { ...branchFixture, local: [
  { name: 'main', current: true, upstream: 'gone/release', upstreamTarget: { remote: 'gone', branch: 'release' } },
  branchFixture.local[1],
] };
opTree = await operationTree(t('action.pull'), { branches: removedRemoteFixture });
check(textOf(dialogOf(opTree)).includes('no longer configured'), 'a removed upstream remote is reported explicitly');
check(labelled(dialogOf(opTree), t('remote.label')).props.value === 'gone', 'the removed remote stays selected instead of snapping to the first option');
check(dialogConfirm(opTree).props.disabled, 'a removed upstream remote cannot be submitted as-is');
await dialogConfirm(opTree).props.onClick();
check(networkWrites().length === 0, 'a removed upstream remote sends nothing');
labelled(dialogOf(opTree), t('remote.label')).props.onChange({ target: { value: 'origin' } });
opTree = await render(pageComponent, pageProps);
await dialogConfirm(opTree).props.onClick();
check(networkWrites().length === 1 && networkWrites()[0].body.remote === 'origin' && networkWrites()[0].body.sourceBranch === 'main', 'a deliberate remote choice may retry with the captured source');

for (const label of [t('action.pull'), t('action.push')]) {
  opTree = await operationTree(label);
  if (label === t('action.push')) { await dialogConfirm(opTree).props.onClick(); opTree = await render(pageComponent, pageProps); }
  const capturedConfirm = dialogConfirm(opTree);
  scripted.status = { ok: true, value: { ...cleanPayload, repository: { ...cleanPayload.repository, branch: 'other-source' } } };
  scripted.branches = { ok: true, value: { ...branchFixture, current: 'other-source', local: [{ name: 'other-source', current: true, upstream: 'origin/review', upstreamTarget: { remote: 'origin', branch: 'review' } }] } };
  labelled(opTree, t('action.refresh')).props.onClick();
  opTree = await render(pageComponent, pageProps);
  check(dialogConfirm(opTree).props.disabled && textOf(dialogOf(opTree)).includes('source branch changed'), `${label} disables and warns after a refreshed branch change`);
  check(textOf(dialogOf(opTree)).includes('main → origin/main'), `${label} still presents the originally captured source and destination`);
  await dialogConfirm(opTree).props.onClick();
  check(networkWrites().length === 0, `${label} current stale handler sends nothing`);
  // A previously captured DOM handler may race refresh. It must still send the
  // original source, allowing the host execution guard to reject the mismatch.
  scripted[label === t('action.pull') ? 'pull' : 'push'] = { ok: false, error: { code: 'git/source-branch-changed', message: 'Source branch changed at execution' } };
  await capturedConfirm.props.onClick();
  opTree = await render(pageComponent, pageProps);
  check(networkWrites().length === 1 && networkWrites()[0].body.sourceBranch === 'main', `${label} even a stale captured handler never reinterprets source from refreshed props`);
  check(textOf(opTree).includes('Source branch changed at execution') && !!dialogOf(opTree), `${label} host refusal is shown and does not silently close the dialog`);
}

for (const failedRead of ['status', 'branches']) {
  opTree = await operationTree(t('action.push'));
  await dialogConfirm(opTree).props.onClick();
  opTree = await render(pageComponent, pageProps);
  scripted[failedRead] = { ok: false, error: { code: 'git/failure', message: `${failedRead} temporarily unavailable` } };
  const newBranchData = { ...branchFixture, current: 'recovered-source', local: [{ name: 'recovered-source', current: true, upstream: 'origin/review' }] };
  const newStatus = { ...cleanPayload, repository: { ...cleanPayload.repository, branch: 'recovered-source' } };
  if (failedRead === 'status') scripted.branches = { ok: true, value: newBranchData };
  else scripted.status = { ok: true, value: newStatus };
  labelled(opTree, t('action.refresh')).props.onClick();
  opTree = await render(pageComponent, pageProps);
  check(!dialogOf(opTree), `${failedRead} failure temporarily removes the unavailable dialog`);
  // This fake runtime keeps absent cells by default. Explicitly drop only the
  // absent dialog cells here to model React's real unmount/remount lifecycle.
  for (const [key, cell] of cells) if (key.includes('/GitDialog:push#')) {
    cell.cleanup?.();
    cells.delete(key);
  }
  scripted.status = { ok: true, value: newStatus };
  scripted.branches = { ok: true, value: newBranchData };
  (labelled(opTree, t('action.refresh')) ?? buttonText(opTree, t('action.refresh'))).props.onClick();
  opTree = await render(pageComponent, pageProps);
  check(textOf(dialogOf(opTree)).includes('main → origin/main'), `${failedRead} recovery remount retains the original opening source`);
  check(dialogConfirm(opTree).props.disabled && textOf(dialogOf(opTree)).includes('source branch changed'), `${failedRead} recovery cannot reinterpret and submit the newer branch`);
  await dialogConfirm(opTree).props.onClick();
  check(networkWrites().length === 0, `${failedRead} recovery performs no automatic or stale-source push`);
}

opTree = await operationTree(t('action.push'), { branches: { ...branchFixture, current: 'topic' } });
check(!dialogOf(opTree) && textOf(opTree).includes('source branch changed'), 'disagreeing loaded branch and repository status refuse opening a source operation');
opTree = await operationTree(t('action.fetch'), { branches: { ...branchFixture, remotes: [] } });
check(dialogConfirm(opTree).props.disabled && textOf(dialogOf(opTree)).includes('No remotes'), 'a repository without configured remotes cannot submit Fetch');
opTree = await operationTree(t('action.push'), { payload: { ...cleanPayload, repository: { ...cleanPayload.repository, branch: null } }, branches: { ...branchFixture, current: null, local: [] } });
check(dialogConfirm(opTree).props.disabled && textOf(dialogOf(opTree)).includes('Detached HEAD'), 'detached HEAD cannot submit Push');

console.log('\n## tree view and filtering retain group actions');
reset();
scripted = { git: catalogFixture, status: { ok: true, value: statusPayload } };
let featureTree = await render(pageComponent, pageProps);
labelled(featureTree, t('files.tree')).props.onClick();
featureTree = await render(pageComponent, pageProps);
check(textsOf(featureTree, 'dsc-folder').length === 2 && textsOf(featureTree, 'dsc-name').length === 3, 'Tree creates real folders separately for Staged and Changes');
const folderToggle = walk(featureTree).find((node) => node.props?.className === 'dsc-folder').children[0];
folderToggle.props.onClick();
featureTree = await render(pageComponent, pageProps);
check(textsOf(featureTree, 'dsc-name').length === 2, 'collapsing one folder leaves the other change group expanded');
labelled(featureTree, t('files.filter')).props.onChange({ target: { value: 'MODIFIED' } });
featureTree = await render(pageComponent, pageProps);
check(textsOf(featureTree, 'dsc-name').length === 1 && textsOf(featureTree, 'dsc-name')[0].includes('modified.ts'), 'tree filtering is case-insensitive and matches full paths');
await labelled(featureTree, t('action.stageAll')).props.onClick();
check(requests.some((entry) => entry.target.includes('/stage?') && entry.body.paths.join(',') === 'src/modified.ts'), 'filtered tree bulk action sends only its visible group paths');
featureTree = await render(pageComponent, pageProps);
labelled(featureTree, t('files.filter')).props.onChange({ target: { value: 'no-such-file' } });
featureTree = await render(pageComponent, pageProps);
check(textOf(featureTree).includes('No changed files match'), 'a filter with no matches explains the empty result');
labelled(featureTree, t('files.list')).props.onClick();
labelled(featureTree, t('files.filter')).props.onChange({ target: { value: '' } });
featureTree = await render(pageComponent, pageProps);
check(textsOf(featureTree, 'dsc-folder').length === 0 && textsOf(featureTree, 'dsc-name').length === 3, 'returning to List and clearing filter restores all rows');

console.log('\n## graph ancestry and historic readonly selection');
reset();
const hashA = 'a'.repeat(40), hashB = 'b'.repeat(40), hashC = 'c'.repeat(40), hashOutside = 'd'.repeat(40);
const graphFixture = [
  { hash: hashA, short: 'aaaaaaa', parents: [hashB, hashOutside], refs: [{ kind: 'local', name: 'main' }, { kind: 'tag', name: 'v1' }], author: 'A', date: '2026-10-01', subject: 'Merge real parents' },
  { hash: hashC, short: 'ccccccc', parents: [], refs: [{ kind: 'remote', name: 'origin/independent' }], author: 'C', date: '2026-09-30', subject: 'Independent tip' },
  { hash: hashB, short: 'bbbbbbb', parents: [], refs: [], author: 'B', date: '2026-09-29', subject: 'Real ancestor' },
];
scripted = {
  git: catalogFixture, status: { ok: true, value: statusPayload },
  graph: { ok: true, value: { commits: graphFixture, hasMore: false } },
  'commit-details': ({ target }) => {
    const hash = new URL(target, window.location.origin).searchParams.get('hash');
    const commit = graphFixture.find((row) => row.hash === hash);
    return { ok: true, value: { commit: { ...commit, message: 'Full commit message\n\nBody details' }, files: [{ path: 'old/name.txt', oldPath: null, status: 'M' }, { path: 'new/name.txt', oldPath: 'previous.txt', status: 'R' }] } };
  },
  'commit-diff': { ok: true, value: { binary: false, hunks: twoHunks.hunks, added: 2, removed: 2 } },
};
featureTree = await render(pageComponent, pageProps);
check(!requests.some((entry) => entry.target.includes('/log?')), 'history consumes graph without a legacy log fallback');
const parentEdges = walk(featureTree).filter((node) => node.props?.['data-parent-hash']);
check(parentEdges.map((node) => node.props['data-parent-hash']).join(',') === `${hashB},${hashOutside}`, 'graph edges encode only the actual supplied parents');
check(parentEdges.find((node) => node.props['data-parent-hash'] === hashOutside).props.strokeDasharray === '3 2' && textOf(parentEdges).includes(hashOutside), 'unloaded ancestry is dashed and explicitly labelled');
check(!parentEdges.find((node) => node.props['data-parent-hash'] === hashB).props.strokeDasharray, 'a loaded parent uses a solid ancestry edge');
check(textsOf(featureTree, 'dsc-ref').join(',') === 'main,v1,origin/independent', 'actual local, tag and remote ref metadata are rendered');
check(walk(featureTree).filter((node) => node.props?.className === 'dsc-ref').map((node) => node.props['data-ref-kind']).join(',') === 'local,tag,remote', 'ref kinds remain inspectable metadata');
walk(featureTree).find((node) => node.props?.['data-commit-hash'] === hashA).props.onClick();
featureTree = await render(pageComponent, pageProps);
check(textOf(featureTree).includes('Full commit message') && textOf(featureTree).includes(hashOutside), 'historic details show the full message and actual parent IDs');
check(requests.some((entry) => entry.target.includes('/commit-details?') && entry.target.includes(`hash=${hashA}`)), 'historic details request the full selected object ID');
check(textsOf(featureTree, 'dsc-name').length === 3, 'opening historic details preserves every main change row');
walk(featureTree).find((node) => node.type === 'button' && node.props.title === 'old/name.txt').props.onClick();
featureTree = await render(pageComponent, pageProps);
check(requests.some((entry) => entry.target.includes('/commit-diff?') && entry.target.includes(`hash=${hashA}`) && entry.target.includes('path=old%2Fname.txt')), 'historic file selection requests a commit-scoped readonly diff');
check(textsOf(featureTree, 'dsc-hunkHead').length === 2 && textsOf(featureTree, 'dsc-diffSide').includes(t('history.readOnly')), 'historic diff renders hunks with a readonly context');
const historicEditor = walk(featureTree).find((node) => node.props?.className === 'dsc-editor');
check(!walk(historicEditor).some((node) => node.props?.className?.includes('dsc-btn-mini') || [t('action.stage'), t('action.unstage'), t('action.discard')].includes(node.props?.['aria-label'])), 'historical editor offers no worktree or hunk write controls');
labelled(historicEditor, t('action.back')).props.onClick();
featureTree = await render(pageComponent, pageProps);
scripted['commit-diff'] = { ok: false, error: { code: 'git/failure', message: 'historic selection failed' } };
walk(featureTree).find((node) => node.type === 'button' && node.props.title === 'old/name.txt').props.onClick();
featureTree = await render(pageComponent, pageProps);
check(textOf(featureTree).includes('historic selection failed'), 'historic file errors provide visible retry feedback');
labelled(walk(featureTree).find((node) => node.props?.className === 'dsc-editor'), t('action.back')).props.onClick();
featureTree = await render(pageComponent, pageProps);
scripted['commit-diff'] = { ok: true, value: { binary: false, hunks: twoHunks.hunks } };
walk(featureTree).find((node) => node.type === 'button' && node.props.title === 'previous.txt → new/name.txt').props.onClick();
check(!textOf(pageComponent(pageProps)).includes('historic selection failed'), 'another historic file never displays the previous selection error');
featureTree = await render(pageComponent, pageProps);
check(textsOf(featureTree, 'dsc-diffPath').includes('new/name.txt') && textsOf(featureTree, 'dsc-hunkHead').length === 2, 'another historical file recovers normally after an error');

console.log('\n## separator keyboard, pointer cancellation and mobile structure');
const separator = (root, axis) => walk(root).find((node) => node.props?.className === `dsc-resize dsc-resize-${axis}`);
let widthHandle = separator(featureTree, 'width');
check(widthHandle.props['aria-orientation'] === 'vertical' && widthHandle.props['aria-valuenow'] === 34 && widthHandle.props['aria-valuemin'] === 18 && widthHandle.props['aria-valuemax'] === 75, 'width separator exposes bounded percent geometry');
widthHandle.props.onKeyDown({ key: 'ArrowRight', shiftKey: true, preventDefault() {} });
featureTree = await render(pageComponent, pageProps);
check(separator(featureTree, 'width').props['aria-valuenow'] === 44, 'Shift+arrow adjusts navigation by ten percent');
separator(featureTree, 'width').props.onKeyDown({ key: 'End', preventDefault() {} });
featureTree = await render(pageComponent, pageProps);
check(separator(featureTree, 'width').props['aria-valuenow'] === 75, 'End respects the maximum navigation ratio');
separator(featureTree, 'width').props.onDoubleClick();
featureTree = await render(pageComponent, pageProps);
check(separator(featureTree, 'width').props['aria-valuenow'] === 34, 'double-click resets navigation geometry');
separator(featureTree, 'height').props.onKeyDown({ key: 'Home', preventDefault() {} });
featureTree = await render(pageComponent, pageProps);
check(separator(featureTree, 'height').props['aria-valuenow'] === 0 && textsOf(featureTree, 'dsc-commitSubject').length === 0, 'history Home collapses the graph instead of hiding the file list');
separator(featureTree, 'height').props.onKeyDown({ key: 'Enter', preventDefault() {} });
featureTree = await render(pageComponent, pageProps);
check(separator(featureTree, 'height').props['aria-valuenow'] === 40, 'history Enter restores the default ratio');
const pointerTarget = {
  captured: new Set(), released: [], parentElement: { getBoundingClientRect: () => ({ left: 0, bottom: 500, width: 1000, height: 500 }) },
  setPointerCapture(id) { this.captured.add(id); }, hasPointerCapture(id) { return this.captured.has(id); },
  releasePointerCapture(id) { this.captured.delete(id); this.released.push(id); },
};
const pointerEvent = (pointerId, extra = {}) => ({ pointerId, currentTarget: pointerTarget, button: 0, preventDefault() {}, ...extra });
widthHandle = separator(featureTree, 'width');
widthHandle.props.onPointerDown(pointerEvent(7));
widthHandle.props.onPointerMove(pointerEvent(8, { clientX: 500 }));
featureTree = await render(pageComponent, pageProps);
check(separator(featureTree, 'width').props['aria-valuenow'] === 34, 'an unrelated pointer cannot change captured geometry');
widthHandle.props.onPointerMove(pointerEvent(7, { clientX: 495 }));
featureTree = await render(pageComponent, pageProps);
check(separator(featureTree, 'width').props['aria-valuenow'] === 50, 'pointer movement snaps to nearby navigation stops');
separator(featureTree, 'width').props.onPointerCancel(pointerEvent(7));
featureTree = await render(pageComponent, pageProps);
check(separator(featureTree, 'width').props['aria-valuenow'] === 34 && pointerTarget.released.includes(7), 'pointer cancellation restores the initial ratio and releases capture');
separator(featureTree, 'width').props.onPointerDown(pointerEvent(9));
for (const [key, cell] of cells) if (key.includes('ResizeHandle:width#effect') && cell.cleanup) cell.cleanup();
check(pointerTarget.released.includes(9), 'separator unmount cleanup releases any active pointer capture');
const responsiveCSS = styles.join('\n').split('@media (max-width:540px)')[1]?.split('@media')[0] ?? '';
check(responsiveCSS.includes('.dsc-workbench{display:flex;flex-direction:column;overflow:auto}'), 'small-screen main workbench stacks persistent columns with vertical scrolling');
check(responsiveCSS.includes('.dsc-workbench>.dsc-navigator{flex:1 0 430px;min-height:430px') && responsiveCSS.includes('.dsc-workbench>.dsc-editor{flex:1 0 220px;min-height:220px'), 'mobile navigation and editor retain independently scrollable readable minimum regions');
check(!source.includes('dsc-mobile-selected') && !responsiveCSS.includes('.dsc-navigator{display:none}'), 'no selected-mobile path can hide the persistent main navigator');
check(responsiveCSS.includes('.dsc-workbench>.dsc-resize-width{display:none}') && styles.join('\n').includes('var(--dsc-history-height,40%)'), 'mobile hides only the width handle while graph ratios remain adjustable');
check(textsOf(featureTree, 'dsc-name').length === 3 && walk(featureTree).some((node) => node.type === 'textarea') && !!labelled(featureTree, t('files.filter')), 'historic diff review retains main rows, commit controls and filter');

// Optional DOM fixtures for real-browser geometry checks. Component wrappers
// are retained; a browser harness can flatten them and use the actual CSS.
if (process.env.DSC_RENDER_SNAPSHOT) {
  const snapshot = (node) => {
    if (Array.isArray(node)) return node.map(snapshot);
    if (node === null || typeof node !== 'object') return node;
    const { children, ...props } = node.props ?? {};
    return { type: node.type, props, children: (node.children ?? []).map(snapshot) };
  };
  await writeFile(process.env.DSC_RENDER_SNAPSHOT, JSON.stringify({ css: styles.join('\n'), page: snapshot(workbenchSnapshot), tab: snapshot(compactSnapshot) }));
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
