# beta.4 定制同步实施与部署检查表

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 对照上游 v3.5.0-beta.4 逐项吸收可兼容改动，保留定制功能，准备可以审核、推送 beta 并部署到 175.178.69.4:3065 的候选版本。

**Architecture:** 以本仓库 beta 的 45e350be 为基线，在现有隔离工作区适配。沿用 docs/upstream-sync.md 的选择性同步约定，不以整体覆盖或虚假 merge ancestry 代替审查；保护仍在使用的原生插件及定制路由接口。发布版本与逐条更新日志确认后，才创建发布提交、推送和部署。

**Tech Stack:** Rust / Axum / SQLite、React / TypeScript / Vite、Node 本地 HTTP 与 Playwright 验收、GitHub Actions 双架构 GHCR 镜像、Docker。

**Spec:** docs/upstream-sync.md；AGENTS.md；用户本次指定的 v3.5.0-beta.4、GitHub 和目标站。

## Global Constraints

- 上游发布边界固定为 v3.5.0-beta.4（a781711ac88282405aa2819a204922a6a763f2b6），不是会继续移动的 upstream/beta。
- 集成只落 beta；沿用此前不推 main、不打 tag 的要求。
- 保留路由组、大小写、账号/Key 选择与权限、倍率、代理订阅和本仓库 Docker 构建。
- 测试只使用临时库和本地模拟上游；不得用生产数据试迁移。
- 版本及更新说明须遵循 release-flow 的人工确认，先把代码、证据和部署方案准备齐。
- 部署只针对 175.178.69.4:3065，保留 /opt/agent2api/data 和旧镜像的回退能力。

## Review Focus

- 模型测试和三种上游协议必须发送目录登记的精确模型 ID，同时保留对外路由名。
- HTTP 非安全上下文缺少 randomUUID 时，桌面和手机端生成 ID、创建客户端配置及助手对话仍可用。
- WorkBuddy 嵌套/扁平凭据及 realm / region / edition 的地区识别，不覆盖明确的导出 provider。
- Responses 工具参数早于名称、别名 ID、取消/失败/截断与旧 EOF、usage 兼容必须同时成立。
- 代理订阅完整运行期回归的锁冲突必须在同一基线核对；不得把旧二进制 404 当等价结果。

---

### Task 1: 固定来源与基线

- [x] 重新 fetch origin 和 upstream，记录标签与远端提交、现有候选和服务器镜像。
- [x] 阅读 release-flow 与 upstream-sync，复用现有隔离工作区，保护未发布 Responses 补丁。
- [x] 编译 45e350be 的精确基线，复核带实际 Mihomo 的完整代理订阅回归。

### Task 2: 适配可独立验证的上游修复

**Files:** core/providers/custom/forward.rs；core/custom_providers.rs；ui-shared/ids.ts；ui-shared/workbuddy-credentials.ts；桌面/手机对应调用方；scripts/test-beta4-compatibility.mjs；ui-shared/* 对应行为测试。

- [x] 编写模型大小写、HTTP ID 和凭据地区行为测试；精确 HTTP 基线 7 失败、13 通过，共用前端最终 45/45。
- [x] 从上游 859b00f3 适配模型精确改写和 240 分钟默认，从 4f08f899 适配 HTTP ID，从 3df34334 适配凭据地区，从 8e83ecb5 适配 SOLO 余额；记录原作者 Lucas。
- [x] 验证三协议、组内模型及管理测试的精确 ID 和客户端回显；新增 HTTP 20/20，渠道/Key 分组与权限验收通过。
- [x] Responses 专项 20/20，包含评审问题的 RED→GREEN；完整候选 Rust 431/431。

### Task 3: 保护定制回归与审查

- [x] Rust 431/431、完整服务端构建、三协议 18/18、Grok schema 18/18、渠道/Key 权限、路由引擎 11/11、选路 22/22、旧数据升级及浏览器流程通过。
- [x] 精确基线和最终候选的完整代理订阅均包含实际 Mihomo，通过组选择、重启恢复、暂停/删除后禁止直连、密码更新和取消测速。
- [x] 从源码重建桌面/手机、翻译及缓存产物，类型、翻译扫描和完整翻译构建通过。
- [x] 逐项核对 beta.2 → beta.4 的 11 个提交及采纳/不适用/暂缓范围；独立源码审查通过并修正工具身份问题。最终运行期验收仍单列。

### Task 4: 发布和部署

- [x] 准备逐条更新日志、建议定制版本 3.4.3-beta.1 与未纳入范围，草稿位于 docs/release-notes/3.4.3-beta.1.md；代码验收和目标站只读预检完成。
- [ ] 用户审核确认版本与逐条日志；未经确认不创建发布提交。
- [ ] 确认后六处版本和锁文件一致；提交保留上游作者来源并只推 origin/beta。
- [ ] 等待本仓库 Docker package 成功，核对 amd64/arm64 及 revision，固定镜像摘要。
- [ ] 留存容器配置和升级前一致性备份，以现有挂载更新目标容器，验证健康、UI、模型与真实请求；失败自动回退。
