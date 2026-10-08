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
      'diff.select': 'Select a file to review its changes.',
      'diff.worktree': 'Working Tree',
      'diff.index': 'Index',
      'action.closeDiff': 'Close diff',
      'commit.hint': 'Commit staged changes · Ctrl/Cmd+Enter',
      'diff.binary': 'Binary file — no line diff.',
      'history.title': 'History',
      'history.empty': 'No commits yet.',
      'repo.label': 'Repository',
      'repo.none': 'No repository found',
      'ahead': '{n} ahead',
      'behind': '{n} behind',
      'renamed': 'renamed from {path}',
      'action.more': 'More Git actions',
      'github.repository': 'Open GitHub repository',
      'github.pulls': 'Pull requests',
      'github.issues': 'Issues',
      'github.review': 'GitHub Review',
      'github.local': 'Local Git',
      'github.open': 'Open',
      'github.closed': 'Closed',
      'github.refresh': 'Refresh GitHub',
      'github.select': 'Select a pull request for review.',
      'github.empty': 'Nothing to show in the first page.',
      'github.firstPage': 'Showing up to 30 items. Read-only public GitHub API.',
      'github.files': 'Changed files',
      'github.checks': 'Checks',
      'github.checksUnavailable': 'Checks unavailable without authorization.',
      'github.noPatch': 'No text patch available (binary, too large or omitted).',
      'github.truncated': 'Patch preview truncated. Open the PR on GitHub for the full diff.',
      'github.openOnGithub': 'Open on GitHub',
      'github.create': 'Create Pull Request',
      'github.createHint': 'A pushed branch is required; no commits will be pushed automatically.',
      'github.createConfirm': 'Review and confirm creation',
      'github.createSubmit': 'Confirm: create Pull Request on GitHub',
      'github.createSource': 'Source branch',
      'github.createBase': 'Target branch',
      'github.createTitle': 'Pull Request title',
      'github.createBody': 'Description',
      'github.createDraft': 'Draft Pull Request',
      'github.createCancel': 'Cancel',
      'action.branches': 'Switch branch',
      'action.createBranch': 'Create branch',
      'action.fetch': 'Fetch',
      'action.pull': 'Pull (fast-forward only)',
      'action.push': 'Push',
      'action.confirm': 'Confirm',
      'action.progress': 'Operation in progress…',
      'branch.local': 'Local branch',
      'branch.remote': 'Remote tracking branch',
      'branch.name': 'New local branch name',
      'branch.cleanRequired': 'Switching, creating a branch and pulling require a clean working tree. Commit or discard changes first; nothing will be stashed automatically.',
      'branch.unavailable': 'Branch information is unavailable. Refresh to retry.',
      'branch.detached': 'Detached HEAD — switch to or create a local branch before pulling or pushing.',
      'remote.label': 'Configured remote',
      'remote.branch': 'Destination branch',
      'remote.source': 'Source branch',
      'remote.sourceChanged': 'The source branch changed while this dialog was open. Cancel and reopen to review the new source; nothing will be sent.',
      'remote.none': 'No remotes are configured for this repository.',
      'remote.upstream': 'Set upstream and push',
      'remote.confirmUpstream': 'This branch has no upstream. Confirm the repository, configured remote and destination below to set its upstream and perform an ordinary push. No force push.',
      'remote.ffOnly': 'Only a fast-forward is allowed. Diverged branches will be refused; no merge, rebase or automatic stash.',
      'remote.normalPush': 'Ordinary push only; history will never be forced.',
      'remote.missing': 'not configured any more',
      'remote.targetMissing': 'This branch tracks a remote that is no longer configured. Choose a configured remote and destination to retry; nothing was sent.',
      'files.filter': 'Filter changed files',
      'files.list': 'List view',
      'files.tree': 'Tree view',
      'files.noMatches': 'No changed files match this filter.',
      'history.readOnly': 'Historical commit · read-only',
      'history.parents': 'Parents',
      'history.files': 'Changed files',
      'history.boundary': 'Parent ancestry continues beyond the loaded graph',
      'history.selectFile': 'Select a changed file to review this commit.',
      'resize.navigation': 'Navigation width (arrow keys; double-click to reset)',
      'resize.history': 'Commit graph height (arrow keys; Home collapses; double-click to reset)',
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
      'diff.select': '选择文件以查看更改。',
      'diff.worktree': '工作区',
      'diff.index': '已暂存',
      'action.closeDiff': '关闭差异',
      'commit.hint': '提交已暂存的更改 · Ctrl/Cmd+Enter',
      'diff.binary': '二进制文件，无法按行比较。',
      'history.title': '提交历史',
      'history.empty': '还没有任何提交。',
      'repo.label': '仓库',
      'repo.none': '未找到仓库',
      'ahead': '领先 {n}',
      'behind': '落后 {n}',
      'renamed': '由 {path} 重命名',
      'action.more': '更多 Git 操作',
      'github.repository': '打开 GitHub 仓库',
      'github.pulls': '查看 Pull Requests',
      'github.issues': '查看 Issues',
      'github.review': 'GitHub 审查',
      'github.local': '本地 Git',
      'github.open': '进行中',
      'github.closed': '已关闭',
      'github.refresh': '刷新 GitHub',
      'github.select': '选择一个 Pull Request 查看详情和差异。',
      'github.empty': '当前首页没有可显示的项目。',
      'github.firstPage': '最多展示前 30 项，仅使用 GitHub 公开只读 API。',
      'github.files': '更改文件',
      'github.checks': '检查状态',
      'github.checksUnavailable': '未授权，无法读取检查状态。',
      'github.noPatch': '无法显示文本补丁（二进制、过大或 GitHub 未返回）。',
      'github.truncated': '补丁预览已截断，请到 GitHub 查看完整差异。',
      'github.openOnGithub': '在 GitHub 打开',
      'github.create': '创建 Pull Request',
      'github.createHint': '必须已推送当前分支；不会自动推送提交。',
      'github.createConfirm': '核对并确认创建',
      'github.createSubmit': '确认：在 GitHub 创建 Pull Request',
      'github.createSource': '源分支',
      'github.createBase': '目标分支',
      'github.createTitle': 'PR 标题',
      'github.createBody': 'PR 描述',
      'github.createDraft': '创建草稿 PR',
      'github.createCancel': '取消',
      'action.branches': '切换分支',
      'action.createBranch': '创建分支',
      'action.fetch': '获取',
      'action.pull': '拉取（仅快进）',
      'action.push': '推送',
      'action.confirm': '确认',
      'action.progress': '操作进行中…',
      'branch.local': '本地分支',
      'branch.remote': '远程跟踪分支',
      'branch.name': '新本地分支名称',
      'branch.cleanRequired': '切换、创建分支和拉取需要干净工作区。请先提交或放弃更改；不会自动贮藏。',
      'branch.unavailable': '分支信息不可用，请刷新重试。',
      'branch.detached': 'HEAD 已分离，请先切换或创建本地分支后再拉取或推送。',
      'remote.label': '已配置的远程',
      'remote.branch': '目标分支',
      'remote.source': '源分支',
      'remote.sourceChanged': '对话框打开后源分支已改变。请取消并重新打开以确认新的源分支；不会发送任何操作。',
      'remote.none': '此仓库尚未配置远程。',
      'remote.upstream': '设置上游并推送',
      'remote.confirmUpstream': '此分支没有上游。请确认下方仓库、已配置远程和目标分支，然后设置上游并普通推送。不会强制推送。',
      'remote.ffOnly': '仅允许快进。分叉将被拒绝；不会合并、变基或自动贮藏。',
      'remote.normalPush': '仅普通推送，不会强制改写历史。',
      'remote.missing': '已不再配置',
      'remote.targetMissing': '此分支跟踪的远程已不存在。请选择一个已配置的远程和目标分支后重试；未发送任何操作。',
      'files.filter': '筛选更改文件',
      'files.list': '列表视图',
      'files.tree': '树形视图',
      'files.noMatches': '没有匹配筛选条件的更改文件。',
      'history.readOnly': '历史提交 · 只读',
      'history.parents': '父提交',
      'history.files': '更改文件',
      'history.boundary': '父提交位于已加载图之外',
      'history.selectFile': '选择更改文件以查看此提交。',
      'resize.navigation': '导航宽度（方向键调整；双击重置）',
      'resize.history': '提交图高度（方向键调整；Home 收起；双击重置）',
    };

    // -----------------------------------------------------------------------
    // styles
    // -----------------------------------------------------------------------

    const CSS = `
.dsc-root{box-sizing:border-box;color:var(--dsw-alias-label-primary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.5;display:flex;flex-direction:column;flex:auto;min-height:0;min-width:0;height:100%}
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
.dsc-group{margin-top:4px}
.dsc-groupHead{display:flex;align-items:center;gap:4px;min-height:30px;padding:0 8px 0 4px;background:var(--dsw-alias-bg-layer-2)}
.dsc-groupToggle{display:flex;align-items:center;gap:6px;min-width:0;flex:auto;padding:4px 0;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dsc-chevron{width:16px;height:16px;flex:none;transition:transform .12s}
.dsc-chevron-open{transform:rotate(90deg)}
.dsc-groupTitle{font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsc-groupCount{margin-left:auto;min-width:18px;border-radius:10px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:11px;text-align:center;padding:0 4px}
.dsc-groupActions{display:flex;gap:2px}
.dsc-item{display:flex;align-items:center;min-height:28px;padding-right:8px;position:relative}
.dsc-item:hover,.dsc-item:focus-within{background:var(--dsw-alias-interactive-bg-hover)}
.dsc-item-selected{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary)}
.dsc-row{min-width:0;color:inherit;font:inherit;text-align:left;cursor:pointer;background:none;border:0;display:flex;align-items:center;gap:6px;padding:3px 6px 3px 20px;flex:auto;min-height:28px}
.dsc-fileIcon{width:15px;height:15px;flex:none;color:var(--dsw-alias-label-secondary)}
.dsc-badge{width:14px;flex:none;text-align:center;font-weight:700;font-size:11px;font-family:var(--dsw-font-mono,monospace)}
.dsc-badge-m{color:var(--dsw-alias-state-warn-primary)}
.dsc-badge-a,.dsc-badge-untracked{color:var(--dsw-alias-state-success-primary)}
.dsc-badge-d{color:var(--dsw-alias-state-error-primary)}
.dsc-badge-r{color:var(--dsw-alias-brand-primary)}
.dsc-badge-u{color:var(--dsw-alias-state-idle-primary)}
.dsc-name{white-space:nowrap;overflow:hidden;min-width:0;flex:auto;display:flex;align-items:baseline;gap:7px;text-align:left}
.dsc-base{white-space:nowrap;text-overflow:ellipsis;overflow:hidden;min-width:0}
.dsc-dir{color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap;text-overflow:ellipsis;overflow:hidden;min-width:0;flex:1}
.dsc-rowTools{display:flex;gap:2px;flex:none;opacity:0}
.dsc-item:hover .dsc-rowTools,.dsc-item:focus-within .dsc-rowTools{opacity:1}
@media (hover:none){.dsc-rowTools{opacity:1}}
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
.dsc-diff{display:flex;flex-direction:column;min-height:0;min-width:0;flex:auto;overflow:hidden}
.dsc-diffHead{display:flex;align-items:center;gap:6px;padding:6px 12px;border-bottom:.5px solid var(--dsw-alias-border-l1);flex:none}
.dsc-diffPath{font-family:var(--dsw-font-mono,monospace);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:auto}
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
.dsc-page{padding-top:calc(28px + var(--dsh-frame-top-clearance,0px));overflow:hidden;min-width:0}
.dsc-pageHead{display:flex;align-items:center;gap:12px;min-height:44px;padding:0 12px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}
.dsc-pageTitle{margin:0;font-size:13px;font-weight:600;white-space:nowrap}
.dsc-select{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:3px;font:inherit;padding:3px 6px;min-width:0;max-width:min(420px,60vw)}
.dsc-workbench{display:grid;grid-template-columns:clamp(150px,var(--dsc-nav-width,34%),calc(100% - 156px)) 6px minmax(0,1fr);flex:auto;min-height:0;min-width:0;overflow:hidden}
.dsc-navigator{display:flex;flex-direction:column;flex:auto;min-height:0;min-width:0;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}
.dsc-workbench>.dsc-navigator{border-right:1px solid var(--dsw-alias-border-l1)}
.dsc-editor{display:flex;flex-direction:column;min-height:0;min-width:0;overflow:hidden}
.dsc-editorEmpty{flex:auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;text-align:center;color:var(--dsw-alias-label-secondary);padding:24px}
.dsc-editorEmpty svg{width:36px;height:36px;opacity:.45}
.dsc-editorEmpty p{margin:0}
.dsc-commitBox{border-top:0;padding:10px 12px 12px}
.dsc-commitBox .dsc-input{min-height:36px;max-height:180px;border-radius:3px}
.dsc-commitBox .dsc-btn{display:flex;align-items:center;justify-content:center;gap:6px;border-radius:3px;min-height:30px}
.dsc-commitHint{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsc-diffSide{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dsc-split{display:flex;flex-direction:column;min-height:0;min-width:0;flex:1;overflow:hidden}
.dsc-split>.dsc-body{flex:1;min-height:64px}
.dsc-historySection{box-sizing:border-box;flex:0 0 32px;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.dsc-historySection-open{flex-basis:clamp(80px,var(--dsc-history-height,40%),calc(100% - 76px))}
.dsc-resize{flex:none;touch-action:none;user-select:none;background:var(--dsw-alias-border-l1);outline-offset:-2px;display:flex;align-items:center;justify-content:center;gap:2px}
.dsc-resize:hover,.dsc-resize:focus-visible{background:var(--dsw-alias-brand-primary)}
.dsc-grip{width:3px;height:3px;border-radius:50%;background:var(--dsw-alias-label-secondary);opacity:.5;pointer-events:none}
.dsc-resize:hover .dsc-grip,.dsc-resize:focus-visible .dsc-grip{background:var(--dsw-alias-bg-layer-1);opacity:.9}
.dsc-resize-width{cursor:col-resize;width:6px}
.dsc-resize-height{cursor:row-resize;height:6px}
.dsc-fileControls{display:flex;gap:4px;padding:4px 8px;flex:none;min-width:0}
.dsc-filter{width:100%;min-width:0;background:var(--dsw-alias-bg-layer-1);color:inherit;border:1px solid var(--dsw-alias-border-l1);font:inherit;padding:3px 6px}
.dsc-folder{padding-left:12px}
.dsc-folder>.dsc-groupToggle{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsc-folderRows{padding-left:8px}
.dsc-menu{display:flex;flex-wrap:wrap;gap:4px;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}
.dsc-menu a.dsc-btn{display:inline-flex;align-items:center;text-decoration:none}
.dsc-dialogFields{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px}
.dsc-dialogFields label{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1 1 130px}
.dsc-dialogFields input,.dsc-dialogFields select{box-sizing:border-box;width:100%;max-width:100%}
.dsc-details{overflow:auto;min-height:0;min-width:0;padding:12px}
.dsc-details pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}
.dsc-details code{overflow-wrap:anywhere}
.dsc-details .dsc-row{width:100%;padding-left:0}
.dsc-graph{flex:none;overflow:visible;color:var(--dsw-alias-brand-primary)}
.dsc-commitButton{display:flex;align-items:center;gap:6px;min-width:0;width:100%;border:0;padding:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dsc-ref{font-size:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:3px;padding:0 3px;max-width:80px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:none}
.dsc-branchButton{background:none;border:0;color:inherit;font:inherit;cursor:pointer;max-width:60%;padding:0;text-align:left}
.dsc-historyToggle{display:flex;align-items:center;gap:6px;flex:none;background:none;border:0;color:inherit;font:inherit;cursor:pointer;min-height:32px;padding:0 8px;font-size:12px;font-weight:600;text-align:left}
.dsc-historySection .dsc-root{height:auto;min-height:0;overflow:hidden}
.dsc-historySection .dsc-compose{padding:6px 8px}
.dsc-mini:disabled,.dsc-tool:disabled{opacity:.45;cursor:default}
.dsc-groupToggle:focus-visible,.dsc-mini:focus-visible,.dsc-historyToggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dsc-history{overflow:auto;flex:auto;min-height:0;margin:0;padding:0;list-style:none}
.dsc-commit{position:relative;display:flex;align-items:center;gap:8px;min-height:26px;padding:1px 8px;border-bottom:.5px solid var(--dsw-alias-border-l1)}
.dsc-commit:last-child{border-bottom:none}
.dsc-commitSubject{margin:0;flex:auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:400}
.dsc-commitMeta{margin:0;flex:none;max-width:60px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:var(--dsw-font-xxs-12,12px)}
.dsc-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media (max-width:760px){.dsc-hunkHead{flex-wrap:wrap}.dsc-hunkTools{margin-left:auto}.dsc-pageHead{gap:8px}.dsc-track{font-size:10px}}
@media (max-width:540px){.dsc-workbench{display:flex;flex-direction:column;overflow:auto}.dsc-workbench>.dsc-navigator{flex:1 0 430px;min-height:430px;border-right:0;border-bottom:1px solid var(--dsw-alias-border-l1)}.dsc-workbench>.dsc-editor{flex:1 0 220px;min-height:220px}.dsc-workbench>.dsc-resize-width{display:none}.dsc-pageTitle{font-size:12px}.dsc-select{flex:1;max-width:100%}.dsc-confirm{max-height:55%;overflow:auto}.dsc-root .dsc-commitBox{padding-top:6px;padding-bottom:6px}}
@media (max-height:500px){.dsc-compose{padding-top:4px;padding-bottom:4px}.dsc-commitHint{display:none}.dsc-split>.dsc-body{min-height:32px}.dsc-historySection-open{flex-basis:clamp(48px,var(--dsc-history-height,40%),calc(100% - 44px))}}
.dsc-gh-top{display:flex;align-items:center;flex-wrap:wrap;gap:6px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dsc-gh-top button[aria-pressed=true]{font-weight:700;border-color:var(--dsw-alias-brand-primary)}
.dsc-gh-layout{display:grid;grid-template-columns:minmax(200px,34%) minmax(0,1fr);min-height:0;flex:1;overflow:hidden}
.dsc-gh-list{overflow:auto;min-height:0;min-width:0;border-right:1px solid var(--dsw-alias-border-l1)}
.dsc-gh-entry{display:block;width:100%;padding:9px 12px;border:none;border-bottom:1px solid var(--dsw-alias-border-l1);background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dsc-gh-entry:hover,.dsc-gh-entry[aria-pressed=true]{background:var(--dsw-alias-bg-layer-2)}
.dsc-gh-entry small,.dsc-gh-meta{display:block;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsc-gh-detail{overflow:auto;min-height:0;min-width:0;padding:12px}
.dsc-gh-detail h3{font-size:14px;margin:0 0 8px}
.dsc-gh-detail h4{font-size:12px;margin:14px 0 6px}
.dsc-gh-detail p{white-space:pre-wrap;overflow-wrap:anywhere}
.dsc-gh-patch{border:1px solid var(--dsw-alias-border-l1);border-radius:4px;overflow:auto;font:12px/1.6 var(--dsw-font-mono,monospace)}
.dsc-gh-patchLine{white-space:pre;padding:0 8px;min-width:max-content}
.dsc-gh-add{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent)}
.dsc-gh-del{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 14%,transparent)}
.dsc-gh-hunk{background:var(--dsw-alias-bg-layer-2)}
.dsc-gh-files{display:flex;gap:4px;flex-wrap:wrap}
.dsc-gh-files button{max-width:100%;overflow:hidden;text-overflow:ellipsis}
.dsc-gh-detail a{color:var(--dsw-alias-brand-primary)}
@media(max-width:740px){.dsc-gh-layout{display:flex;flex-direction:column;overflow:auto}.dsc-gh-list{flex:0 0 auto;max-height:220px;border-right:0;border-bottom:1px solid var(--dsw-alias-border-l1)}.dsc-gh-detail{flex:1 0 240px;overflow:visible}}
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
          className: props?.className,
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
      if (row.untracked) return 'untracked';
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
     * @returns {{status: string, value: any, error: Error|null, current: boolean, reload: () => void}} the snapshot.
     */
    function useLoad(load, deps) {
      const [snapshot, setSnapshot] = React.useState({ status: 'loading', value: undefined, error: null, generation: -1 });
      const [nonce, setNonce] = React.useState(0);
      const loadRef = React.useRef(load);
      loadRef.current = load;
      React.useEffect(() => {
        const controller = new AbortController();
        let current = true;
        loadRef.current(controller.signal)
          .then((value) => {
            if (current) setSnapshot({ status: 'ready', value, error: null, generation: nonce });
          })
          .catch((error) => {
            if (!current || controller.signal.aborted) return;
            setSnapshot({ status: 'error', value: undefined, error, generation: nonce });
          });
        return () => {
          current = false;
          controller.abort();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [...deps, nonce]);
      // Keep the last data visible during refresh, but expose its freshness.
      // Incrementing nonce invalidates action eligibility in the next render,
      // even if a previous request resolves before the new effect is installed.
      return { ...snapshot, current: snapshot.generation === nonce,
        reload: React.useCallback(() => setNonce((value) => value + 1), []),
      };
    }

    // -----------------------------------------------------------------------
    // shared panel
    // -----------------------------------------------------------------------

    /** Mounted-surface geometry, deliberately independent of repository drafts. */
    function useSizing() {
      const [width, setWidth] = React.useState(34);
      const [height, setHeight] = React.useState(40);
      return { width, setWidth, height, setHeight };
    }

    /** Pointer capture keeps touch/mouse drags local; cancellation restores geometry. */
    function ResizeHandle({ axis, value, onChange, t }) {
      const drag = React.useRef(null);
      const horizontal = axis === 'width';
      const limit = horizontal ? [18, 75] : [0, 80];
      const defaultValue = horizontal ? 34 : 40;
      const update = (next, snap = false) => {
        let bounded = Math.max(limit[0], Math.min(limit[1], next));
        if (snap) {
          const stops = horizontal ? [25, 34, 50, 66] : [0, 25, 40, 50, 66, 80];
          const near = stops.find((stop) => Math.abs(stop - bounded) < 2.5);
          if (near !== undefined) bounded = near;
          if (!horizontal && bounded < 8) bounded = 0;
        }
        onChange(Math.round(bounded * 10) / 10);
      };
      const finish = (event, cancel = false) => {
        const active = drag.current;
        if (active === null || active.id !== event.pointerId) return;
        drag.current = null;
        if (cancel) onChange(active.initial);
        if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      };
      React.useEffect(() => () => {
        const active = drag.current;
        drag.current = null;
        if (active?.target.hasPointerCapture?.(active.id)) active.target.releasePointerCapture(active.id);
      }, []);
      return h('div', {
        className: `dsc-resize dsc-resize-${axis}`, role: 'separator', tabIndex: 0,
        'aria-label': t(horizontal ? 'resize.navigation' : 'resize.history'),
        'aria-orientation': horizontal ? 'vertical' : 'horizontal',
        'aria-valuemin': limit[0], 'aria-valuemax': limit[1], 'aria-valuenow': value,
        'aria-valuetext': `${value}%`,
        onDoubleClick: () => onChange(defaultValue),
        onPointerDown: (event) => {
          if (event.button !== undefined && event.button !== 0) return;
          const rect = event.currentTarget.parentElement.getBoundingClientRect();
          if ((horizontal ? rect.width : rect.height) <= 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { id: event.pointerId, initial: value, rect, target: event.currentTarget };
        },
        onPointerMove: (event) => {
          const active = drag.current;
          if (active === null || active.id !== event.pointerId) return;
          const { rect } = active;
          update(horizontal ? (event.clientX - rect.left) / rect.width * 100 : (rect.bottom - event.clientY) / rect.height * 100, true);
        },
        onPointerUp: (event) => finish(event),
        onPointerCancel: (event) => finish(event, true),
        onLostPointerCapture: (event) => finish(event, true),
        onKeyDown: (event) => {
          let next;
          if (event.key === 'Home') next = limit[0];
          else if (event.key === 'End') next = limit[1];
          else if (event.key === 'Enter' || event.key === '0') next = defaultValue;
          else if (event.key === (horizontal ? 'ArrowLeft' : 'ArrowDown')) next = value - (event.shiftKey ? 10 : 2);
          else if (event.key === (horizontal ? 'ArrowRight' : 'ArrowUp')) next = value + (event.shiftKey ? 10 : 2);
          if (next === undefined) return;
          event.preventDefault();
          update(next);
        },
        // A grip makes the separator findable before the pointer is already on
        // it: the dots are decorative, and every pointer/keyboard handler stays
        // on the separator itself.
      }, [0, 1, 2].map((dot) => h('span', { key: dot, className: 'dsc-grip', 'aria-hidden': 'true' })));
    }

    /** Real nested folders preserve each group's change-row action owner. */
    function FileTree({ rows, renderRow, prefix = '', t }) {
      const [collapsed, setCollapsed] = React.useState({});
      const folders = new Map();
      const files = [];
      rows.forEach((row) => {
        const rest = row.path.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash === -1) files.push(row);
        else {
          const name = rest.slice(0, slash);
          if (!folders.has(name)) folders.set(name, []);
          folders.get(name).push(row);
        }
      });
      return h('div', { className: 'dsc-tree' },
        [...folders].sort(([a], [b]) => a.localeCompare(b)).map(([name, children]) => h('div', { key: name, className: 'dsc-folder' },
          h('button', { type: 'button', className: 'dsc-groupToggle', 'aria-expanded': !collapsed[name], onClick: () => setCollapsed((state) => ({ ...state, [name]: !state[name] })) },
            glyph([h('path', { key: 'c', d: 'm6 4 4 4-4 4' })], { className: `dsc-chevron${collapsed[name] ? '' : ' dsc-chevron-open'}` }), name),
          collapsed[name] ? null : h('div', { className: 'dsc-folderRows' }, h(FileTree, { key: `${prefix}${name}/`, rows: children, renderRow, prefix: `${prefix}${name}/`, t })),
        )), files.sort((a, b) => a.path.localeCompare(b.path)).map(renderRow));
    }

    /** Configured targets only. Opening a dialog never performs a Git write. */
    function GitDialog({ kind, openingSource, branches, repository, clean, busy, operation, onCancel, onRun, t }) {
      // Source and upstream are the context presented when this dialog opens,
      // never a reinterpretation of refreshed props at submission time.
      // The panel retains this opening context even if a failed status/branch
      // refresh temporarily unmounts the dialog before recovery.
      const [source] = React.useState(() => openingSource);
      const current = source.branch;
      const sourceChanged = ['pull', 'push'].includes(kind) && (repository.branch !== current
        || branches.current !== current || branches.local.find((branch) => branch.current)?.name !== current);
      // The canonical target captured with the opening context: structured Git
      // metadata, so a pruned tracking ref or an abbreviated display name cannot
      // change the destination. `null` means no remote upstream exists. The
      // display name `upstream` is only ever shown, never resolved.
      const [trackedTarget] = React.useState(() => source.upstreamTarget ?? null);
      const [remote, setRemote] = React.useState(trackedTarget?.remote ?? branches.remotes[0]?.name ?? '');
      const [destination, setDestination] = React.useState(trackedTarget?.branch ?? current ?? '');
      const [target, setTarget] = React.useState(branches.local.find((branch) => !branch.current)?.name ?? current ?? '');
      const [remoteTarget, setRemoteTarget] = React.useState(false);
      const [name, setName] = React.useState('');
      const [confirmUpstream, setConfirmUpstream] = React.useState(false);
      const network = ['fetch', 'pull', 'push'].includes(kind);
      const needsClean = ['switch-branch', 'create-branch', 'pull'].includes(kind);
      // A push without a remote upstream must announce the upstream it is about
      // to create. A `.` local upstream is not a remote target, so it counts as
      // none here even though it has a display name.
      const needsUpstream = kind === 'push' && trackedTarget === null;
      // A captured target whose remote no longer exists is kept visible and
      // explained, but it cannot be submitted: `valid` requires the SELECTED
      // remote to be configured, so the recorded intent is never silently
      // replaced by whichever remote happens to be first in the list.
      const targetRemoteMissing = trackedTarget !== null && !branches.remotes.some((row) => row.name === trackedTarget.remote);
      const remoteBranch = branches.remote.find((branch) => branch.name === target);
      const valid = !busy && !sourceChanged && (!needsClean || clean) && (network
        ? branches.remotes.some((row) => row.name === remote) && (kind === 'fetch' || (current && destination.trim() !== ''))
        : kind === 'create-branch' ? name.trim() !== '' : remoteTarget ? remoteBranch !== undefined && name.trim() !== '' : branches.local.some((row) => row.name === target && !row.current));
      const submit = async () => {
        if (!valid) return;
        if (needsUpstream && !confirmUpstream) { setConfirmUpstream(true); return; }
        const body = network ? kind === 'fetch' ? { remote } : { remote, branch: destination.trim(), sourceBranch: current, ...(needsUpstream ? { setUpstream: true } : {}) }
          : kind === 'create-branch' ? { branch: name.trim() }
            : { branch: remoteTarget ? name.trim() : target, ...(remoteTarget ? { remoteBranch: target } : {}) };
        const result = await onRun(kind, body);
        if (result !== null) onCancel();
      };
      const field = (label, control) => h('label', {}, label, control);
      return h('div', { className: 'dsc-confirm', role: 'dialog', 'aria-label': t(kind === 'switch-branch' ? 'action.branches' : kind === 'create-branch' ? 'action.createBranch' : `action.${kind}`) },
        h('p', { className: 'dsc-confirmTitle' }, t(kind === 'switch-branch' ? 'action.branches' : kind === 'create-branch' ? 'action.createBranch' : `action.${kind}`)),
        h('p', { className: 'dsc-confirmBody' }, `${t('repo.label')}: ${repository.root}`),
        needsClean && !clean ? h('p', { className: 'dsc-confirmBody', role: 'status' }, t('branch.cleanRequired')) : null,
        network && branches.remotes.length === 0 ? h('p', { className: 'dsc-confirmBody' }, t('remote.none')) : null,
        targetRemoteMissing ? h('p', { className: 'dsc-confirmBody', role: 'status' }, t('remote.targetMissing')) : null,
        ['pull', 'push'].includes(kind) ? h('p', { className: 'dsc-confirmBody' }, `${t('remote.source')}: ${current ?? '—'} → ${remote}/${destination}`) : null,
        sourceChanged ? h('p', { className: 'dsc-confirmBody', role: 'status' }, t('remote.sourceChanged')) : null,
        ['pull', 'push'].includes(kind) && !current ? h('p', { className: 'dsc-confirmBody' }, t('branch.detached')) : null,
        kind === 'pull' ? h('p', { className: 'dsc-confirmBody' }, t('remote.ffOnly')) : null,
        kind === 'push' ? h('p', { className: 'dsc-confirmBody' }, t(confirmUpstream ? 'remote.confirmUpstream' : 'remote.normalPush')) : null,
        h('div', { className: 'dsc-dialogFields' },
          network ? field(t('remote.label'), h('select', { className: 'dsc-select', 'aria-label': t('remote.label'), value: remote, disabled: busy, onChange: (event) => { setRemote(event.target.value); setConfirmUpstream(false); } },
            // A captured remote that is no longer configured stays selected and
            // labelled, so the control cannot show a different default than the
            // state it actually submits.
            (targetRemoteMissing ? [h('option', { key: trackedTarget.remote, value: trackedTarget.remote }, `${trackedTarget.remote} — ${t('remote.missing')}`)] : []).concat(
              branches.remotes.map((row) => h('option', { key: row.name, value: row.name }, row.name)),
            ))) : null,
          ['pull', 'push'].includes(kind) ? field(t('remote.branch'), h('input', { className: 'dsc-filter', 'aria-label': t('remote.branch'), value: destination, disabled: busy, onChange: (event) => { setDestination(event.target.value); setConfirmUpstream(false); } })) : null,
          kind === 'switch-branch' ? field(t('action.branches'), h('select', { className: 'dsc-select', 'aria-label': t('action.branches'), value: `${remoteTarget ? 'remote' : 'local'}:${target}`, disabled: busy, onChange: (event) => {
            const choice = event.target.value;
            const isRemote = choice.startsWith('remote:');
            const branch = choice.slice(isRemote ? 7 : 6);
            setRemoteTarget(isRemote); setTarget(branch);
            if (isRemote) setName(branches.remote.find((row) => row.name === branch)?.branch ?? '');
          } },
            h('optgroup', { label: t('branch.local') }, branches.local.map((row) => h('option', { key: row.name, value: `local:${row.name}`, disabled: row.current }, row.name))),
            h('optgroup', { label: t('branch.remote') }, branches.remote.map((row) => h('option', { key: row.name, value: `remote:${row.name}` }, row.name))),
          )) : null,
          kind === 'create-branch' || (kind === 'switch-branch' && remoteTarget) ? field(t('branch.name'), h('input', { className: 'dsc-filter', 'aria-label': t('branch.name'), value: name, disabled: busy, onChange: (event) => setName(event.target.value) })) : null,
        ),
        confirmUpstream ? h('p', { className: 'dsc-confirmBody', role: 'status' }, `${repository.root}: ${current ?? '—'} → ${remote}/${destination}`) : null,
        busy ? h('p', { className: 'dsc-confirmBody', role: 'status' }, `${t('action.progress')} ${operation}`) : null,
        h('div', { className: 'dsc-confirmActions' },
          h('button', { type: 'button', className: 'dsc-btn dsc-btn-quiet', disabled: busy, onClick: onCancel }, t('action.cancel')),
          h('button', { type: 'button', className: 'dsc-btn', disabled: !valid, onClick: submit }, t(confirmUpstream ? 'remote.upstream' : 'action.confirm')),
        ));
    }

    /** Historical review has no write-control prop or worktree action owner. */
    function CommitReview({ selector, hash, t, onClose }) {
      const [file, setFile] = React.useState(null);
      const details = useLoad((signal) => call('commit-details', { query: { ...selector, hash }, signal }), [selector.repo, selector.sessionId, hash]);
      const diff = useLoad(async (signal) => file === null ? null : { hash, path: file.path, value: await call('commit-diff', { query: { ...selector, hash, path: file.path }, signal }) }, [selector.repo, selector.sessionId, hash, file?.path]);
      const context = h('div', { className: 'dsc-diffHead' },
        h('button', { type: 'button', className: 'dsc-tool', 'aria-label': t('action.back'), onClick: () => file === null ? onClose() : setFile(null) }, h(IconBack, {})),
        h('span', { className: 'dsc-diffPath', title: hash }, file?.path ?? hash),
        h('span', { className: 'dsc-diffSide' }, t('history.readOnly')));
      const retry = (load) => h('div', { className: 'dsc-details' }, h('p', { className: 'dsc-error', role: 'alert' }, load.error.message), h('button', { type: 'button', className: 'dsc-btn dsc-btn-quiet', onClick: load.reload }, t('action.refresh')));
      return h('div', { className: 'dsc-diff' }, context,
        file !== null ? diff.status === 'error' ? retry(diff) : h(DiffView, { t, path: file.path, diff: diff.value?.hash === hash && diff.value?.path === file.path ? diff.value.value : undefined })
          : details.status === 'error' ? retry(details) : details.value?.commit?.hash !== hash ? h('p', { className: 'dsc-status' }, t('state.loading'))
            : h('div', { className: 'dsc-details' },
              h('h3', {}, details.value.commit.subject),
              h('code', {}, details.value.commit.hash),
              h('p', {}, `${details.value.commit.author} · ${details.value.commit.date ?? ''}`),
              h('p', {}, t('history.parents'), ': ', h('code', {}, details.value.commit.parents.join(', ') || '—')),
              h('pre', {}, details.value.commit.message),
              h('h4', {}, t('history.files')),
              details.value.files.map((row) => h('button', { key: row.path, type: 'button', className: 'dsc-row', title: row.oldPath === null ? row.path : `${row.oldPath} → ${row.path}`, onClick: () => setFile(row) },
                h('span', { className: 'dsc-badge' }, row.status), h('span', { className: 'dsc-base' }, row.path))),
              h('p', { className: 'dsc-status' }, t('history.selectFile')),
            ));
    }

    /** One change row: a clickable file area plus its trailing controls. */
    function ChangeRow({ row, badge, onOpen, onPrimary, primaryLabel, primaryIcon, onDiscard, t, selected, busy }) {
      const { dir, base } = splitPath(row.path);
      const statusLetter = badge === 'untracked' ? 'U' : badge.toUpperCase();
      const renamed = row.origPath === null ? null : t('renamed').replace('{path}', row.origPath);
      return h(
        'div',
        { className: `dsc-item${selected ? ' dsc-item-selected' : ''}` },
        h(
          'button',
          {
            type: 'button',
            className: 'dsc-row',
            onClick: () => onOpen(row),
            'aria-pressed': selected === true,
            title: renamed === null ? row.path : `${row.path} — ${renamed}`,
          },
          glyph([h('path', { key: 'file', d: 'M4 1.5h5l3 3V14H4z M9 1.5V5h3' })], { className: 'dsc-fileIcon' }),
          h('span', { className: 'dsc-name', dir: 'ltr' },
            h('span', { className: 'dsc-base' }, base),
            dir === '' ? null : h('span', { className: 'dsc-dir' }, dir.replace(/\/$/, '')),
          ),
          h('span', { className: 'dsc-hidden' }, `${statusLetter} ${renamed ?? ''}`),
        ),
        onPrimary === null || onDiscard === null ? null : h(
          'span',
          { className: 'dsc-rowTools' },
          h(
            'button',
            { type: 'button', className: 'dsc-mini', title: primaryLabel, 'aria-label': primaryLabel, disabled: busy, onClick: () => onPrimary(row) },
            primaryIcon,
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsc-mini dsc-mini-danger',
              title: t('action.discard'),
              'aria-label': t('action.discard'),
              disabled: busy,
              onClick: () => onDiscard(row),
            },
            h(IconDiscard, {}),
          ),
        ),
        h('span', { className: `dsc-badge dsc-badge-${badge}`, 'aria-hidden': 'true' }, statusLetter),
      );
    }

    /** One collapsible group; its open state belongs to the panel, not its title. */
    function Group({ title, rows, children, bulk, collapsed, onToggle }) {
      if (rows.length === 0) return null;
      return h(
        'section',
        { className: 'dsc-group' },
        h(
          'header',
          { className: 'dsc-groupHead' },
          h('button', { type: 'button', className: 'dsc-groupToggle', 'aria-expanded': !collapsed, onClick: onToggle },
            glyph([h('path', { key: 'chevron', d: 'm6 4 4 4-4 4' })], { className: `dsc-chevron${collapsed ? '' : ' dsc-chevron-open'}` }),
            h('span', { className: 'dsc-groupTitle' }, title),
            h('span', { className: 'dsc-groupCount' }, String(rows.length)),
          ),
          bulk == null ? null : h('span', { className: 'dsc-groupActions' }, bulk),
        ),
        collapsed ? null : children,
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

    /** Local branch and explicit second confirmation required before GitHub POST. */
    function GitHubCreateForm({ selector, branchData, github, onClose, onCreated, t }) {
      const [title, setTitle] = React.useState('');
      const [description, setDescription] = React.useState('');
      const [target, setTarget] = React.useState('main');
      const [draft, setDraft] = React.useState(true);
      const [confirm, setConfirm] = React.useState(false);
      const [pending, setPending] = React.useState(false);
      const [error, setError] = React.useState('');
      const lock = React.useRef(false);
      const remote = branchData?.remotes?.find((row) => row.name === 'origin' && row.github?.url === github.url)
        ?? branchData?.remotes?.find((row) => row.github?.url === github.url);
      const source = branchData?.local?.find((row) => row.current);
      const head = source?.upstreamTarget?.remote === remote?.name ? source.upstreamTarget.branch : null;
      const tracked = branchData?.remote?.find((row) => row.remote === remote?.name && row.branch === head);
      const pushed = Boolean(head && tracked?.hash === source?.hash);
      const branches = branchData?.remote?.filter((row) => row.remote === remote?.name).map((row) => row.branch) ?? [];
      const base = branches.includes(target) ? target : branches.includes('main') ? 'main' : branches[0] ?? '';
      const eligible = pushed && base && head !== base && title.trim().length >= 3 && title.length <= 200 && description.length <= 5000;
      const submit = async () => {
        if (!eligible || pending || lock.current) return;
        if (!confirm) { setConfirm(true); return; }
        lock.current = true; setPending(true); setError('');
        try {
          const data = await call('github-create-pull', { query: selector, body: {
            title: title.trim(), description, base, draft, confirmed: true,
          } });
          if (data?.pull?.number) onCreated(data.pull.number);
        } catch (reason) {
          setError(reason.message); setConfirm(false);
        } finally {
          lock.current = false; setPending(false);
        }
      };
      const changed = () => setConfirm(false);
      return h('section', { className: 'dsc-confirm', role: 'dialog', 'aria-label': t('github.create') },
        h('p', { className: 'dsc-confirmTitle' }, t('github.create')),
        h('p', { className: 'dsc-confirmBody' }, t('github.createSource') + ': ' + (head ?? '—') + ' → ' + t('github.createBase') + ': ' + (base || '—')),
        !pushed ? h('p', { className: 'dsc-confirmBody' }, t('github.createHint')) : null,
        h('div', { className: 'dsc-dialogFields' },
          h('label', {}, t('github.createTitle'), h('input', {
            className: 'dsc-input', value: title, disabled: pending,
            onChange: (e) => { setTitle(e.target.value); changed(); },
          })),
          h('label', {}, t('github.createBase'), h('select', {
            className: 'dsc-select', value: base, disabled: pending,
            onChange: (e) => { setTarget(e.target.value); changed(); },
          }, branches.map((name) => h('option', { key: name, value: name }, name)))),
        ),
        h('label', {}, t('github.createBody'), h('textarea', {
          className: 'dsc-input', rows: 3, maxLength: 5000, value: description, disabled: pending,
          onChange: (e) => { setDescription(e.target.value); changed(); },
        })),
        h('label', {}, h('input', { type: 'checkbox', checked: draft, disabled: pending,
          onChange: (e) => { setDraft(e.target.checked); changed(); },
        }), ' ' + t('github.createDraft')),
        confirm ? h('p', { className: 'dsc-confirmBody', role: 'status' }, t('github.createSubmit') + ': ' + head + ' → ' + base) : null,
        error ? h('p', { role: 'alert' }, error) : null,
        h('div', { className: 'dsc-confirmActions' },
          h('button', { type: 'button', className: 'dsc-btn dsc-btn-quiet', disabled: pending, onClick: onClose }, t('github.createCancel')),
          h('button', { type: 'button', className: 'dsc-btn', disabled: !eligible || pending, onClick: submit }, t(confirm ? 'github.createSubmit' : 'github.createConfirm')),
        ),
      );
    }

    /**
     * GitHub PR review and Issues browser.
     * GitHub requests originate on the authenticated DSH Host; the UI sends
     * only a repository selector and an integer PR number. No GitHub writes.
     */
    function GitHubWorkbench({ selector, github, branchData, t }) {
      const [kind, setKind] = React.useState('pulls');
      const [state, setState] = React.useState('open');
      const [selected, setSelected] = React.useState(null);
      const [file, setFile] = React.useState(null);
      const [creating, setCreating] = React.useState(false);
      React.useEffect(() => { setSelected(null); setFile(null); setCreating(false); }, [kind, state, selector.sessionId, selector.repo]);
      const listing = useLoad((signal) => call(kind === 'pulls' ? 'github-pulls' : 'github-issues', {
        query: { ...selector, state }, signal,
      }), [selector.sessionId, selector.repo, kind, state]);
      const detail = useLoad(async (signal) => {
        if (kind !== 'pulls' || selected === null) return null;
        return call('github-pull-detail', { query: { ...selector, number: selected }, signal });
      }, [selector.sessionId, selector.repo, kind, selected]);
      const items = Array.isArray(listing.value?.items) ? listing.value.items : [];
      const review = detail.value?.pull?.number === selected && detail.current ? detail.value : null;
      const patch = review?.files?.find((row) => row.filename === file) ?? review?.files?.[0] ?? null;
      const external = (label, url) => h('a', {
        href: url, target: '_blank', rel: 'noopener noreferrer',
      }, label);
      const tab = (label, value, chosen, set) => h('button', {
        type: 'button', className: 'dsc-btn dsc-btn-quiet',
        'aria-pressed': chosen === value, onClick: () => set(value),
      }, label);
      return h('div', { className: 'dsc-root' },
        h('div', { className: 'dsc-gh-top' },
          tab('Pull Requests', 'pulls', kind, setKind),
          tab('Issues', 'issues', kind, setKind),
          tab(t('github.open'), 'open', state, setState),
          tab(t('github.closed'), 'closed', state, setState),
          h('button', { type: 'button', className: 'dsc-btn dsc-btn-quiet',
            onClick: () => { listing.reload(); if (selected !== null) detail.reload(); },
          }, t('github.refresh')),
          listing.value?.capabilities?.canCreate ? h('button', { type: 'button', className: 'dsc-btn',
            onClick: () => setCreating((value) => !value),
          }, t('github.create')) : null,
          external(t('github.openOnGithub'), kind === 'pulls' ? github.pullsUrl : github.issuesUrl),
        ),
        creating ? h(GitHubCreateForm, { selector, branchData, github, t,
          onClose: () => setCreating(false),
          onCreated: (number) => { setCreating(false); setSelected(number); setKind('pulls'); setState('open'); listing.reload(); },
        }) : null,
        h('div', { className: 'dsc-gh-layout' },
          h('div', { className: 'dsc-gh-list' },
            listing.status === 'error' ? h('p', { className: 'dsc-status', role: 'alert' }, listing.error?.message)
              : !listing.current || listing.status === 'loading' ? h('p', { className: 'dsc-status' }, t('state.loading'))
                : items.length === 0 ? h('p', { className: 'dsc-status' }, t('github.empty')) : null,
            items.map((item) => h('button', {
              key: item.number, type: 'button', className: 'dsc-gh-entry',
              'aria-pressed': selected === item.number,
              onClick: () => { setSelected(item.number); setFile(null); },
            },
            h('strong', {}, '#' + item.number + '  ' + item.title),
            h('small', {}, '@' + item.author + (item.draft ? ' · Draft' : '') + ' · ' + (item.state ?? '')),
            )),
            h('p', { className: 'dsc-gh-meta' }, t('github.firstPage')),
          ),
          h('div', { className: 'dsc-gh-detail' },
            kind === 'issues'
              ? h('div', {},
                h('h3', {}, 'Issues'),
                selected === null ? h('p', {}, t('github.select')) : null,
                items.filter((item) => item.number === selected).map((item) => h('div', { key: item.number },
                  h('h4', {}, item.title),
                  h('p', {}, '#' + item.number + ' · @' + item.author),
                  h('p', {}, (item.labels ?? []).join(', ')),
                  external(t('github.openOnGithub'), github.url + '/issues/' + item.number),
                )))
              : selected === null ? h('p', {}, t('github.select'))
                : detail.status === 'error' ? h('p', { role: 'alert' }, detail.error?.message)
                  : review === null ? h('p', {}, t('state.loading'))
                    : h('div', {},
                      h('h3', {}, '#' + review.pull.number + '  ' + review.pull.title),
                      h('p', { className: 'dsc-gh-meta' }, review.pull.head + ' → ' + review.pull.base + ' · @' + review.pull.author),
                      external(t('github.openOnGithub'), github.url + '/pull/' + review.pull.number),
                      review.pull.body ? h('p', {}, review.pull.body) : null,
                      h('h4', {}, t('github.checks') + ' (' + review.checks.length + ')'),
                      review.checksUnavailable ? h('p', {}, t('github.checksUnavailable')) : null,
                      review.checks.map((check, i) => h('p', { key: i, className: 'dsc-gh-meta' },
                        check.name + ': ' + (check.conclusion || check.status))),
                      h('h4', {}, t('github.files') + ' (' + review.files.length + ')'),
                      review.filesLimited ? h('p', { className: 'dsc-gh-meta' }, t('github.firstPage')) : null,
                      h('div', { className: 'dsc-gh-files' }, review.files.map((entry) => h('button', {
                        key: entry.filename, type: 'button', className: 'dsc-btn dsc-btn-quiet',
                        'aria-pressed': patch?.filename === entry.filename,
                        title: entry.filename, onClick: () => setFile(entry.filename),
                      }, entry.filename + ' (+' + entry.additions + '/-' + entry.deletions + ')'))),
                      patch === null ? null : h('div', {},
                        h('h4', {}, patch.filename),
                        patch.patch
                          ? h('div', { className: 'dsc-gh-patch', role: 'region', 'aria-label': patch.filename },
                            patch.patch.split('\n').map((line, index) => h('div', {
                              key: index,
                              className: 'dsc-gh-patchLine' +
                                (line.startsWith('+') && !line.startsWith('+++') ? ' dsc-gh-add'
                                  : line.startsWith('-') && !line.startsWith('---') ? ' dsc-gh-del'
                                    : line.startsWith('@@') ? ' dsc-gh-hunk' : ''),
                            }, line || ' ')))
                          : h('p', {}, t('github.noPatch')),
                        patch.truncated ? h('p', {}, t('github.truncated')) : null,
                      ),
                    ),
          ),
        ),
      );
    }

    /**
     * The Source Control panel, shared by the sidebar tab and the main page.
     *
     * @param {object} props - `{selector, t, showHistory, historySlot, surface, onChanged}`
     * @returns {object} the element.
     */
    function SourceControlPanel({ selector, t, surface, sizing: mountedSizing, revision = 0 }) {
      const localSizing = useSizing();
      const sizing = mountedSizing ?? localSizing;
      const [graphRevision, setGraphRevision] = React.useState(0);
      const branches = useLoad((signal) => call('branches', { query: selector, signal }), [selector.sessionId, selector.repo]);
      const status = useLoad((signal) => call('status', { query: selector, signal }), [selector.sessionId, selector.repo]);
      const [historic, setHistoric] = React.useState(null);
      const [dialog, setDialog] = React.useState(null);
      const [more, setMore] = React.useState(false);
      const [githubMode, setGithubMode] = React.useState(false);
      const [filter, setFilter] = React.useState('');
      const [treeView, setTreeView] = React.useState(false);
      const mounted = React.useRef(true);
      React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
      React.useEffect(() => { if (revision === 0) return; status.reload(); branches.reload(); setGraphRevision((value) => value + 1); }, [revision]);
      const [selected, setSelected] = React.useState(null);
      const [message, setMessage] = React.useState('');
      const [operation, setOperation] = React.useState(null);
      const writing = React.useRef(false);
      const reviewedHunk = React.useRef(null);
      const busy = operation !== null;
      const [notice, setNotice] = React.useState(null);
      const [pendingDiscard, setPendingDiscard] = React.useState(null);
      const [pendingHunk, setPendingHunk] = React.useState(null);
      const [lastCommit, setLastCommit] = React.useState(null);
      const [collapsed, setCollapsed] = React.useState({});
      const messageId = `dsc-message-${surface ?? 'panel'}`;
      const wide = surface === 'page';

      // Tag a response with the selection AND status revision it was requested
      // for. A previous file's hunks must never become actions on the new file.
      const diffLoad = useLoad(async (signal) => {
        if (selected === null || busy || !status.current) return null;
        const context = { path: selected.row.path, staged: selected.staged, revision: status.value };
        try {
          const value = await call('diff', { query: {
            ...selector, path: selected.row.path, staged: selected.staged, untracked: selected.row.untracked,
          }, signal });
          return { ...context, value };
        } catch (error) {
          return { ...context, error: error.message };
        }
      }, [selector.sessionId, selector.repo, selected?.row.path, selected?.staged, status.value, status.current, busy]);

      React.useEffect(() => { setPendingHunk(null); }, [status.value, status.current, busy]);

      // If a write removes this row from its group, close the obsolete diff.
      React.useEffect(() => {
        if (selected === null || status.value === undefined) return;
        const tree = status.value.status;
        const rows = selected.staged ? tree.staged : [...tree.changes, ...tree.untracked, ...tree.conflicted];
        if (!rows.some((row) => row.path === selected.row.path)) setSelected(null);
      }, [status.value, selected]);

      const run = React.useCallback(async (action, body) => {
        if (writing.current) return null;
        writing.current = true;
        reviewedHunk.current = null;
        setOperation(action);
        setNotice(null);
        setPendingHunk(null);
        try {
          const result = await call(action, { query: selector, body });
          return mounted.current ? result : null;
        } catch (error) {
          setNotice({ kind: 'error', text: error.message });
          return null;
        } finally {
          // A refused/failed write can also invalidate what was reviewed. Only
          // a fresh status followed by its matching diff re-enables hunk actions.
          if (mounted.current) {
            status.reload();
            branches.reload();
            setGraphRevision((value) => value + 1);
            setOperation(null);
            setPendingDiscard(null);
            setPendingHunk(null);
          }
          writing.current = false;
        }
      }, [selector.sessionId, selector.repo, status.value, status.reload, branches.reload]);

      const commit = async () => {
        if (busy || writing.current || message.trim() === '' || (status.value?.status.staged.length ?? 0) === 0) return;
        const result = await run('commit', { ...selector, message });
        if (result !== null) {
          setMessage('');
          setLastCommit(result);
        }
      };
      const openDiff = (row, staged) => {
        reviewedHunk.current = null;
        setHistoric(null);
        setSelected({ row, staged });
        setNotice(null);
        // A confirmation belongs to the file that opened it, not the next row.
        setPendingDiscard(null);
        setPendingHunk(null);
      };

      if (status.status === 'error') {
        const code = status.error?.code;
        const text = code === 'session/no-workspace' ? t('state.noWorkspace')
          : code === 'repo/not-a-repository' ? t('state.noRepo')
          : code === 'git/unavailable' ? t('state.gitUnavailable')
          : `${t('state.error')}: ${status.error.message}`;
        return h('div', { className: 'dsc-root' },
          h('p', { className: 'dsc-status' }, text),
          h('div', { className: 'dsc-compose' }, h('button', {
            type: 'button', className: 'dsc-btn dsc-btn-quiet', onClick: status.reload,
          }, t('action.refresh'))),
        );
      }
      if (status.value === undefined) {
        return h('div', { className: 'dsc-root' }, h('p', { className: 'dsc-status' }, t('state.loading')));
      }

      const { repository, status: tree } = status.value;
      const stagedRows = tree.staged;
      const changeRows = [...tree.changes, ...tree.untracked];
      const conflictRows = tree.conflicted;
      const clean = stagedRows.length + changeRows.length + conflictRows.length === 0;
      const loaded = diffLoad.value;
      const matches = selected !== null && !busy && status.current && loaded?.path === selected.row.path
        && loaded?.staged === selected.staged && loaded?.revision === status.value;
      const diff = matches && Array.isArray(loaded.value?.hunks) ? loaded.value : undefined;
      reviewedHunk.current = diff === undefined ? null : { revision: status.value, path: selected.row.path, staged: selected.staged };
      const filtered = (rows) => rows.filter((row) => `${row.path}\n${row.origPath ?? ''}`.toLowerCase().includes(filter.toLowerCase()));
      const branchData = Array.isArray(branches.value?.local) && Array.isArray(branches.value?.remote) && Array.isArray(branches.value?.remotes) ? branches.value : null;
      const openAction = (kind) => {
        if (writing.current) return;
        setMore(false);
        setPendingDiscard(null); setPendingHunk(null);
        if (branchData === null || !branches.current || branches.status !== 'ready') { setNotice({ kind: 'error', text: branches.error?.message ?? t('branch.unavailable') }); return; }
        if (['pull', 'push'].includes(kind) && (!status.current || repository.branch !== branchData.current
          || repository.branch !== (branchData.local.find((branch) => branch.current)?.name ?? null))) {
          setNotice({ kind: 'error', text: t('remote.sourceChanged') }); return;
        }
        const current_local = branchData.local.find((branch) => branch.current);
        setDialog({ kind, source: {
          branch: repository.branch,
          upstream: current_local?.upstream ?? null,
          // The canonical structured target, captured with the rest of the
          // opening context. The display name is abbreviated and non-null even
          // when the tracking ref is missing, so it cannot decide a destination.
          upstreamTarget: current_local?.upstreamTarget ?? null,
        } });
      };
      const refresh = () => {
        if (writing.current) return;
        reviewedHunk.current = null;
        setPendingHunk(null); status.reload(); branches.reload(); setGraphRevision((value) => value + 1);
      };
      // `inert` marks a group whose rows the command layer genuinely cannot act
      // on (an unmerged path is stage/unstage/discard-immune today). Drawing a
      // control that silently does nothing is worse than drawing none.
      const renderRow = (id, staged, inert = false) => (row) => h(ChangeRow, {
        key: `${id}-${row.path}`, row, t, busy,
        badge: rowKind(row, staged ? 'index' : 'worktree'),
        selected: selected?.row.path === row.path && selected?.staged === staged,
        onOpen: () => openDiff(row, staged),
        onPrimary: inert ? null : () => run(staged ? 'unstage' : 'stage', { ...selector, paths: [row.path] }),
        primaryLabel: t(staged ? 'action.unstage' : 'action.stage'),
        primaryIcon: h(staged ? IconUnstage : IconStage, {}),
        onDiscard: inert ? null : () => { if (writing.current) return; setPendingHunk(null); setPendingDiscard({ row, untracked: row.untracked === true }); },
      });
      const group = (id, rows, staged, inert = false) => h(Group, {
        key: id, title: t(`section.${id}`), rows,
        collapsed: collapsed[id] === true,
        onToggle: () => setCollapsed((current) => ({ ...current, [id]: !current[id] })),
        bulk: id === 'conflicts' ? null : h('button', {
          type: 'button', className: 'dsc-mini', disabled: busy,
          title: t(staged ? 'action.unstageAll' : 'action.stageAll'),
          'aria-label': t(staged ? 'action.unstageAll' : 'action.stageAll'),
          onClick: () => run(staged ? 'unstage' : 'stage', { ...selector, paths: rows.map((row) => row.path) }),
        }, h(staged ? IconUnstage : IconStage, {})),
      }, treeView ? h(FileTree, { key: id, rows, renderRow: renderRow(id, staged, inert), t }) : rows.map(renderRow(id, staged, inert)));

      const compose = h('div', { className: 'dsc-compose dsc-commitBox' },
        h('label', { className: 'dsc-hidden', htmlFor: messageId }, t('commit.placeholder')),
        h('textarea', {
          id: messageId, className: 'dsc-input', rows: 1, placeholder: t('commit.placeholder'), value: message, disabled: busy,
          onChange: (event) => setMessage(event.target.value),
          onKeyDown: (event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); commit(); }
          },
        }),
        h('button', {
          type: 'button', className: 'dsc-btn', title: t('commit.hint'),
          disabled: busy || message.trim() === '' || stagedRows.length === 0, onClick: commit,
        }, h(IconCommit, {}), operation === 'commit' ? t('action.committing') : t('action.commit')),
        lastCommit === null ? null : h('span', { className: 'dsc-commitHint', role: 'status' }, t('commit.summary').replace('{short}', lastCommit.short)),
      );

      const list = h('div', { className: 'dsc-body' },
        clean ? h('p', { className: 'dsc-status' }, t('state.clean')) : null,
        !clean && filtered([...conflictRows, ...stagedRows, ...changeRows]).length === 0 ? h('p', { className: 'dsc-status' }, t('files.noMatches')) : null,
        group('conflicts', filtered(conflictRows), false, true), group('staged', filtered(stagedRows), true), group('changes', filtered(changeRows), false),
      );
      const editor = historic !== null ? h(CommitReview, { key: historic, selector, hash: historic, t, onClose: () => setHistoric(null) }) : selected === null
        ? h('div', { className: 'dsc-editorEmpty' }, h(IconSourceControl, {}), h('p', {}, t('diff.select')))
        : h('div', { className: 'dsc-diff' },
          h('div', { className: 'dsc-diffHead' },
            h('button', { type: 'button', className: 'dsc-tool',
              title: t(wide ? 'action.closeDiff' : 'action.back'), 'aria-label': t(wide ? 'action.closeDiff' : 'action.back'),
              onClick: () => { setSelected(null); setPendingHunk(null); },
            }, h(IconBack, {})),
            h('span', { className: 'dsc-diffPath', title: selected.row.path }, selected.row.path),
            h('span', { className: 'dsc-diffSide' }, t(selected.staged ? 'diff.index' : 'diff.worktree')),
            diff === undefined ? null : h('span', { className: 'dsc-stat' },
              h('span', { className: 'dsc-statAdd' }, `+${diff.added}`), ' ', h('span', { className: 'dsc-statDel' }, `−${diff.removed}`)),
            h('button', { type: 'button', className: 'dsc-tool', disabled: busy,
              title: t(selected.staged ? 'action.unstage' : 'action.stage'),
              'aria-label': t(selected.staged ? 'action.unstage' : 'action.stage'),
              onClick: () => run(selected.staged ? 'unstage' : 'stage', { ...selector, paths: [selected.row.path] }),
            }, h(selected.staged ? IconUnstage : IconStage, {})),
          ),
          matches && loaded.error !== undefined ? h('p', { className: 'dsc-status' }, loaded.error)
            : h(DiffView, {
              diff, path: selected.row.path, t, side: selected.staged ? 'index' : 'worktree', busy,
              // Untracked diffs are synthetic; whole-file staging is available,
              // but git apply cannot address a hunk of a file absent from index.
              onHunk: selected.row.untracked || selected.row.unmerged ? undefined : (hunkIndex, action) => {
                if (writing.current || reviewedHunk.current?.revision !== status.value || reviewedHunk.current?.path !== selected.row.path || reviewedHunk.current?.staged !== selected.staged) return;
                if (action === 'discard') { setPendingDiscard(null); setPendingHunk({ row: selected.row, hunkIndex, revision: status.value }); }
                else run(`${action}-hunk`, { ...selector, path: selected.row.path, hunkIndex });
              },
            }),
        );

      // Dialogs are outside the scrollable columns and remain visible when a
      // row/hunk near the bottom opens one. Destructive writes still ask first.
      const confirmation = (pendingHunk !== null && pendingHunk.revision === status.value && status.current && !busy) || pendingDiscard !== null
        ? h('div', { className: 'dsc-confirm', role: 'alertdialog',
          'aria-label': t(pendingHunk !== null ? 'confirm.discardHunkTitle' : 'confirm.discardTitle'),
        },
          h('p', { className: 'dsc-confirmTitle' }, t(pendingHunk !== null ? 'confirm.discardHunkTitle' : 'confirm.discardTitle')),
          h('p', { className: 'dsc-confirmBody' }, pendingHunk !== null
            ? t('confirm.discardHunkBody').replace('{path}', pendingHunk.row.path).replace('{n}', String(pendingHunk.hunkIndex + 1))
            : t(pendingDiscard.untracked ? 'confirm.discardUntracked' : 'confirm.discardBody').replace('{path}', pendingDiscard.row.path)),
          h('div', { className: 'dsc-confirmActions' },
            h('button', { type: 'button', className: 'dsc-btn dsc-btn-quiet', disabled: busy,
              onClick: () => { setPendingDiscard(null); setPendingHunk(null); },
            }, t('action.cancel')),
            h('button', { type: 'button', className: 'dsc-btn dsc-btn-danger', disabled: busy, autoFocus: true,
              onClick: () => {
                if (writing.current) return;
                if (pendingHunk !== null) {
                  if (reviewedHunk.current?.revision !== pendingHunk.revision || reviewedHunk.current?.path !== pendingHunk.row.path) return;
                  run('discard-hunk', { ...selector, path: pendingHunk.row.path, hunkIndex: pendingHunk.hunkIndex });
                } else run('discard', { ...selector, paths: [pendingDiscard.row.path] });
              },
            }, t('action.confirmDiscard')),
          ),
        ) : null;

      // Prefer origin when several remotes point at GitHub. URLs come from
      // the Host's strict parser; the browser never receives token-bearing raw
      // Git remotes and only renders explicit navigation (no API requests).
      const github = branchData?.remotes.find((row) => row.name === 'origin' && row.github)?.github
        ?? branchData?.remotes.find((row) => row.github)?.github ?? null;
      const githubLinks = github === null ? [] : [
        ['github.repository', github.url],
        ['github.pulls', github.pullsUrl],
        ['github.issues', github.issuesUrl],
      ];
      if (githubMode && github !== null) {
        return h('div', { className: 'dsc-root' },
          h('div', { className: 'dsc-gh-top' },
            h('button', { type: 'button', className: 'dsc-btn dsc-btn-quiet',
              onClick: () => setGithubMode(false),
            }, t('github.local')),
            h('strong', {}, t('github.review')),
            h('span', { className: 'dsc-spacer' }),
            h('span', { className: 'dsc-gh-meta' }, repository.root),
          ),
          h(GitHubWorkbench, { selector, github, branchData, t }),
        );
      }
      const historyOpen = sizing.height > 0;
      const navigator = h('div', { className: 'dsc-navigator' },
        h('header', { className: 'dsc-header' }, h(IconSourceControl, {}),
          h('button', { type: 'button', className: 'dsc-branch dsc-branchButton', title: repository.branch ?? repository.head ?? '', 'aria-label': t('action.branches'), disabled: busy, onClick: () => openAction('switch-branch') }, repository.branch ?? repository.head?.slice(0, 8) ?? '—'),
          tree.ahead > 0 ? h('span', { className: 'dsc-track' }, t('ahead').replace('{n}', String(tree.ahead))) : null,
          tree.behind > 0 ? h('span', { className: 'dsc-track' }, t('behind').replace('{n}', String(tree.behind))) : null,
          h('span', { className: 'dsc-spacer' }),
          github === null ? null : h('button', { type: 'button', className: 'dsc-btn dsc-btn-quiet', title: t('github.review'),
            onClick: () => { setMore(false); setGithubMode(true); },
          }, 'GitHub'),
          h('button', { type: 'button', className: 'dsc-tool', title: t('action.more'), 'aria-label': t('action.more'), 'aria-expanded': more, disabled: busy, onClick: () => { if (!writing.current) setMore((value) => !value); } }, glyph([h('circle', { key: 'a', cx: 3, cy: 8, r: 1 }), h('circle', { key: 'b', cx: 8, cy: 8, r: 1 }), h('circle', { key: 'c', cx: 13, cy: 8, r: 1 })], {})),
          h('button', { type: 'button', className: 'dsc-tool', title: t('action.refresh'), 'aria-label': t('action.refresh'), disabled: busy, onClick: refresh }, h(IconRefresh, {})),
        ),
        more ? h('div', { className: 'dsc-menu' },
          ['create-branch', 'fetch', 'pull', 'push'].map((kind) => h('button', { key: kind, type: 'button', className: 'dsc-btn dsc-btn-quiet', disabled: busy, onClick: () => openAction(kind) }, t(kind === 'create-branch' ? 'action.createBranch' : `action.${kind}`))),
          githubLinks.map(([label, url]) => h('a', { key: label, className: 'dsc-btn dsc-btn-quiet', href: url, target: '_blank', rel: 'noopener noreferrer' }, t(label))),
        ) : null,
        compose,
        h('div', { className: 'dsc-fileControls' },
          h('input', { className: 'dsc-filter', type: 'search', 'aria-label': t('files.filter'), placeholder: t('files.filter'), value: filter, onChange: (event) => setFilter(event.target.value) }),
          h('button', { type: 'button', className: 'dsc-tool', 'aria-label': t(treeView ? 'files.list' : 'files.tree'), title: t(treeView ? 'files.list' : 'files.tree'), onClick: () => setTreeView((value) => !value) }, glyph([h('path', { key: 'a', d: treeView ? 'M3 4h10M3 8h10M3 12h10' : 'M3 3v9h3M3 6h3M7 5h6M7 11h6' })], {})),
        ),
        h('div', { className: 'dsc-split', style: { '--dsc-history-height': `${sizing.height}%` } },
          wide || (selected === null && historic === null) ? list : editor,
          h(ResizeHandle, { key: 'height', axis: 'height', value: sizing.height, onChange: sizing.setHeight, t }),
          h('section', { className: `dsc-historySection${historyOpen ? ' dsc-historySection-open' : ''}` },
            h('button', { type: 'button', className: 'dsc-historyToggle', 'aria-expanded': historyOpen, onClick: () => sizing.setHeight(historyOpen ? 0 : 40) },
              glyph([h('path', { key: 'chevron', d: 'm6 4 4 4-4 4' })], { className: `dsc-chevron${historyOpen ? ' dsc-chevron-open' : ''}` }), t('history.title')),
            historyOpen ? h(History, { key: graphRevision, selector, t, busy, onSelect: (hash) => { reviewedHunk.current = null; setSelected(null); setPendingHunk(null); setPendingDiscard(null); setHistoric(hash); } }) : null,
          ),
        ),
      );
      return h('div', { className: 'dsc-root' },
        wide ? h('div', { className: 'dsc-workbench', style: { '--dsc-nav-width': `${sizing.width}%` } }, navigator, h(ResizeHandle, { key: 'width', axis: 'width', value: sizing.width, onChange: sizing.setWidth, t }), h('div', { className: 'dsc-editor' }, editor)) : navigator,
        notice === null ? null : h('p', { className: 'dsc-error', role: 'alert' }, notice.text),
        busy && dialog === null ? h('p', { className: 'dsc-status', role: 'status' }, `${t('action.progress')} ${operation}`) : null,
        confirmation,
        dialog !== null && branchData !== null ? h(GitDialog, { key: dialog.kind, kind: dialog.kind, openingSource: dialog.source, branches: branchData, repository, clean: clean && status.current, busy: busy || !branches.current || !status.current, operation, t, onCancel: () => setDialog(null), onRun: (kind, body) => run(kind, { ...selector, ...body }) }) : null,
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
    function History({ selector, t, onSelect, busy }) {
      const [pages, setPages] = React.useState({ skip: 0, commits: [] });
      const load = useLoad(async (signal) => {
        const value = await call('graph', { query: { ...selector, skip: pages.skip }, signal });
        if (!Array.isArray(value?.commits) || value.commits.some((commit) => !Array.isArray(commit.parents) || !Array.isArray(commit.refs))) throw new Error(t('state.error'));
        return { ...value, skip: pages.skip };
      }, [selector.sessionId, selector.repo, pages.skip]);
      React.useEffect(() => {
        const loaded = load.value;
        if (loaded === undefined || loaded.skip !== pages.skip) return;
        setPages((current) => {
          const seen = new Set(current.commits.map((commit) => commit.hash));
          return { skip: current.skip, commits: current.skip === 0 ? loaded.commits : [...current.commits, ...loaded.commits.filter((commit) => !seen.has(commit.hash))] };
        });
      }, [load.value]);
      const commits = pages.commits;
      const known = new Set(commits.map((commit) => commit.hash));
      let lanes = [];
      const rows = commits.map((commit) => {
        const incoming = lanes.includes(commit.hash);
        if (!incoming) lanes.push(commit.hash);
        const before = [...lanes];
        const column = before.indexOf(commit.hash);
        const after = before.filter((hash) => hash !== commit.hash);
        // Carry only real parent object IDs. A second tip never gets a made-up
        // edge to its neighbour; missing ancestry is explicitly dashed.
        commit.parents.forEach((parent, index) => {
          if (!after.includes(parent)) after.splice(Math.min(column + index, after.length), 0, parent);
        });
        lanes = after;
        const width = Math.max(1, before.length, after.length) * 14 + 6;
        const x = (lane) => lane * 14 + 8;
        const edges = [];
        before.forEach((hash, index) => {
          if (hash === commit.hash) {
            if (incoming) edges.push(h('path', { key: `in:${hash}`, d: `M${x(index)} 0V14` }));
          } else {
            const next = after.indexOf(hash);
            edges.push(h('path', { key: `carry:${hash}`, d: `M${x(index)} 0C${x(index)} 14 ${x(next)} 14 ${x(next)} 28`, strokeDasharray: known.has(hash) ? undefined : '3 2' }));
          }
        });
        commit.parents.forEach((parent) => edges.push(h('path', { key: parent, 'data-parent-hash': parent, d: `M${x(column)} 14C${x(column)} 21 ${x(after.indexOf(parent))} 21 ${x(after.indexOf(parent))} 28`, strokeDasharray: known.has(parent) ? undefined : '3 2' }, !known.has(parent) ? h('title', {}, `${t('history.boundary')}: ${parent}`) : null)));
        return h('li', { key: commit.hash, className: 'dsc-commit', title: [commit.subject, commit.hash, commit.author, String(commit.date ?? '').slice(0, 10)].filter(Boolean).join(' · ') },
          h('svg', { className: 'dsc-graph', width, height: 28, viewBox: `0 0 ${width} 28`, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, 'aria-label': `${commit.short}: ${t('history.parents')} ${commit.parents.join(', ') || '—'}`, role: 'img', style: { maxWidth: '40%' } }, edges, h('circle', { cx: x(column), cy: 14, r: 3, fill: 'var(--dsw-alias-bg-layer-1)' })),
          h('button', { type: 'button', className: 'dsc-commitButton', 'data-commit-hash': commit.hash, disabled: busy, onClick: () => { if (!busy) onSelect(commit.hash); } },
            h('span', { className: 'dsc-commitSubject' }, commit.subject),
            commit.refs.map((ref) => h('span', { key: `${ref.kind}:${ref.name}`, className: 'dsc-ref', 'data-ref-kind': ref.kind, title: `${ref.kind}: ${ref.name}` }, ref.name)),
            h('span', { className: 'dsc-commitMeta' }, commit.short, h('span', { className: 'dsc-hidden' }, [commit.author, String(commit.date ?? '').slice(0, 10)].filter(Boolean).map((part) => ` · ${part}`).join('')))),
        );
      });
      const ready = load.current && load.value?.skip === pages.skip;
      return h('div', { className: 'dsc-root' },
        load.status === 'error' ? h('div', { className: 'dsc-compose' }, h('p', { className: 'dsc-error', role: 'alert' }, load.error.message), h('button', { type: 'button', className: 'dsc-btn dsc-btn-quiet', onClick: load.reload }, t('action.refresh'))) : null,
        commits.length === 0 ? h('p', { className: 'dsc-status' }, ready ? t('history.empty') : t('state.loading')) : h('ul', { className: 'dsc-history' }, rows),
        load.value?.hasMore === true ? h('div', { className: 'dsc-compose' }, h('button', { type: 'button', className: 'dsc-btn dsc-btn-quiet', disabled: !ready || busy, onClick: () => { if (ready && !busy) setPages((current) => ({ skip: current.commits.length, commits: current.commits })); } }, t('action.loadMore'))) : null,
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
      return h(SourceControlPanel, { key: sessionId, selector, t, revision, surface: 'tab' });
    }

    /** The main page: repository picker and a list/diff workbench with history. */
    function SourceControlPage(props) {
      const { t } = props;
      const catalog = useLoad((signal) => call('git', { signal }), []);
      const [chosen, setChosen] = React.useState(null);
      // One counter shared by the panel and the history column: a write in either
      // invalidates the other, so a new commit shows up without a manual refresh.
      const sizing = useSizing();
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
        h(SourceControlPanel, {
          key: active.root, selector, t, surface: 'page', sizing,
        }),
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
