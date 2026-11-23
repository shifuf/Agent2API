# 上游 3.5.1 兼容同步与粘滞故障切换实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking. 本次直接执行已授权的开发与验证；用户已审核本批日志并确认更新、推送，版本名按用户要求跟随上游。

**Goal:** 保留定制功能，同步经兼容验证的上游改进，并实现粘滞渠道两次失败后冻结切换。

**Architecture:** 路由故障状态与粘滞表共享进程生命周期；选路统一过滤冻结成员，响应完整结束后才清零。上游补丁分别适配现有数据库、静态文件和请求统计接口，不导入不匹配的运行时或生成资源。

**Tech Stack:** Rust、Axum、SQLite/rusqlite、Node HTTP 验收、TypeScript/Vite。

**Spec:** `docs/superpowers/specs/2026-11-24-upstream-sticky-design.md`

## Global Constraints

- 基线 `9197ba2c704e7731d602411e8ae86d188057fee7`；来源 `33f5e797836ac91d958022e9f4ca53c30d0432ec`。
- 失败阈值两次；冻结复用 `routingBreakerTimeoutSeconds`，默认 60 秒、范围 10～600 秒。
- 保留 Key/模型/账号范围、大小写、密钥权限、倍率、代理订阅、本仓库 Docker 和禁用上游自更新配置。
- 使用临时数据库和模拟上游；无新依赖、无 schema 变更。本批已确认产品版本 `3.5.1`、推送 `origin/beta` 并更新 `175.178.69.4:3065`。

## Review Focus

- 同一成员多账号及嵌套层级：冻结后不能通过另一个 Key 或父级绑定重新选择。
- 在途成功迟到：冻结后不能提前解冻或重新绑定失败渠道。
- HTTP 200 后流内错误、缺失收尾和客户端取消：准确区分渠道故障与客户端生命周期。
- 全部冻结及受限 Key：正常拒绝且不能逃到默认账号、未授权渠道或直连代理。
- 缓存的新值、删除、外部写入和并发刷新：下拉列表不能长期残留旧值或漏掉新值。

### Task 0: 用户提供的真实订阅故障

**Files:** `core/sub_kernel/runtime.rs`、`runtime_groups.rs`、`runtime_dns.rs`、`scripts/test-proxy-subscriptions.mjs`。

**Root cause:** 下载与 Mihomo 协议支持正常；组引用了被过滤的信息节点，导致组内联失败；两种额外通知模板仍被当成节点。只过滤实际声明的信息节点引用，缺失的真实依赖仍失败，不允许直连回退。服务器系统 DNS 无法满足 ECH 的 HTTPS 记录查询；恢复订阅的直连 DNS 引导后，12 条线路和实际转发均通过。

- [x] 用匿名本地 YAML 和实际 Mihomo 重现组不可用；组应保留两条真实线路及其顺序，信息节点不能被选择。
- [x] 同时正规化节点、组定义和管理视图，保留真实依赖的失败关闭语义。
- [x] 用仅存在于本地测试 DNS 的代理主机名重现 DNS 丢失；保留订阅的直连引导解析器，不导入外部监听、fake-IP 和源路由策略。
- [x] 运行完整订阅回归、真实链接及目标服务器内的连通测试；真实订阅、节点密钥只存私有临时目录。

### Task 1: 上游独立修复及缓存

**Files:**
- Modify: `desktop-tauri/src-tauri/server/src/server/db/mod.rs`
- Modify: `desktop-tauri/src-tauri/server/src/server/static_files.rs`
- Create: `desktop-tauri/src-tauri/server/src/server/static_files/cache.rs`（如缓存解析需要独立模块）
- Modify/Create: `desktop-tauri/src-tauri/server/src/server/request_stats.rs`、`request_stats/filters_cache.rs`、`request_stats/maintenance.rs`、`request_stats/tests.rs`

**Interfaces:** 保持 `Db::with/with_mut`、`static_files::serve` 和 `RequestStats::filter_options` 的现有签名。缓存的本地变更必须在写入、删除和裁剪完成后失效；外部改库按 `PRAGMA data_version` 定期检查。

