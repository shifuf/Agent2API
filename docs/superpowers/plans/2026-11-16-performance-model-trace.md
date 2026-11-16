# 小内存服务器性能与模型溯源 Implementation Plan

> **For agentic workers:** Use executing-plans inline, task by task, with behavioral regression tests and a final independent review.

**Goal:** 修复版本信息和页面数据读取造成的重复计算与内存放大，然后补充上游响应模型证据。

**Architecture:** 延续 Rust/Axum/SQLite 与 React 岛，按可见分类加载、合并在途读取；重查询移到 blocking 线程并缩小读取范围。模型证据在响应改写前按尝试采集，复用 attemptDetails JSON 持久化。

**Tech Stack:** Rust, SQLite, React, TypeScript, Node tests.

**Spec:** `docs/audits/2026-11-16-performance-magpie-model-trace.md`；用户授权“先执行性能修复，特别是版本信息…服务器是2h2g → 模型溯源”。

## Global Constraints

- 本轮先性能、再模型溯源；不接 Magpie，不发版、不推送、不改版本号。
- 保护既有路由组、Key 权限、倍率、代理与 Docker 定制。
- 保留正文完整性；浏览器预览有界不等于转发截断。
- 名称不一致只是证据提示，不作为真模型鉴定。
- 按仓库 release-flow 在当前 beta 工作；复用已安装依赖，避免额外工作树与全量复制。

## Review Focus

- 快速切换路径脱敏时，旧响应不能重新显示未脱敏路径。
- 隐藏页暂停不破坏草稿、切回刷新或手动刷新。
- SQL Unicode 筛选、聚合窗口、计数和历史页保持语义。
- 详情关闭释放资源，超大正文不自动解析或写入 DOM 属性。
- 流式模型字段跨 chunk、别名回写、重试归属与旧记录缺失均正确。

### Task 1: 版本信息加载

Files: settings-state.ts, system-info-pane.tsx, api/system_info.rs, request_stats.rs.

- [x] 增加分类加载与并发读取行为测试，确认旧逻辑失败。
- [x] 仅访问版本分类时读取；在途合并与乱序保护；后台收集移出 Tokio 并避免为单个计数读取完整统计。
- [x] 运行相关 Node / Rust 回归与 TypeScript 检查。

### Task 2: 查询与渲染性能

Files: request_stats/sql.rs, logs_store/{sql,mod,presentation}.rs, api/{stats_api,logs_api}.rs, routing-replay-state.ts, request-detail.tsx, request-raw-panes.tsx.

- [x] 增加查询结果/分页与大报文行为回归测试。
- [x] 请求计数使用 WHERE；日志流式遍历并只保存当前页；重查询阻塞线程执行。
- [x] 隐藏路由时钟暂停；详情正文按访问加载，超大预览停止 Markdown、改为复制；隐藏账号页不重复重渲染。
- [x] 保留完整诊断正文；流式落盘不在本轮实现，见验收记录的剩余限制。
- [x] 百万行 SQL 对比使用现有时间、状态索引，包含全局计数。

### Task 3: 模型溯源

Files: core/upstream/{usage,sse,aggregate}.rs, core/plugin_host/stream.rs, request_stats/record.rs, request-detail.tsx.

- [x] Chat/Responses/Anthropic/Gemini 字段、碎片 SSE、有界采集测试。
- [x] 改写前捕获响应模型，保存至对应 attemptDetails；未知不造值，旧记录兼容。
- [x] 详情显示每轮发送与响应模型及路由原因，补齐五份翻译及构建产物。
- [x] 隔离 HTTP 验证三协议流式/非流式别名；单元验证每轮隔离及插件来源。

### Task 4: 验证与审查

- [x] UI typecheck/build、相关 Rust/Node 测试、隔离 HTTP/浏览器验证。
- [x] 独立性能/UI 审查并修复实质问题；模型采集接线由主代理复核，协作消息缺失的限制记入验收记录。

## Execution ledger

- 2026-11-16：用户明确要求执行，视为从方案讨论转入实施；沿用 beta，本地不提交/推送。性能与溯源连续完成，无需重复询问流程许可。
- 版本信息：settings-state::load 同时启动 22 个读取；system-info 同步完整统计和模型目录，且没有请求合并。
- 版本页分类按需加载后，隔离浏览器确认单次 system-info 请求，无隐藏 storage/cloud-sync/update token/retention/retry 请求。设置草稿及路径脱敏乱序由 Node 测试覆盖。
- 第一次 Rust 完整测试 411/411，通过后补充日志 Unicode/窗口分页和插件来源测试；最终结果以验收记录为准。
- 首轮 HTTP/浏览器验收 8 个场景通过：三协议各流式/非流式、版本页、20MiB 正文；临时库版本接口 4.5–7ms。
- 百万行内存 SQLite：旧/新无筛选 69.498/0.514ms，时间筛选 83.943/0.256ms，包含三个计数且结果一致。不是生产服务器端到端数据。
