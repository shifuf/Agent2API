# 首响应等待与域名加速验收

## 根因证据

生产域名 `ai.shifuf.com` 的 DNS 和 `EO-Cache-Status` / `EO-LOG-UUID` 响应头确认使用腾讯 EdgeOne。2026-11-26 北京时间 00:44–00:49 的请求在网关记录为 14,992–14,999 ms、408、客户端断开；对应 Nginx 为 `499 0`，没有响应数据发给下游。源站 Nginx 已关闭缓冲，读取超时 600 秒。

没有调用真实模型的隔离 POST 探针：

| 请求模式 | EdgeOne 域名 | 源站 Nginx |
|---|---|---|
| 20 秒后才发送响应头和首数据 | 15,109 ms 返回 524，Response Timeout by Origin Server | 20,027 ms 返回 200 |
| 立即发送 SSE 注释并持续保活，20 秒后完成 | 首字节 154 ms，20,172 ms 完成 | 首字节 7 ms，20,024 ms 完成 |

探针的临时 Nginx location、HTTP 服务和配置修改在 finally 中清理，恢复原配置。生产容器未替换。

失败请求的实际 attempts_detail 只有一个进行中的发送，没有上游失败回执。其五个候选是排序快照；连接被 EdgeOne 关闭之后，响应 handler 被丢弃，不能继续向已经断开的调用方换号。成功的 18,350 ms 请求在 14,168 ms 已有首响应，因此没有触发同一个首响应限制。已确认当前跨层的 15 秒限制；没有历史 EdgeOne 配置证据可证明该限制何时发生变化。

## 修复与验证

- HTTP-only forward helper 等待 500 ms；快速结果保留现有 HTTP 行为，长等待把仍在进行的 future 交给响应体持有，没有独立推理后台任务。
- 最终 SSE 边界立即及每 5 秒发送注释，位置在协议转换、记账之后；不会计入首内容、用量或会话绑定，也不会把已交付的回答换成另一账号。
- 仅在完整 LF/CRLF SSE 边界插入注释，保护分片 data 行；源流结束优先于保活定时器。
- 响应头之后的最终失败转换为对应协议错误事件，并保留 telemetry 和尝试错误；JSON 请求与内部请求维持原语义。
- 对首次延迟响应、换号保活、主动断开、慢最终失败、快速错误、JSON 行为做完整 HTTP 验证。

| 验证 | 结果 |
|---|---|
| 初始 HTTP 失败基线 | 5 个用例失败，确认缺少及时响应数据 |
| 最终二进制完整 HTTP 路由 | 39 passed, 0 failed |
| 真实 Host / RpcAdapter / HTTP | 6 passed, 0 failed |
| 准备阶段契约 | 3 passed, 0 failed |
| Rust 全量 lib，`--test-threads=1` | 537 passed, 0 failed, 21 ignored |
| Rust 默认并行（两次） | 536 passed, 1 failed, 21 ignored |
| 上述失败用例独立运行 | 1 passed, 0 failed |
| 独立产品代码审查 | 无 Critical / Important 问题 |

默认并行失败用例：`server::core::login::managed::tests::terminal_source_audit_still_checks_original_flow_provider_and_method`，在现有夹具 `managed.rs:475` 断言本机来源已捕获时失败。来源捕获对共享令牌表使用 `try_lock`，并发签发/撤销时可以拒绝捕获；该用例独立运行与全量串行运行均通过。本轮没有修改该认证行为或夹具，不能宣称默认并行套件全绿。

审查中暂缓的次要建议：新 helper 排版较紧凑；尚未扩展纯 CR 的 SSE 分隔边界，当前规范化 LF/CRLF 路径已验证。

## 发布与运行边界

版本保持 3.5.1；当前源码和最终二进制已验证，尚未提交、推送或替换生产容器。新日志须按 AGENTS.md / release-flow 由用户最后确认，只推 origin/beta、只更新 175.178.69.4:3065。

当前 DeepSeek 路由配置 firstToken=0，首内容等待期限被显式关闭。本轮没有自动覆盖它。用户已确认推送更新，部署时改为每候选 180 秒，让无响应的候选也能在保活连接中触发后续选路，仍遵循既有渠道连续两次失败冻结规则。

本次 HTTP 保活针对流式调用。长时间非流式 JSON 请求无法以 SSE 注释保活；仍需提高外部 EdgeOne 回源首响应超时或使用源站连接。实际内容交付后的中断不会拼接另一账号的回答。