- [x] 在现有模块添加行为回归：同库嵌套调用及时失败，另一库嵌套可用；HTML/sw 条件请求始终取新正文，普通资源仍可 304，本地资源带更新指纹；筛选缓存命中免去查询，新模型和来源、清理/裁剪及外部改库会刷新。
- [x] 编译并运行失败用例，保存日志；使用实际调用与临时文件/库，不能用源码文本断言替代运行。
- [x] 适配独立上游补丁，保留现有 Web shim 与统计、权限契约。记录来源和改动边界。
- [x] 运行完整 Rust 测试并确认行为回归通过。候选代码保持未提交。

### Task 2: 渠道故障状态与选路

**Files:**
- Modify: `desktop-tauri/src-tauri/server/src/server/core/upstream/route_sticky.rs`、`route_state.rs`、`route_affinity.rs`、`rotate.rs`
- Create: `desktop-tauri/src-tauri/server/src/server/core/upstream/route_health.rs`

**Interfaces:** `RouteHealth::failure(scope, candidate, timeout_seconds, now)` 返回计数和新冻结状态；`frozen_until(scope, candidate, now)` 供所有选路路径查询；`success(scope, candidate, now)` 只清未冻结的失败链。`StickySessions::forget_channel(scope, candidate)` 仅解除当前仍指向该渠道的匹配绑定。

- [x] 添加使用注入时钟的失败回归，断言第一次仍可用、第二次冻结、60 秒到期恢复、成功清零、独立成员/入口隔离、多 Key 一起跳过、并发迟到不能解冻；用实际粘滞表验证匹配层级解绑及管理世代保护。
- [x] 运行失败用例并确认原因，再实现有界的进程状态和统一过滤；冻结全部候选时返回 `route_cooling_down` 与可知的 Retry-After。
- [x] 运行状态与完整 Rust 回归，代码保持未提交。

### Task 3: 两次失败的请求与响应生命周期

**Files:**
- Modify: `desktop-tauri/src-tauri/server/src/server/core/upstream/provider_loop.rs`、`route_content.rs`
- Create: `scripts/test-sticky-failover.mjs`
- Modify: `scripts/test-magpie-routing.mjs`
- Modify: `desktop-tauri/ui-shared/routing-options.ts` 或现有粘滞说明的实际落点及五种语言字典。

**Interfaces:** 首内容前由路由层按每个渠道两次尝试编排；`ObservedStream` 携带当前渠道的结果观察句柄，正常 EOF/错误上报一次，丢弃不罚渠道。重发禁止、刷新、限额和取消优先于通用失败重试。

- [x] 使用真实网关及本地 HTTP 上游重现：已粘住 A 后发两次失败转 B，B 两次失败转 C；受限 Key 跳过禁止成员；全部冻结无额外发送；严格/嵌套粘滞同样处理。
- [x] 重现流后错误两次后下次走 B、完整成功清零、客户端断开不计失败，并确认首内容后无第二份上游回复。
- [x] 在旧二进制上运行并保存失败证据，再实施发送及响应生命周期接线。更新严格粘滞回归为两次后切换。
- [x] 跑完整 Rust、专项 HTTP、现有三协议与路由回归，并更新桌面和手机共用说明。

### Task 4: 完整验证、审查与可审核发布候选

**Files:** `docs/upstream-sync.md`、本计划的私有验证账本、`docs/release-notes/3.4.3-beta.2.md`（忽略的草稿）。复审修复另涉及 `config/{mod,routing_profiles}.rs`、`db/backup/restore.rs`、`upstream/{route_context,route_completion,model_trace,usage}.rs`、两种 outbound 解析器、`providers/custom/forward.rs`、`scripts/test-sticky-prepare.mjs` 和 `scripts/fixtures/sticky-timing-{gateway.rs,worker.mjs}`。

- [x] 构建桌面/手机前端及翻译，运行协议、Key 权限、迁移、浏览器路由和带本地 Mihomo 的订阅验收。
- [x] 按 requesting-code-review 对最终未提交补丁进行独立审查，重要问题用失败用例修复，并跑完整相关回归。
- [x] 记录最终采纳/暂缓清单、实际测试证据与所有方案判断；准备 `3.4.3-beta.2` 的逐条日志，保持产品版本不变。
- [x] 向用户展示可审阅候选与八条日志；用户已确认更新并推送 GitHub，指定每次版本名跟随上游，本批采用 `3.5.1`。
- 发布执行：同步六处版本及对应锁文件、验证、提交并推 `origin/beta`，验收双架构镜像及源码 revision，再更新 `175.178.69.4:3065`；不推 main、不打 tag。实际执行结果随命令记录于本计划的私有发布验收账本。
