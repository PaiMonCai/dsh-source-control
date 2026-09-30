/**
 * Verification for the client bundle.
 *
 * Executes `lib/client.js` the way the shell does — through a stub
 * `window.__ModuleLoader__` with a stub `react` — then calls the returned
 * factory and `apply` against a recording context. This catches real defects in
 * the registration path (wrong seat keys, a missing effect, a top-level throw)
 * that a static grep cannot see, and it renders each surface once to prove the
 * components do not throw during a first paint.
 *
 * Run with:
 *
 *     node verify/client-bundle.mjs
 */
import { readFile } from 'node:fs/promises';

let failures = 0;
let checks = 0;

/**
 * Assert one condition.
 * @param {boolean} condition - the label's condition.
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

/** A minimal React stand-in: enough for element construction and the hooks used. */
const React = {
  /** @param {string} type - tag or component. @param {object} props - props. @param {...unknown} children - children. @returns {object} an element. */
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } };
  },
  /** @returns {object} a ref. */
  useRef: () => ({ current: null }),
  /** @param {unknown} value - initial value. @returns {[unknown, Function]} state pair. */
  useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
  /** @param {Function} fn - the callback. @param {unknown[]} deps - deps. @returns {Function} the memoized callback. */
  useCallback: (fn) => fn,
  /** @param {Function} fn - the factory. @param {unknown[]} deps - deps. @returns {unknown} the memoized value. */
  useMemo: (fn) => fn(),
  /** @param {Function} fn - the effect. @param {unknown[]} deps - deps. */
  useEffect: () => {},
  /** @param {Function} fn - the layout effect. @param {unknown[]} deps - deps. */
  useLayoutEffect: () => {},
  /** Component base class stand-in. */
  Component: class {
    /** @param {object} props - props. */
    constructor(props) {
      this.props = props;
      this.state = {};
    }
  },
};

/** The registration ledger the fake client context records into. */
const ledger = { tabTypes: [], slots: [], locales: [], effects: [] };

/**
 * Build one recording client context.
 * @returns {object} the context.
 */
function createClientContext() {
  return {
    effect(callback, label) {
      ledger.effects.push(label);
      const cleanup = callback();
      return () => {
        if (typeof cleanup === 'function') cleanup();
      };
    },
    locale: {
      /**
       * @param {string} ns - namespace.
       * @param {object} dictionaries - the copy.
       * @returns {Function} disposer.
       */
      register(ns, dictionaries) {
        ledger.locales.push({ ns, languages: Object.keys(dictionaries) });
        return () => {};
      },
      /**
       * @param {string} ns - namespace.
       * @returns {Function} translate.
       */
      bind(ns) {
        return (key) => `${ns}.${key}`;
      },
    },
    sidebarRightTabs: {
      /**
       * @param {object} definition - the tab type.
       * @returns {Function} disposer.
       */
      register(definition) {
        ledger.tabTypes.push(definition);
        return () => {};
      },
    },
    sidebarRight: { openTab() {}, openResource() {}, close() {} },
    layout: { selectPanel() {} },
    slots: {
      /**
       * @param {string} name - the seat.
       * @param {Function} callback - the registration body.
       * @returns {Function} disposer.
       */
      inject(name, callback) {
        callback();
        return () => {};
      },
      /**
       * @param {object} options - registration options.
       * @param {Function} component - the component.
       * @returns {Function} disposer.
       */
      register(options, component) {
        ledger.slots.push({ options, component });
        return () => {};
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Load the bundle exactly as the shell does.
const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
let registration = null;
const documentStub = {
  /** @returns {object|null} nothing is styled before the first registration. */
  querySelector: () => null,
  /** @returns {object} a style element stand-in. */
  createElement: () => ({ dataset: {}, textContent: '' }),
  head: {
    /** @param {object} node - the style element. */
    appendChild(node) {},
  },
};
globalThis.window = {
  __ModuleLoader__: {
    /** @param {object} value - the bundle registration. */
    load(value) {
      registration = value;
    },
  },
  location: { origin: 'http://localhost:3080' },
};
globalThis.document = documentStub;
globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, value: {} }) });

// eslint-disable-next-line no-new-func
new Function(source)();

