/**
 * Browser half of the Source Control bundle.
 *
 * Contributes two surfaces over one shared panel component:
 * - a right-sidebar tab type (`source-control`), whose repository follows the
 *   Session the tab lives in, and
 * - a main page (key `source-control`) with its own repository picker and the
 *   commit history, reached from a `sidebar.panellist` icon row.
 *
 * Everything the panel knows about a repository arrives over the authenticated
 * `/api/source-control/*` routes the Host half registers; this module never runs
 * git and never decides path authority.
 *
 * Only `react` is required from the shell's module table. No Harness Client
 * package is imported, and no colour outside `--dsw-alias-*` tokens is written.
 */
window.__ModuleLoader__.load({
  id: 'dsh-source-control',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** This package's locale namespace. */
    const NS = 'sourceControl';
    /** The tab type's identity in the sidebar tab system, and its body-seat key. */
    const ID = 'dsh-source-control';
    /** The kind a page open names. Namespaced so it cannot collide with a foreign type. */
    const KIND = 'source-control';
    /** The `main` slot key and the `sidebar.panellist` id; they must be equal. */
    const PANEL_ID = 'source-control';
    /** Where the Host half mounted its routes, below the authenticated `/api` channel. */
    const ROUTE = '/api/source-control';

    // -----------------------------------------------------------------------
    // copy
    // -----------------------------------------------------------------------

    const en = {
      panel: 'Source Control',
      'tab.title': 'Source Control',
      'guide.title': 'Source Control',
      'guide.description': 'Stage, discard, and commit the repository of this Session',
      'guide.icon': 'Source Control',
      'state.loading': 'Loading…',
      'state.clean': 'No changes in the working tree.',
      'state.noRepo': 'This working directory is not inside a Git repository.',
      'state.noWorkspace': 'This Session has no working directory.',
      'state.gitUnavailable': 'Git is not available on the host.',
      'state.error': 'Could not read the repository',
      'action.refresh': 'Refresh',
      'action.stage': 'Stage',
      'action.unstage': 'Unstage',
      'action.discard': 'Discard changes',
      'action.stageAll': 'Stage all',
      'action.unstageAll': 'Unstage all',
      'action.commit': 'Commit',
      'action.committing': 'Committing…',
      'action.back': 'Back',
      'action.cancel': 'Cancel',
      'action.confirmDiscard': 'Discard',
      'action.loadMore': 'Load more',
      'action.stageHunk': 'Stage hunk',
      'action.unstageHunk': 'Unstage hunk',
      'action.discardHunk': 'Discard hunk',
      'confirm.discardHunkTitle': 'Discard this hunk?',
      'confirm.discardHunkBody': 'This permanently reverts hunk {n} of {path} in your working tree. Other hunks in the file are left alone.',
      'hunk.count': 'hunk {n} of {total}',
      'confirm.discardTitle': 'Discard changes?',
      'confirm.discardBody': 'This permanently reverts your uncommitted changes to {path}.',
      'confirm.discardUntracked': 'This permanently deletes the untracked file {path}.',
      'section.staged': 'Staged Changes',
      'section.changes': 'Changes',
      'section.untracked': 'Untracked',
      'section.conflicts': 'Merge Conflicts',
      'commit.placeholder': 'Commit message',
      'commit.summary': 'Commit {short}',
      'diff.empty': 'No changes to show.',
      'diff.binary': 'Binary file — no line diff.',
      'history.title': 'History',
      'history.empty': 'No commits yet.',
      'repo.label': 'Repository',
      'repo.none': 'No repository found',
      'ahead': '{n} ahead',
      'behind': '{n} behind',
      'renamed': 'renamed from {path}',
    };

    const zh = {
      panel: '源代码管理',
      'tab.title': '源代码管理',
      'guide.title': '源代码管理',
      'guide.description': '暂存、放弃并提交当前会话所在仓库的更改',
      'guide.icon': '源代码管理',
      'state.loading': '加载中…',
      'state.clean': '工作区没有改动。',
      'state.noRepo': '当前工作目录不在任何 Git 仓库中。',
      'state.noWorkspace': '当前会话没有工作目录。',
      'state.gitUnavailable': '主机上没有可用的 git。',
      'state.error': '无法读取仓库',
      'action.refresh': '刷新',
      'action.stage': '暂存',
      'action.unstage': '取消暂存',
      'action.discard': '放弃更改',
      'action.stageAll': '全部暂存',
      'action.unstageAll': '全部取消暂存',
      'action.commit': '提交',
      'action.committing': '提交中…',
      'action.back': '返回',
      'action.cancel': '取消',
      'action.confirmDiscard': '放弃',
      'action.loadMore': '加载更多',
      'action.stageHunk': '暂存此块',
      'action.unstageHunk': '取消暂存此块',
      'action.discardHunk': '放弃此块',
      'confirm.discardHunkTitle': '放弃这个改动块？',
      'confirm.discardHunkBody': '这会永久把 {path} 的第 {n} 块改动回退到已提交内容，同一文件的其他改动块不受影响。',
      'hunk.count': '第 {n} / {total} 块',
      'confirm.discardTitle': '放弃这些更改？',
      'confirm.discardBody': '这会永久丢弃 {path} 尚未提交的改动。',
      'confirm.discardUntracked': '这会永久删除未跟踪文件 {path}。',
      'section.staged': '已暂存的更改',
      'section.changes': '更改',
      'section.untracked': '未跟踪',
      'section.conflicts': '合并冲突',
      'commit.placeholder': '提交信息',
      'commit.summary': '提交 {short}',
      'diff.empty': '没有可显示的差异。',
      'diff.binary': '二进制文件，无法按行比较。',
      'history.title': '提交历史',
      'history.empty': '还没有任何提交。',
      'repo.label': '仓库',
      'repo.none': '未找到仓库',
      'ahead': '领先 {n}',
      'behind': '落后 {n}',
      'renamed': '由 {path} 重命名',
    };

    // -----------------------------------------------------------------------
    // styles
    // -----------------------------------------------------------------------

    const CSS = `
.dsc-root{box-sizing:border-box;color:var(--dsw-alias-label-primary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.5;display:flex;flex-direction:column;flex:auto;min-height:0;height:100%}
.dsc-header{box-sizing:border-box;border-bottom:.5px solid var(--dsw-alias-border-l1);display:flex;align-items:center;gap:6px;height:38px;flex:none;padding:0 6px 0 12px}
.dsc-branch{white-space:nowrap;text-overflow:ellipsis;overflow:hidden;min-width:0;font-weight:600}
.dsc-track{color:var(--dsw-alias-label-secondary);white-space:nowrap;flex:none}
.dsc-spacer{flex:auto}
.dsc-tool{width:28px;height:28px;color:var(--dsw-alias-label-secondary);border-radius:var(--dsw-radius-sm,6px);cursor:pointer;background:0 0;border:none;flex:none;display:inline-flex;justify-content:center;align-items:center;padding:6px;line-height:1}
.dsc-tool svg{width:15px;height:15px}
.dsc-tool:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dsc-tool:focus-visible,.dsc-btn:focus-visible,.dsc-row:focus-visible,.dsc-input:focus-visible,.dsc-select:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px}
.dsc-body{scrollbar-gutter:stable;flex:auto;min-height:0;overflow:auto;padding:4px 0 12px}
.dsc-status{color:var(--dsw-alias-label-secondary);padding:12px 12px;margin:0}
.dsc-error{color:var(--dsw-alias-state-error-primary);padding:2px 12px 8px;margin:0}
.dsc-group{margin-top:6px}
.dsc-groupHead{display:flex;align-items:center;gap:6px;padding:3px 8px 3px 12px;color:var(--dsw-alias-label-secondary);font-size:var(--dsw-font-xxs-12,12px);text-transform:uppercase;letter-spacing:.04em}
.dsc-groupTitle{text-transform:none;letter-spacing:0;font-size:inherit;font-weight:600;color:var(--dsw-alias-label-secondary)}
.dsc-groupCount{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}
.dsc-groupActions{margin-left:auto;display:flex;gap:2px}
.dsc-item{display:flex;align-items:center;padding-right:4px}
.dsc-row{min-width:0;color:inherit;font:inherit;text-align:left;border-radius:var(--dsw-radius-sm,6px);cursor:pointer;background:0 0;border:0;display:flex;align-items:center;gap:6px;padding:4px 8px 4px 12px;flex:auto}
.dsc-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsc-badge{width:14px;flex:none;text-align:center;font-weight:700;font-size:11px;font-family:var(--dsw-font-mono,monospace)}
.dsc-badge-m{color:var(--dsw-alias-state-warn-primary)}
.dsc-badge-a{color:var(--dsw-alias-state-success-primary)}
.dsc-badge-d{color:var(--dsw-alias-state-error-primary)}
.dsc-badge-r{color:var(--dsw-alias-brand-primary)}
.dsc-badge-u{color:var(--dsw-alias-state-idle-primary)}
.dsc-name{white-space:nowrap;text-overflow:ellipsis;overflow:hidden;min-width:0;flex:auto;direction:rtl;text-align:left}
.dsc-dir{color:var(--dsw-alias-label-secondary)}
.dsc-rowTools{display:flex;gap:2px;flex:none;opacity:0}
.dsc-row:hover .dsc-rowTools,.dsc-row:focus-within .dsc-rowTools{opacity:1}
.dsc-mini{width:22px;height:22px;color:var(--dsw-alias-label-secondary);border-radius:var(--dsw-radius-xs,4px);cursor:pointer;background:0 0;border:none;display:inline-flex;justify-content:center;align-items:center;padding:3px;line-height:1}
.dsc-mini svg{width:13px;height:13px}
.dsc-mini:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
.dsc-mini-danger:hover{color:var(--dsw-alias-state-error-primary)}
.dsc-compose{border-top:.5px solid var(--dsw-alias-border-l1);flex:none;padding:8px 12px 10px;display:flex;flex-direction:column;gap:6px}
.dsc-input{box-sizing:border-box;width:100%;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,6px);font:inherit;padding:6px 8px;resize:vertical;min-height:52px}
.dsc-input::placeholder{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}
.dsc-btn{box-sizing:border-box;background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));color:var(--dsw-alias-label-primary-foreground,#fff);border:1px solid transparent;border-radius:var(--dsw-radius-sm,6px);cursor:pointer;font:inherit;font-weight:600;padding:5px 10px}
.dsc-btn:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-brand-primary))}
.dsc-btn:disabled{opacity:.5;cursor:default}
.dsc-btn-quiet{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l1);font-weight:400}
.dsc-btn-quiet:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsc-btn-danger{background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary-foreground,#fff)}
.dsc-btn-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger,var(--dsw-alias-state-error-primary))}
.dsc-confirm{border-top:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);flex:none;padding:8px 12px 10px}
.dsc-confirmTitle{margin:0 0 4px;font-weight:600}
.dsc-confirmBody{margin:0 0 8px;color:var(--dsw-alias-label-secondary);word-break:break-word}
.dsc-confirmActions{display:flex;gap:6px;justify-content:flex-end}
.dsc-diff{display:flex;flex-direction:column;min-height:0;flex:auto}
.dsc-diffHead{display:flex;align-items:center;gap:6px;padding:6px 12px;border-bottom:.5px solid var(--dsw-alias-border-l1);flex:none}
.dsc-diffPath{font-family:var(--dsw-font-mono,monospace);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:auto}
.dsc-stat{color:var(--dsw-alias-label-secondary);flex:none}
.dsc-statAdd{color:var(--dsw-alias-state-success-primary)}
.dsc-statDel{color:var(--dsw-alias-state-error-primary)}
.dsc-hunks{overflow:auto;font-family:var(--dsw-font-mono,monospace);font-size:var(--dsw-font-xxs-12,12px);flex:auto;min-height:0}
.dsc-hunkHead{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);position:sticky;top:0;display:flex;align-items:center;gap:8px;padding:2px 8px 2px 12px}
.dsc-hunkLabel{flex:auto;min-width:0;white-space:pre;overflow-x:auto}
.dsc-hunkTools{display:flex;gap:4px;flex:none}
.dsc-btn-mini{padding:2px 6px;font-size:var(--dsw-font-xxs-12,12px);font-weight:400}
.dsc-btn-danger.dsc-btn-mini{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-border-l1)}
.dsc-btn-danger.dsc-btn-mini:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger,var(--dsw-alias-interactive-bg-hover))}
.dsc-hunk{border-bottom:.5px solid var(--dsw-alias-border-l1)}
.dsc-line{display:flex;white-space:pre;min-width:max-content}
.dsc-line-add{background:var(--dsw-alias-bg-layer-2);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent);box-shadow:inset 2px 0 0 var(--dsw-alias-state-success-primary)}
.dsc-line-del{background:var(--dsw-alias-bg-layer-2);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 14%,transparent);box-shadow:inset 2px 0 0 var(--dsw-alias-state-error-primary)}
.dsc-gutter{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));min-width:34px;text-align:right;padding:0 8px 0 6px;flex:none;user-select:none}
.dsc-code{padding-right:12px}
.dsc-page{padding-top:calc(28px + var(--dsh-frame-top-clearance,0px))}
.dsc-pageHead{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dsc-pageTitle{margin:0;font-size:var(--dsw-font-l-20,20px);font-weight:600}
.dsc-select{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,6px);font:inherit;padding:4px 6px;max-width:min(420px,60vw)}
.dsc-pageBody{display:grid;grid-template-columns:minmax(280px,1fr) minmax(320px,1.4fr);gap:16px;align-items:start;margin-top:12px}
.dsc-col{min-width:0;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;min-height:320px;max-height:calc(100vh - 220px);overflow:hidden}
.dsc-colHead{display:flex;align-items:center;gap:6px;padding:8px 12px;border-bottom:.5px solid var(--dsw-alias-border-l1);font-weight:600;flex:none}
.dsc-history{overflow:auto;flex:auto;min-height:0;margin:0;padding:0;list-style:none}
.dsc-commit{padding:8px 12px;border-bottom:.5px solid var(--dsw-alias-border-l1)}
.dsc-commit:last-child{border-bottom:none}
.dsc-commitSubject{margin:0;font-weight:600;word-break:break-word}
.dsc-commitMeta{margin:2px 0 0;color:var(--dsw-alias-label-secondary);font-size:var(--dsw-font-xxs-12,12px)}
.dsc-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media (max-width:900px){.dsc-pageBody{grid-template-columns:minmax(0,1fr)}}
`;

    /** Inject this bundle's stylesheet once; the shell removes it on unload. */
    function installStyles() {
      if (typeof document === 'undefined') return;
      const tagId = `${ID}/client.css`;
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null) return;
      const tag = document.createElement('style');
      tag.dataset.plugin = ID;
      tag.dataset.pluginCss = tagId;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    // -----------------------------------------------------------------------
    // glyphs (inline, currentColor only so they follow the theme)
    // -----------------------------------------------------------------------

    /**
     * Build one stroked SVG glyph.
     * @param {object[]} children - path elements.
     * @param {object} props - `{size}` plus the caller's props.
     * @returns {object} the element.
     */
    const glyph = (children, props) =>
      h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: props?.size ?? 16,
          height: props?.size ?? 16,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        children,
      );

    /** The bundle's mark: a branch with two nodes. */
    function IconSourceControl(props) {
      return glyph(
        [
          h('circle', { key: 'a', cx: 4, cy: 3.5, r: 1.6 }),
          h('circle', { key: 'b', cx: 4, cy: 12.5, r: 1.6 }),
          h('circle', { key: 'c', cx: 12, cy: 6, r: 1.6 }),
          h('path', { key: 'd', d: 'M4 5.1v5.8' }),
          h('path', { key: 'e', d: 'M4 8.2c0-1.2 1-2.2 2.2-2.2H10.4' }),
        ],
        props,
      );
    }

    /** Refresh: a circular arrow. */
    function IconRefresh(props) {
      return glyph(
        [
          h('path', { key: 'a', d: 'M13.2 8a5.2 5.2 0 1 1-1.6-3.7' }),
          h('path', { key: 'b', d: 'M13.4 1.9v3.2h-3.2' }),
        ],
        props,
      );
    }

    /** Back: a left chevron. */
    function IconBack(props) {
      return glyph([h('path', { key: 'a', d: 'M10 3.2 5.2 8l4.8 4.8' })], props);
    }

    /** Stage: a downward arrow into a tray. */
    function IconStage(props) {
      return glyph(
        [
          h('path', { key: 'a', d: 'M8 2.2v7' }),
          h('path', { key: 'b', d: 'M5.2 6.6 8 9.4l2.8-2.8' }),
          h('path', { key: 'c', d: 'M2.8 12.4h10.4' }),
        ],
        props,
      );
    }

    /** Unstage: an upward arrow out of a tray. */
    function IconUnstage(props) {
      return glyph(
        [
          h('path', { key: 'a', d: 'M8 9.4v-7' }),
          h('path', { key: 'b', d: 'M5.2 5 8 2.2 10.8 5' }),
          h('path', { key: 'c', d: 'M2.8 12.4h10.4' }),
        ],
        props,
      );
    }

    /** Discard: a counter-clockwise arrow. */
    function IconDiscard(props) {
      return glyph(
        [
          h('path', { key: 'a', d: 'M2.8 8a5.2 5.2 0 1 0 1.6-3.7' }),
          h('path', { key: 'b', d: 'M2.6 1.9v3.2h3.2' }),
        ],
        props,
      );
    }

    /** Commit: a node on a line. */
    function IconCommit(props) {
      return glyph(
        [
          h('path', { key: 'a', d: 'M1.8 8h3.4' }),
          h('path', { key: 'b', d: 'M10.8 8h3.4' }),
          h('circle', { key: 'c', cx: 8, cy: 8, r: 2.4 }),
        ],
        props,
      );
    }

    // -----------------------------------------------------------------------
    // transport
    // -----------------------------------------------------------------------

    /**
     * Call one Source Control route.
     * @param {string} operation - route name after `/api/source-control/`.
     * @param {object} [options] - `{query, body, signal}`.
     * @returns {Promise<any>} the route's `value`.
     * @throws {Error} with `code` and `details` on a business failure.
     */
    async function call(operation, options = {}) {
      const url = new URL(`${ROUTE}/${operation}`, window.location.origin);
      for (const [key, value] of Object.entries(options.query ?? {})) {
        if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
      }
      const isWrite = options.body !== undefined;
      const response = await fetch(`${url.pathname}${url.search}`, {
        method: isWrite ? 'POST' : 'GET',
        headers: isWrite ? { 'content-type': 'application/json' } : undefined,
        body: isWrite ? JSON.stringify(options.body) : undefined,
        signal: options.signal,
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!response.ok) {
        const error = new Error(`Source Control request failed with HTTP ${response.status}`);
        error.code = 'transport';
        throw error;
      }
      const payload = await response.json();
      if (payload?.ok !== true) {
        const error = new Error(payload?.error?.message ?? 'Source Control request failed');
        error.code = payload?.error?.code ?? 'unknown';
        error.details = payload?.error?.details ?? {};
        throw error;
      }
      return payload.value;
    }

    // -----------------------------------------------------------------------
    // formatting
    // -----------------------------------------------------------------------

    /**
     * Look up the status letter for one row in one group.
     *
     * The side matters: a file staged as new and then modified again carries both
     * `A` (index) and `M` (worktree), and the row appears in both groups. Reading
     * the index status in the Changes group would show `A` where `M` is truthful.
     *
     * @param {object} row - a status entry.
     * @param {'index'|'worktree'} side - which status the containing group reports.
     * @returns {string} one of `m a d r u`.
     */
    function rowKind(row, side) {
      if (row.unmerged) return 'u';
      if (row.untracked) return 'a';
      const status = side === 'index' ? row.indexStatus : row.worktreeStatus;
      if (side === 'index' && (status === 'R' || row.renamed)) return 'r';
      if (status === 'D') return 'd';
      if (status === 'A') return 'a';
      if (status === 'R') return 'r';
      if (status === '?') return 'a';
      return 'm';
    }

    /**
     * Split a repository-relative path into its directory and base name.
     * @param {string} path - repository-relative path.
     * @returns {{dir: string, base: string}} the parts.
     */
    function splitPath(path) {
      const index = path.lastIndexOf('/');
      return index === -1 ? { dir: '', base: path } : { dir: path.slice(0, index + 1), base: path.slice(index + 1) };
    }

    // -----------------------------------------------------------------------
    // hooks
    // -----------------------------------------------------------------------

    /**
     * Run a route when its selector changes, exposing `{state, reload, setState}`.
     *
     * The latest request wins: a superseded response is dropped, so a rapid
     * sequence of refreshes cannot install stale data.
     *
     * @param {(signal: AbortSignal) => Promise<any>} load - the loader.
     * @param {unknown[]} deps - dependency list.
     * @returns {{status: string, value: any, error: Error|null, reload: () => void}} the snapshot.
     */
    function useLoad(load, deps) {
      const [snapshot, setSnapshot] = React.useState({ status: 'loading', value: undefined, error: null });
      const [nonce, setNonce] = React.useState(0);
      const loadRef = React.useRef(load);
      loadRef.current = load;
      React.useEffect(() => {
        const controller = new AbortController();
        let current = true;
        loadRef.current(controller.signal)
          .then((value) => {
            if (current) setSnapshot({ status: 'ready', value, error: null });
          })
          .catch((error) => {
            if (!current || controller.signal.aborted) return;
            setSnapshot({ status: 'error', value: undefined, error });
          });
        return () => {
          current = false;
          controller.abort();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [...deps, nonce]);
      return { ...snapshot, reload: React.useCallback(() => setNonce((value) => value + 1), []) };
    }

    // -----------------------------------------------------------------------
    // shared panel
    // -----------------------------------------------------------------------

    /** One change row: a clickable file area plus its trailing controls. */
    function ChangeRow({ row, badge, onOpen, onPrimary, primaryLabel, primaryIcon, onDiscard, t }) {
      const { dir, base } = splitPath(row.path);
      const renamed = row.origPath === null ? null : t('renamed').replace('{path}', row.origPath);
      return h(
        'div',
        { className: 'dsc-item' },
        h(
          'button',
          {
            type: 'button',
            className: 'dsc-row',
            onClick: () => onOpen(row),
            title: renamed === null ? row.path : `${row.path} — ${renamed}`,
          },
          h('span', { className: `dsc-badge dsc-badge-${badge}`, 'aria-hidden': 'true' }, badge.toUpperCase()),
          h('span', { className: 'dsc-name', dir: 'ltr' }, dir === '' ? null : h('span', { className: 'dsc-dir' }, dir), base),
          h('span', { className: 'dsc-hidden' }, renamed ?? ''),
        ),
        h(
          'span',
          { className: 'dsc-rowTools' },
          h(
            'button',
            { type: 'button', className: 'dsc-mini', title: primaryLabel, 'aria-label': primaryLabel, onClick: () => onPrimary(row) },
            primaryIcon,
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsc-mini dsc-mini-danger',
              title: t('action.discard'),
              'aria-label': t('action.discard'),
              onClick: () => onDiscard(row),
            },
            h(IconDiscard, {}),
          ),
        ),
      );
    }

    /** One collapsible group with its bulk actions. */
    function Group({ title, rows, badge, t, children, bulk }) {
      if (rows.length === 0) return null;
      return h(
        'section',
        { className: 'dsc-group' },
        h(
          'header',
          { className: 'dsc-groupHead' },
          h('span', { className: 'dsc-groupTitle' }, title),
          h('span', { className: 'dsc-groupCount' }, String(rows.length)),
          bulk === undefined ? null : h('span', { className: 'dsc-groupActions' }, bulk),
        ),
        children,
      );
    }

    /** The parsed diff, rendered as hunks with old/new line numbers. */
    function DiffView({ diff, path, t, onHunk, busy, side }) {
      if (diff === undefined || diff === null) return h('p', { className: 'dsc-status' }, t('state.loading'));
      if (diff.binary) return h('p', { className: 'dsc-status' }, t('diff.binary'));
      if (diff.hunks.length === 0) return h('p', { className: 'dsc-status' }, t('diff.empty'));
      return h(
        'div',
        { className: 'dsc-hunks' },
        diff.hunks.map((hunk, hunkIndex) => {
          let oldNo = hunk.oldStart;
          let newNo = hunk.newStart;
          const lines = [];
          hunk.lines.forEach((line, lineIndex) => {
            let oldCell = '';
            let newCell = '';
            // A `meta` line is git's marker ("\ No newline at end of file"), not
            // content: it holds no line number and must not advance either
            // counter, or every line after it would be mislabelled.
            if (line.kind === 'add') newCell = String(newNo++);
            else if (line.kind === 'del') oldCell = String(oldNo++);
            else if (line.kind !== 'meta') {
              oldCell = String(oldNo++);
              newCell = String(newNo++);
            }
            lines.push(
              h(
                'div',
                { key: lineIndex, className: `dsc-line dsc-line-${line.kind}` },
                h('span', { className: 'dsc-gutter' }, oldCell),
                h('span', { className: 'dsc-gutter' }, newCell),
                h('span', { className: 'dsc-code' }, line.text === '' ? ' ' : line.text),
              ),
            );
          });
          // Which hunk actions make sense depends on the side being viewed: an
          // unstaged hunk can be staged or discarded, a staged one can only be
          // unstaged. `hunkIndex` is a NUMBER — the patch is rebuilt on the Host
          // from live git output, so this side never sends patch text.
          const tools = onHunk === undefined
            ? []
            : side === 'index'
              ? [['unstage', t('action.unstageHunk'), 'dsc-btn-quiet']]
              : [['stage', t('action.stageHunk'), 'dsc-btn-quiet'], ['discard', t('action.discardHunk'), 'dsc-btn-danger']];
          return h(
            'div',
            { key: `${path}-${hunkIndex}`, className: 'dsc-hunk' },
            h(
              'div',
              { className: 'dsc-hunkHead' },
              h('span', { className: 'dsc-hunkLabel' }, hunk.header),
              tools.length === 0
                ? null
                : h(
                    'span',
                    { className: 'dsc-hunkTools' },
                    tools.map(([action, label, variant]) =>
                      h(
                        'button',
                        {
                          key: action,
                          type: 'button',
                          className: `dsc-btn dsc-btn-mini ${variant}`,
                          disabled: busy === true,
                          'aria-label': label,
                          onClick: () => onHunk(hunkIndex, action),
                        },
                        label,
                      ),
                    ),
                  ),
            ),
            lines,
          );
        }),
      );
    }

    /**
     * The Source Control panel, shared by the sidebar tab and the main page.
     *
     * @param {object} props - `{selector, t, showHistory, header}` plus `useSessions`
     *   when `header` is rendered.
     * @returns {object} the element.
     */
    function SourceControlPanel({ selector, t, showHistory, historySlot, surface, onChanged }) {
      const status = useLoad((signal) => call('status', { query: selector, signal }), [
        selector.sessionId,
        selector.repo,
      ]);
      const [selected, setSelected] = React.useState(null);
      const [message, setMessage] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [notice, setNotice] = React.useState(null);
      const [pendingDiscard, setPendingDiscard] = React.useState(null);
      const [pendingHunk, setPendingHunk] = React.useState(null);
      const [lastCommit, setLastCommit] = React.useState(null);
      // This panel's message box needs its own id: the sidebar tab and the main
      // page can be mounted at once, and two elements sharing an id would bind
      // the label to whichever the browser found first.
      const messageId = `dsc-message-${surface ?? 'panel'}`;

      const diffLoad = useLoad(
        (signal) =>
          selected === null
            ? Promise.resolve(null)
            : call('diff', {
                query: {
                  ...selector,
                  path: selected.row.path,
                  staged: selected.staged,
                  untracked: selected.row.untracked,
                },
                signal,
              }),
        [selected === null ? '' : selected.row.path, selected === null ? '' : String(selected.staged), status.value],
      );

      /** Run one write operation, refreshing the status afterwards. */
      const run = React.useCallback(
        async (operation, body, options = {}) => {
          setBusy(true);
          setNotice(null);
          try {
            const result = await call(operation, { query: selector, body });
            if (options.afterRefresh !== false) status.reload();
            // A write changes the repository for every surface showing it, not
            // just this panel: tell the owner so a sibling history column
            // repaints instead of going stale after a commit.
            if (typeof onChanged === 'function') onChanged(operation);
            return result;
          } catch (error) {
            setNotice({ kind: 'error', text: error.message });
            return null;
          } finally {
            setBusy(false);
            setPendingDiscard(null);
            setPendingHunk(null);
          }
        },
        [selector.sessionId, selector.repo, status.reload],
      );

      /** Commit the staged index. */
      const commit = async () => {
        if (message.trim() === '') {
          setNotice({ kind: 'error', text: t('commit.placeholder') });
          return;
        }
        const result = await run('commit', { ...selector, message });
        if (result !== null) {
          setMessage('');
          setLastCommit(result);
          status.reload();
        }
      };

      const openDiff = (row, staged) => {
        setSelected({ row, staged });
        setNotice(null);
      };

      if (status.status === 'error') {
        const code = status.error?.code;
        const text =
          code === 'session/no-workspace'
            ? t('state.noWorkspace')
            : code === 'repo/not-a-repository'
              ? t('state.noRepo')
              : code === 'git/unavailable'
                ? t('state.gitUnavailable')
                : `${t('state.error')}: ${status.error.message}`;
        return h(
          'div',
          { className: 'dsc-root' },
          h('p', { className: 'dsc-status' }, text),
          h(
            'div',
            { className: 'dsc-compose' },
            h(
              'button',
              { type: 'button', className: 'dsc-btn dsc-btn-quiet', onClick: status.reload },
              t('action.refresh'),
            ),
          ),
        );
      }

      if (status.status === 'loading' || status.value === undefined) {
        return h('div', { className: 'dsc-root' }, h('p', { className: 'dsc-status' }, t('state.loading')));
      }

      const { repository, status: tree } = status.value;
      const stagedRows = tree.staged;
      const changeRows = tree.changes;
      const untrackedRows = tree.untracked;
      const conflictRows = tree.conflicted;
      const clean = stagedRows.length + changeRows.length + untrackedRows.length + conflictRows.length === 0;

      // A loaded diff is an object with hunks. Anything else — including the
      // `null` the loader resolves while no file is selected, which is still in
      // state for the render that follows a click, before the effect re-runs —
      // must read as "not loaded yet" rather than reaching the accessors below.
      const diff =
        selected !== null && diffLoad.value !== null && diffLoad.value !== undefined && Array.isArray(diffLoad.value.hunks)
          ? diffLoad.value
          : undefined;

      return h(
        'div',
        { className: 'dsc-root' },
        h(
          'header',
          { className: 'dsc-header' },
          h('span', { className: 'dsc-branch', title: repository.branch ?? repository.head ?? '' }, repository.branch ?? '—'),
          tree.ahead > 0 ? h('span', { className: 'dsc-track' }, t('ahead').replace('{n}', String(tree.ahead))) : null,
          tree.behind > 0 ? h('span', { className: 'dsc-track' }, t('behind').replace('{n}', String(tree.behind))) : null,
          h('span', { className: 'dsc-spacer' }),
          h(
            'button',
            { type: 'button', className: 'dsc-tool', title: t('action.refresh'), 'aria-label': t('action.refresh'), onClick: status.reload },
            h(IconRefresh, {}),
          ),
        ),
        selected === null
          ? h(
              'div',
              { className: 'dsc-body' },
              notice === null ? null : h('p', { className: 'dsc-error' }, notice.text),
              clean ? h('p', { className: 'dsc-status' }, t('state.clean')) : null,
              h(
                Group,
                {
                  title: t('section.conflicts'),
                  rows: conflictRows,
                  badge: 'u',
                  t,
                  bulk: null,
                },
                conflictRows.map((row) =>
                  h(ChangeRow, {
                    key: `c-${row.path}`,
                    row,
                    badge: 'u',
                    t,
                    onOpen: () => openDiff(row, false),
                    onPrimary: () => run('stage', { ...selector, paths: [row.path] }),
                    primaryLabel: t('action.stage'),
                    primaryIcon: h(IconStage, {}),
                    onDiscard: () => setPendingDiscard({ row, untracked: false }),
                  }),
                ),
              ),
              h(
                Group,
                {
                  title: t('section.staged'),
                  rows: stagedRows,
                  badge: 'm',
                  t,
                  bulk:
                    stagedRows.length > 1
                      ? h(
                          'button',
                          {
                            type: 'button',
                            className: 'dsc-mini',
                            title: t('action.unstageAll'),
                            'aria-label': t('action.unstageAll'),
                            onClick: () => run('unstage', { ...selector, paths: stagedRows.map((row) => row.path) }),
                          },
                          h(IconUnstage, {}),
                        )
                      : null,
                },
                stagedRows.map((row) =>
                  h(ChangeRow, {
                    key: `s-${row.path}`,
                    row,
                    badge: rowKind(row, 'index'),
                    t,
                    onOpen: () => openDiff(row, true),
                    onPrimary: () => run('unstage', { ...selector, paths: [row.path] }),
                    primaryLabel: t('action.unstage'),
                    primaryIcon: h(IconUnstage, {}),
                    onDiscard: () => setPendingDiscard({ row, untracked: false }),
                  }),
                ),
              ),
              h(
                Group,
                {
                  title: t('section.changes'),
                  rows: changeRows,
                  badge: 'm',
                  t,
                  bulk:
                    changeRows.length > 1
                      ? h(
                          'button',
                          {
                            type: 'button',
                            className: 'dsc-mini',
                            title: t('action.stageAll'),
                            'aria-label': t('action.stageAll'),
                            onClick: () => run('stage', { ...selector, paths: changeRows.map((row) => row.path) }),
                          },
                          h(IconStage, {}),
                        )
                      : null,
                },
                changeRows.map((row) =>
                  h(ChangeRow, {
                    key: `m-${row.path}`,
                    row,
                    badge: rowKind(row, 'worktree'),
                    t,
                    onOpen: () => openDiff(row, false),
                    onPrimary: () => run('stage', { ...selector, paths: [row.path] }),
                    primaryLabel: t('action.stage'),
                    primaryIcon: h(IconStage, {}),
                    onDiscard: () => setPendingDiscard({ row, untracked: false }),
                  }),
                ),
              ),
              h(
                Group,
                {
                  title: t('section.untracked'),
                  rows: untrackedRows,
                  badge: 'a',
                  t,
                  bulk:
                    untrackedRows.length > 1
                      ? h(
                          'button',
                          {
                            type: 'button',
                            className: 'dsc-mini',
                            title: t('action.stageAll'),
                            'aria-label': t('action.stageAll'),
                            onClick: () => run('stage', { ...selector, paths: untrackedRows.map((row) => row.path) }),
                          },
                          h(IconStage, {}),
                        )
                      : null,
                },
                untrackedRows.map((row) =>
                  h(ChangeRow, {
                    key: `u-${row.path}`,
                    row,
                    badge: 'a',
                    t,
                    onOpen: () => openDiff(row, false),
                    onPrimary: () => run('stage', { ...selector, paths: [row.path] }),
                    primaryLabel: t('action.stage'),
                    primaryIcon: h(IconStage, {}),
                    onDiscard: () => setPendingDiscard({ row, untracked: true }),
                  }),
                ),
              ),
              showHistory ? historySlot : null,
            )
          : h(
              'div',
              { className: 'dsc-diff' },
              h(
                'div',
                { className: 'dsc-diffHead' },
                h(
                  'button',
                  { type: 'button', className: 'dsc-tool', title: t('action.back'), 'aria-label': t('action.back'), onClick: () => setSelected(null) },
                  h(IconBack, {}),
                ),
                h('span', { className: 'dsc-diffPath', title: selected.row.path }, selected.row.path),
                diff === undefined
                  ? null
                  : h(
                      'span',
                      { className: 'dsc-stat' },
                      h('span', { className: 'dsc-statAdd' }, `+${diff.added}`),
                      ' ',
                      h('span', { className: 'dsc-statDel' }, `−${diff.removed}`),
                    ),
              ),
              diffLoad.status === 'error'
                ? h('p', { className: 'dsc-status' }, diffLoad.error.message)
                : h(DiffView, {
                    diff,
                    path: selected.row.path,
                    t,
                    side: selected.staged ? 'index' : 'worktree',
                    busy,
                    onHunk: (hunkIndex, action) => {
                      if (action === 'discard') {
                        setPendingHunk({ row: selected.row, hunkIndex });
                        return;
                      }
                      // No explicit diff reload: diffLoad's deps include
                      // status.value, so the refresh inside `run` re-reads it.
                      run(`${action}-hunk`, { ...selector, path: selected.row.path, hunkIndex });
                    },
                  }),
              h(
                'div',
                { className: 'dsc-compose' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsc-btn dsc-btn-quiet',
                    disabled: busy,
                    onClick: () =>
                      run(selected.staged ? 'unstage' : 'stage', { ...selector, paths: [selected.row.path] }),
                  },
                  selected.staged ? t('action.unstage') : t('action.stage'),
                ),
              ),
            ),
        pendingHunk === null
          ? null
          : h(
              'div',
              { className: 'dsc-confirm', role: 'alertdialog', 'aria-label': t('confirm.discardHunkTitle') },
              h('p', { className: 'dsc-confirmTitle' }, t('confirm.discardHunkTitle')),
              h(
                'p',
                { className: 'dsc-confirmBody' },
                t('confirm.discardHunkBody')
                  .replace('{path}', pendingHunk.row.path)
                  .replace('{n}', String(pendingHunk.hunkIndex + 1)),
              ),
              h(
                'div',
                { className: 'dsc-confirmActions' },
                h(
                  'button',
                  { type: 'button', className: 'dsc-btn dsc-btn-quiet', onClick: () => setPendingHunk(null) },
                  t('action.cancel'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsc-btn dsc-btn-danger',
                    disabled: busy,
                    autoFocus: true,
                    onClick: () =>
                      run('discard-hunk', {
                        ...selector,
                        path: pendingHunk.row.path,
                        hunkIndex: pendingHunk.hunkIndex,
                      }),
                  },
                  t('action.confirmDiscard'),
                ),
              ),
            ),
        pendingDiscard === null
          ? null
          : h(
              'div',
              { className: 'dsc-confirm', role: 'alertdialog', 'aria-label': t('confirm.discardTitle') },
              h('p', { className: 'dsc-confirmTitle' }, t('confirm.discardTitle')),
              h(
                'p',
                { className: 'dsc-confirmBody' },
                t(pendingDiscard.untracked ? 'confirm.discardUntracked' : 'confirm.discardBody').replace('{path}', pendingDiscard.row.path),
              ),
              h(
                'div',
                { className: 'dsc-confirmActions' },
                h(
                  'button',
                  { type: 'button', className: 'dsc-btn dsc-btn-quiet', onClick: () => setPendingDiscard(null) },
                  t('action.cancel'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsc-btn dsc-btn-danger',
                    disabled: busy,
                    autoFocus: true,
                    onClick: () => run('discard', { ...selector, paths: [pendingDiscard.row.path] }),
                  },
                  t('action.confirmDiscard'),
                ),
              ),
            ),
        notice !== null && selected !== null ? h('p', { className: 'dsc-error' }, notice.text) : null,
        h(
          'div',
          { className: 'dsc-compose' },
          lastCommit === null ? null : h('p', { className: 'dsc-status', style: { padding: 0 } }, t('commit.summary').replace('{short}', lastCommit.short)),
          h('label', { className: 'dsc-hidden', htmlFor: messageId }, t('commit.placeholder')),
          h('textarea', {
            id: messageId,
            className: 'dsc-input',
            placeholder: t('commit.placeholder'),
            value: message,
            disabled: busy,
            onChange: (event) => setMessage(event.target.value),
            onKeyDown: (event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault();
                commit();
              }
            },
          }),
          h(
            'button',
            {
              type: 'button',
              className: 'dsc-btn',
              disabled: busy || message.trim() === '' || stagedRows.length === 0,
              onClick: commit,
            },
            busy ? t('action.committing') : t('action.commit'),
          ),
        ),
      );
    }

    // -----------------------------------------------------------------------
    // commit history (main page only)
    // -----------------------------------------------------------------------

    /**
     * The history column: recent commits, newest first.
     *
     * Pages ACCUMULATE rather than replace: "Load more" that discarded the
     * previous page would make commits vanish while its label promised the
     * opposite. `revision` is the page's shared invalidation counter, so a commit
     * made in the panel beside it repaints this column without a manual refresh.
     */
    function History({ selector, t, revision }) {
      const [pages, setPages] = React.useState({ skip: 0, commits: [] });
      const load = useLoad(
        (signal) => call('log', { query: { ...selector, skip: pages.skip }, signal }),
        [selector.sessionId, selector.repo, pages.skip, revision],
      );
      const loaded = load.value?.commits;
      React.useEffect(() => {
        if (loaded === undefined) return;
        setPages((current) => {
          if (current.skip === 0) return { skip: 0, commits: loaded };
          const seen = new Set(current.commits.map((commit) => commit.hash));
          return { skip: current.skip, commits: [...current.commits, ...loaded.filter((commit) => !seen.has(commit.hash))] };
        });
      }, [loaded]);
      // A revision change (a new commit, a discarding write) resets to one page.
      React.useEffect(() => {
        setPages({ skip: 0, commits: [] });
      }, [revision, selector.sessionId, selector.repo]);
      const commits = pages.commits;
      const shown = pages.skip === 0 ? (loaded ?? commits) : commits;
      return h(
        'div',
        { className: 'dsc-root' },
        h(
          'header',
          { className: 'dsc-colHead' },
          h('span', {}, t('history.title')),
          h('span', { className: 'dsc-spacer' }),
          h(
            'button',
            { type: 'button', className: 'dsc-mini', title: t('action.refresh'), 'aria-label': t('action.refresh'), onClick: load.reload },
            h(IconRefresh, {}),
          ),
        ),
        load.status === 'loading' && shown.length === 0
          ? h('p', { className: 'dsc-status' }, t('state.loading'))
          : load.status === 'error'
            ? h('p', { className: 'dsc-status' }, load.error.message)
            : shown.length === 0
              ? h('p', { className: 'dsc-status' }, t('history.empty'))
              : h(
                  'ul',
                  { className: 'dsc-history' },
                  shown.map((commit) =>
                    h(
                      'li',
                      { key: commit.hash, className: 'dsc-commit' },
                      h('p', { className: 'dsc-commitSubject' }, commit.subject),
                      // `date` is not guaranteed: a truncated response or an
                      // unusual commit can omit it, and reading through it would
                      // blank the whole page through the error boundary.
                      h('p', { className: 'dsc-commitMeta' }, [commit.short, commit.author, String(commit.date ?? '').slice(0, 10)].filter(Boolean).join(' · ')),
                    ),
                  ),
                ),
        commits.length > 0
          ? h(
              'div',
              { className: 'dsc-compose' },
              h(
                'button',
                { type: 'button', className: 'dsc-btn dsc-btn-quiet', onClick: () => setPages((current) => ({ skip: current.commits.length, commits: current.commits })) },
                t('action.loadMore'),
              ),
            )
          : null,
      );
    }

    // -----------------------------------------------------------------------
    // surfaces
    // -----------------------------------------------------------------------

    /** The right-sidebar tab body: the panel, scoped to the tab's Session. */
    function SourceControlTabBody(props) {
      const { sessionId, useTabInfo, t, tabInfo: injectedTabInfo } = props;
      // `useTabInfo` is a framework-bound hook delivered as a prop, so it is
      // called unconditionally: a conditional call site is a hooks-order
      // violation the moment its condition can change.
      const useTabInfoHook = useTabInfo ?? (() => injectedTabInfo ?? null);
      const tabInfo = useTabInfoHook();
      const signal = tabInfo?.tab?.signal;
      const [revision, setRevision] = React.useState(0);
      React.useEffect(() => {
        if (signal === undefined) return undefined;
        const onAbort = () => setRevision((value) => value + 1);
        signal.addEventListener('abort', onAbort);
        return () => signal.removeEventListener('abort', onAbort);
      }, [signal]);
      const selector = React.useMemo(() => ({ sessionId }), [sessionId]);
      if (typeof sessionId !== 'string' || sessionId === '') {
        return h('div', { className: 'dsc-root' }, h('p', { className: 'dsc-status' }, t('state.noWorkspace')));
      }
      return h(SourceControlPanel, { key: revision, selector, t, showHistory: false, surface: 'tab' });
    }

    /** The main page: repository picker, the panel, and the history column. */
    function SourceControlPage(props) {
      const { t } = props;
      const catalog = useLoad((signal) => call('git', { signal }), []);
      const [chosen, setChosen] = React.useState(null);
      // One counter shared by the panel and the history column: a write in either
      // invalidates the other, so a new commit shows up without a manual refresh.
      const [revision, setRevision] = React.useState(0);
      const bumpRevision = React.useCallback(() => setRevision((value) => value + 1), []);
      const usable = React.useMemo(
        () => (catalog.value?.repositories ?? []).filter((row) => row.isRepository === true),
        [catalog.value],
      );
      // The picked repository wins; otherwise the page lands on the first real
      // repository the live Sessions offer, so opening it without choosing is
      // never an empty screen.
      const active = React.useMemo(() => {
        if (chosen !== null) return usable.find((row) => row.root === chosen) ?? usable[0] ?? null;
        return usable[0] ?? null;
      }, [chosen, usable]);

      if (catalog.status === 'loading') {
        return h('div', { className: 'dsc-root dsc-page' }, h('p', { className: 'dsc-status' }, t('state.loading')));
      }
      if (catalog.status === 'error') {
        return h(
          'div',
          { className: 'dsc-root dsc-page' },
          h('p', { className: 'dsc-status' }, `${t('state.error')}: ${catalog.error.message}`),
        );
      }
      if (catalog.value?.available === false) {
        return h('div', { className: 'dsc-root dsc-page' }, h('p', { className: 'dsc-status' }, t('state.gitUnavailable')));
      }
      if (usable.length === 0) {
        return h('div', { className: 'dsc-root dsc-page' }, h('p', { className: 'dsc-status' }, t('state.noRepo')));
      }

      const selector = active === null ? {} : { repo: active.root };
      return h(
        'div',
        { className: 'dsc-root dsc-page' },
        h(
          'header',
          { className: 'dsc-pageHead' },
          h('h1', { className: 'dsc-pageTitle' }, t('panel')),
          h('label', { className: 'dsc-hidden', htmlFor: 'dsc-repo-picker' }, t('repo.label')),
          h(
            'select',
            {
              id: 'dsc-repo-picker',
              className: 'dsc-select',
              value: active?.root ?? '',
              onChange: (event) => setChosen(event.target.value),
            },
            usable.map((row) => h('option', { key: row.root, value: row.root }, `${row.label} — ${row.root}`)),
          ),
        ),
        h(
          'div',
          { className: 'dsc-pageBody' },
          h('div', { className: 'dsc-col' }, h(SourceControlPanel, { selector, t, showHistory: false, surface: 'page', onChanged: bumpRevision })),
          h('div', { className: 'dsc-col' }, h(History, { selector, t, revision })),
        ),
      );
    }

    /** Catches a render failure so a defect shows a message instead of blanking the seat. */
    class Boundary extends React.Component {
      /** @param {object} props - `{t, children}`. */
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      /**
       * @param {Error} error - the thrown error.
       * @returns {object} the new state.
       */
      static getDerivedStateFromError(error) {
        return { error };
      }

      /** @param {Error} error - the thrown error. */
      componentDidCatch(error) {
        console.error('[source-control] panel failed to render:', error);
      }

      /**
       * @returns {object} the child tree, or the failure notice.
       */
      render() {
        if (this.state.error !== null) {
          return h('div', { className: 'dsc-root' }, h('p', { className: 'dsc-status' }, `${this.props.t('state.error')}: ${this.state.error.message}`));
        }
        return this.props.children;
      }
    }

    /**
     * Wrap one surface in the failure boundary and hand it the copy function.
     * @param {Function} t - namespace-bound translate.
     * @param {Function} Component - the surface.
     * @returns {Function} the registrable component.
     */
    const guarded = (t, Component) =>
      function Guarded(props) {
        return h(Boundary, { t }, h(Component, { ...props, t }));
      };

    // -----------------------------------------------------------------------
    // plugin body
    // -----------------------------------------------------------------------

    /** Services this bundle needs; `sidebarRightTabs` is what makes a tab type possible. */
    const inject = ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight', 'layout'];

    /**
     * Register both surfaces, their copy, and the guide entry.
     * @param {object} ctx - the client root context.
     */
    function apply(ctx) {
      installStyles();
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'source-control: dictionaries');
      const t = ctx.locale.bind(NS);

      // Stage one: the tab type. `extension` is the default band and is named
      // explicitly so a reader can see this type is not a builtin takeover.
      ctx.effect(
        () =>
          ctx.sidebarRightTabs.register({
            id: ID,
            kind: KIND,
            priority: 'extension',
            title: () => t('tab.title'),
            guide: [
              {
                id: 'source-control',
                order: 40,
                title: () => t('guide.title'),
                description: () => t('guide.description'),
                icon: IconSourceControl,
              },
            ],
          }),
        'source-control: tab type',
      );

      // Stage two: the tab body, under the type's own id.
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register(
              { name: 'sidebar.right.pane.tab', key: ID, locale: NS },
              guarded(t, SourceControlTabBody),
            ),
          ),
        'source-control: sidebar tab body',
      );

      // The main page and the sidebar icon that selects it share one id: the
      // shell validates `selectPanel(id)` against the live `main` occupants.
      ctx.effect(
        () =>
          ctx.slots.inject('main', () =>
            ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, guarded(t, SourceControlPage)),
          ),
        'source-control: main page',
      );

      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              { name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => t('panel'), locale: NS },
              IconSourceControl,
            ),
          ),
        'source-control: sidebar entry',
      );
    }

    // `messages` is exported for verification: it lets a test render the REAL
    // copy (so placeholder substitution is genuinely exercised) and assert the
    // two languages carry the same key set, which is otherwise easy to drift.
    return { apply, inject, name: ID, messages: { en, zh } };
  },
});
