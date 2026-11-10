# 选择性同步上游 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 吸收兼容的上游修复，保护定制功能，验证并推送 beta。

**Architecture:** 以 ef464c8c 为基线，按文件/补丁移植已审查的独立修复，不合并整个 upstream/beta。保留原作者与来源 SHA；最终快进回 beta。

**Tech Stack:** Rust/Axum、TypeScript/React、Node 行为回归、GitHub Actions/GHCR。

**Spec:** `docs/upstream-sync.md`。

## Global Constraints

- 不修改 3.4.2 版本、现有数据 schema、路由和凭据权限语义及 Docker 发布目的地。
- 不碰真实数据；源代码及测试中不保存真实凭据。
- 来源不等于整提交已采纳；逐项记录，未来继续检查暂缓内容。

## Review Focus

- 命名空间、超长和非法字符工具名必须与历史/指定工具/回程对应，不能串到其它工具。
- 重复工具声明以后出现的为准，保持位置；有歧义的旧名称不得任意选择。
- 原始请求提前释放不得改变去重、调试抓取与签名输入。
- 多图片混合无效图片时，压缩和统计不能错位。
- 编辑 TOML 必须保留注释、引号键、BOM 与换行；改动后的 JSON 语义相同。

## Task 1: Responses 工具兼容

Files: `core/protocol/{responses.rs,tool_plan.rs,tool_plan/names.rs,responses_sync_tests.rs}`（均在 server/src/server 下）。

- [x] 为名称合法性、冲突/重复、history/tool_choice、流式和聚合回程添加回归，先证明旧代码失败。
- [x] 应用 196bd641 的三文件补丁，保留基线的用量与其他协议转换逻辑。
- [x] 运行新回归及 Rust 测试，记录来源和作者。

## Task 2: 请求内存和 TOML 保真

Files: `api/{chat,protocol}.rs`, `config/mod.rs`, `core/debug_traffic.rs`, `core/upstream/image_compress.rs`, `core/agents/toml_editing.rs`。

- [x] TOML 注释/引号/BOM 回归先红后绿；图片混合格式回归验证输出语义。
- [x] 选择性应用 b1dbef8f 的生命周期/压缩/开关优化，及 aba58858 的原位替换。
- [x] 不引入未验证的记账和断线队列改造。

## Task 3: 整体验证、审查、推送

- [x] 构建服务端；运行全套 Rust 测试及路由、迁移、模型/Key/账号、倍率、代理订阅、Grok 的受影响回归。
- [x] 用 requesting-code-review 的独立审查确认未覆盖受保护功能。
- [x] 完成同步记录，三个移植提交保留作者署名与来源 SHA。

### 提交后的执行与验收

1. 提交同步约定与测试脚本兼容修正；确认主工作区无改动且远端基线未变化后，快进 beta 并推送 origin/beta。
2. 等待该提交对应的 `Docker package` 构建完成，核对 amd64/arm64 与镜像 revision，再向用户报告结果。

推送和镜像验收证据记录在对应 Actions 运行及本地任务记录中；本文随推送一起提交，不预先把尚未执行的远端操作标记为完成。