check(registration !== null, 'the bundle registers itself on __ModuleLoader__');
check(registration?.id === 'dsh-source-control', 'the registration id equals the package name', registration?.id);
check(typeof registration?.factory === 'function', 'the registration carries a factory');

const required = [];
const exportsObject = registration.factory((specifier) => {
  required.push(specifier);
  if (specifier === 'react') return React;
  throw new Error(`unexpected require(${specifier})`);
});

check(required.length === 1 && required[0] === 'react', 'the factory requires only react', required);
check(typeof exportsObject.apply === 'function', 'the module exports apply');
check(Array.isArray(exportsObject.inject), 'the module exports an inject list');
for (const service of ['slots', 'locale', 'sidebarRightTabs']) {
  check(exportsObject.inject.includes(service), `the module injects ${service}`);
}

// ---------------------------------------------------------------------------
console.log('\n## apply');
const ctx = createClientContext();
exportsObject.apply(ctx);

check(ledger.tabTypes.length === 1, 'one tab type is registered', ledger.tabTypes.length);
const type = ledger.tabTypes[0] ?? {};
check(type.id === 'dsh-source-control', 'the tab type id is the package name', type.id);
check(type.kind === 'source-control', 'the tab type kind is namespaced', type.kind);
check(type.priority === 'extension', 'the tab type declares the extension band', type.priority);
check(typeof type.title === 'function' && typeof type.title() === 'string', 'the tab type has a live title');
check(Array.isArray(type.guide) && type.guide.length === 1, 'the tab type contributes one guide entry');
check(typeof type.guide?.[0]?.id === 'string', 'the guide entry has an id');
check(typeof type.guide?.[0]?.description === 'function', 'the guide entry has a description');
check(typeof type.guide?.[0]?.icon !== 'undefined', 'the guide entry has an icon');

const seats = ledger.slots.map((entry) => entry.options);
const tabSeat = seats.find((options) => options.name === 'sidebar.right.pane.tab');
check(tabSeat !== undefined, 'the tab body registers into sidebar.right.pane.tab');
check(tabSeat?.key === type.id, 'the tab body key equals the tab type id', tabSeat?.key);
const mainSeat = seats.find((options) => options.name === 'main');
check(mainSeat?.key === 'source-control', 'the main page registers under the source-control key', mainSeat?.key);
const panelSeat = seats.find((options) => options.name === 'sidebar.panellist');
check(panelSeat?.id === 'source-control', 'the sidebar icon id matches the main key', panelSeat?.id);
check(panelSeat?.id === mainSeat?.key, 'the sidebar icon id and the main key are identical');
check(seats.length === 3, 'exactly three seats are registered', seats.length);
check(ledger.locales.length === 1 && ledger.locales[0].languages.length === 2, 'both languages are registered', ledger.locales[0]);
check(ledger.effects.length === 5, 'every registration is owned by one effect', ledger.effects);
check(
  ledger.effects.every((label) => typeof label === 'string' && label.startsWith('source-control:')),
  'every effect carries a source-control label',
  ledger.effects,
);

// ---------------------------------------------------------------------------
console.log('\n## first render');
const tabComponent = ledger.slots.find((entry) => entry.options.name === 'sidebar.right.pane.tab').component;
const mainComponent = ledger.slots.find((entry) => entry.options.name === 'main').component;
const t = (key) => key;

const tabTree = tabComponent({
  sessionId: 'session-1',
  t,
  useTabInfo: () => ({ sidebar: { expanded: true, fullscreen: false }, panel: { id: 'p1' }, tab: { id: 't1', signal: new AbortController().signal, actions: {}, navigation: { revision: 0, params: undefined, address: 'a' }, visible: true } }),
});
check(tabTree !== undefined && tabTree !== null, 'the tab body renders a first tree');
const mainTree = mainComponent({ t, usePanelInfo: () => null });
check(mainTree !== undefined && mainTree !== null, 'the main page renders a first tree');
const noSessionTree = tabComponent({ sessionId: undefined, t, useTabInfo: () => ({ tab: { id: 'x', signal: new AbortController().signal, actions: {} } }) });
check(noSessionTree !== undefined, 'the tab body renders without a session id');

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
