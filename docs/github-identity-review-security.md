# GitHub 身份隔离与 Review 写入：安全设计门槛

本文件记录第四阶段的决策：**在缺乏可靠的每用户 DSH Web 身份时，不启用 PR 评论/Review 写操作**。

## 现有信任边界

- `githubAuth.repositories` 与 `DSH_SOURCE_CONTROL_GITHUB_TOKEN` 是 DSH **宿主级**配置与凭据。
- 白名单是 GitHub *仓库*级别，并不是 DSH 登录用户的授权映射。
- 即使 DSH 的 `/api` 请求已通过会话认证，也不能据此断言其调用者拥有与 Host Token 相同的 GitHub 身份。
- 第三阶段的“创建 PR”是有显式开关与确认的宿主级写功能；多用户部署必须将其关闭，直至建立用户隔离。
- 第四阶段提供公开/已允许私有仓库的 **只读** issue comments、PR Reviews 与行内讨论。UI 显示宿主共享凭据提示，不冒充 GitHub 登录状态。

## 真正支持多人 Review 写入前必须满足的条件

1. **可信登录主体**：由 DSH Host 已认证请求上下文提供稳定 user ID；不可取自可伪造的 `sessionId`、Query、Request Body、浏览器传来的自定义用户头或 Git 作者邮箱。
2. **授权协议**：GitHub OAuth App / GitHub App OAuth，使用回调地址严格验证、短生命周期随机 state、适用时 PKCE、明确授权仓库与权限。不得在 URL Query 中放 Access Token。
3. **凭据隔离**：Token 在宿主侧加密并按认证的 DSH user ID 独立存取，不落到 client bundle、日志、Agent 工具结果或全局插件配置。
4. **每请求鉴权**：读取或写入前再次绑定 DSH 用户、GitHub 授权主体与仓库权限；避免 Host 公共 Token 和用户私有 Token 的静默回退。
5. **最小写权限**：新建 Issue 评论、PR Review 评论、Approve、Request changes 使用分别授权的 GitHub API 调用，并有二次确认和明确的提交结果。Review 评论关联有效的 `pull_number`、`commit_id`、`path`、`line`，避免写到错误的差异版本。
6. **安全退出**：撤销账号连接应销毁宿主令牌；账户切换与仓库切换应中止旧请求和丢弃暂存草稿；审计日志仅记录非敏感操作元数据。
7. **测试门槛**：跨用户越权读取/写入、撤销后的访问拒绝、CSRF、redirect/state 验证、并发切换、404/403/429、无效分支与提交差异、重放提交的完整测试。

> 设计记录不等于已经实现 OAuth。只有确认 DSH Host 当前可提供上述可信主体与秘密存储能力后，才能开始实现真实的多用户账号绑定/审核提交。

## 本阶段已实现

- 按需调用三个固定 GitHub REST GET 接口，最多各 30 条：普通 Issue 评论、PR Review 决定、代码行内评论。
- GitHub Host 严格限制目标为当前已批准 Git remote 所对应的官方 API，限制响应大小，筛出有限的审查字段，按时间排序。
- 审查面板展示审批状态、评论内容、文件路径和行号，明确只读；不在打开 PR 时自动发起三个网络请求。
- 与现有 Node / DSH CI 共同测试；没有添加 OAuth、额外全局 token、评论或 Review POST 路由。
