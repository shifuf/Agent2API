# 页面性能、Magpie 插件兼容与模型溯源检查

检查日期：2026-11-16。源码基线：`bb3ea8fe`。

本文是检查结果与实施建议，尚未修改产品代码，也不表示插件已适配或卡顿已修复。

## 证据范围

- 检查桌面/Web 共用 React 岛、账号状态轮询、系统日志、请求日志、报表、详情预览、调试正文采集、插件宿主和模型改写路径。手机端共用后端，但本次没有对手机 UI 做性能验收。
- 阅读 `F:/magpie-main/magpie-main` 的插件运行时、宿主代码、提供商文档；未执行其社区插件、登录或迁移账号。
- 当前机器未发现运行中的 Agent2API 进程。仓库 `data/agent2api.db` 只读检查：4 个账号、684 条系统日志、2 条请求记录，上下游原始报文表均为空。这份数据不足以复现用户的长期运行现场。
- 使用当前项目真实 JavaScript 渲染函数做合成大报文测试；使用内存 SQLite 做百万行计数测试。两者均不修改业务数据。
- 未取得实际故障进程的 heap snapshot、长时间 GC 后堆曲线或 HTTP 并发压测结果，因此不能宣称已经定位全部卡死原因。

## 已发现的问题

### 1. 请求详情会提前读取并渲染大报文（优先级 P0）

位置：`desktop-tauri/ui-islands/src/islands/request-detail.tsx`（`loadRaw`、`loadDebug`、挂载 effect、四个 section）；`request-raw-panes.tsx`（`PreviewPane`、`RawPane`）；`desktop-tauri/ui/conversation-preview.js`。

打开默认“请求详情”标签就并行请求上下游正文。预览和原始报文使用 `hidden` 隐藏，却仍然挂载。`PreviewPane` 每次渲染直接执行全文解析和 HTML 生成，没有按标签首次访问延迟执行，也没有结果 memo。原始报文还把正文放进复制按钮的 `data-copy` 属性。

首次测试结果（助手响应包含重复 Markdown，Node，单次）：

| 文本大小 | 同步渲染耗时 | 渲染期间 JS 堆增加 | HTML 大小 |
| --- | ---: | ---: | ---: |
| 1 MiB | 40.2 ms | 11.7 MiB | 1.37 MiB |
| 5 MiB | 235.6 ms | 63.8 MiB | 6.86 MiB |
| 20 MiB | 585.8 ms | 202.2 MiB | 27.44 MiB |

这些数字不包含 React、浏览器 DOM、样式与布局，也不是长期保留堆的测量。证明的是同步 CPU 和临时内存放大，不等于证明泄漏。详情关闭有 `root.unmount()` 和宿主节点删除，不应误报成“弹窗完全不清理”。关闭只令旧响应失效，尚未取消网络读取。

建议：详情先读小摘要；访问对应标签时再取正文；按消息或文本块分页/虚拟化；解析移到 Worker 或分片执行；复制按钮通过回调读取数据；关闭取消在途请求，释放全文与预览缓存。完整正文通过流式导出保留，避免把整个正文复制进 DOM 属性。

### 2. 请求日志的计数绕过索引筛选，每次读完整表（P0）

位置：`request_stats/sql.rs::counts`、`request_stats.rs::query_requests`、`api/stats_api.rs::stats_requests`、`ui-islands/src/islands/requests-page.tsx`。

`counts` 把过滤条件放到 `SUM(CASE WHEN …)` 内，外层没有 `WHERE`。即使用户只查少量记录，也需要扫描全部请求计算总数、命中数、进行中数。页面默认间隔 1 秒；列表虽有 SQL 分页，计数仍与总历史量相关。异步 handler 直接执行同步数据库工作。

百万条合成窄行测试，五次中位数：带 provider 条件约 145.20 ms，无筛选约 65.96 ms。查询计划确认 `SCAN requests`。在该合成表的 provider/status 索引上分别计算命中数与进行中数约 0.01 ms；这只说明可索引筛选的收益，**并非完整接口优化后的耗时**，也不表示生产 schema 已有 provider 索引。

建议：把总量与筛选计数分开，按真实筛选组合补索引；使用内容版本缓存计数；进行中行单独增量刷新，历史页停止整页高频轮询；同步查询移出 Tokio 工作线程。确保删除/裁剪/新请求/终态更新均使缓存失效。

### 3. 系统日志仍先全量读取、解析，再分页（P0/P1，取决于保留量）

位置：`logs_store/sql.rs::select_matching_desc`、`logs_store/mod.rs::query`、`logs_store/presentation.rs::groups_paged`。

SQL 没有 `LIMIT`，先将所有匹配记录转成 `Vec<LogEntry>`，解析 data 并执行历史兼容规则，再统计、折叠、分页。已有查询缓存和“页外分组不保存全文”的优化，但每次追加日志会改变 epoch，使缓存失效。高频写入时仍重复支付全量开销。

分页限制的是“组数”，不是原始记录数；一个 30 秒折叠组可以附带大量 `entries`。日志响应体的大小并不严格受每页条数限制。默认系统日志保留 10,000 条，可配置上限 100,000,000 条，更容易放大此问题。

建议：先解决历史分类归一化/版本迁移，普通列表在 SQL 分页；聚合列表只返回摘要和计数，组内原始记录使用详情分页。Unicode 关键词匹配、旧日志级别归一化、30 秒分组窗口、快照水位都必须保留原语义，不能直接加 `LIMIT` 破坏总数或漏匹配。

### 4. 隐藏页面仍在更新，全局刷新触发账号全表重算（P1）

位置：`ui-islands/src/island-lazy.ts`；`ui/app.js::refresh/render`；`accounts-data.ts` 的 `render`；`accounts-page.tsx`；`routing-page.tsx`；`routing-replay-state.ts`。

- 页面第一次打开后一直挂载。切页只控制显示，没有统一的暂停/释放生命周期。
- 全局每 20 秒读取完整 session（账号、模型目录、路由预演等），成功即调用账号视图 `render`，后者无条件 `bump()`。访问过账号页后，即使正在看其他页也会触发该页订阅者重新计算。
- 账号页默认 `defaultSize: 'all'`，每次渲染重做分组、筛选、计数和行列；连接数变化也会更新整个 store。
- `RoutingPage` 固定调用 `useRoutingReplay(true, …)`。该 hook 的每秒 `setNow` 没有页面可见性检查，切走甚至窗口隐藏后仍会驱动路由页重新渲染。网络轮询有可见性检查，时钟更新却没有。
- 部分辅助轮询（例如 `CheckinUmid`）也缺少可见性与在途互斥控制。

建议：统一页面 active 状态；隐藏页面暂停时钟、订阅计算和无必要请求；有未保存草稿的页面保留数据，不盲目卸载；账号行按独立字段订阅或 memo，默认有界分页/虚拟列表；session 分版本更新，内容不变不通知整页。

### 5. 调试采集无字节上限，长流会持续占用内存（P0）

位置：`core/debug_traffic.rs::TrafficCapture::push`；`api/pipeline/raw.rs`。

调试模式下，上游响应通过 `Vec<u8>::extend_from_slice` 累积到结束/取消才存储，下游正文也保存在内存缓冲中。记录条数限制不能限制单条大小或并发期间总内存。大请求体还会被复制进调试条目。

这是“有归属、但没有大小上限的缓冲”，不能直接称为丢失引用的泄漏。它只在正文采集开启时生效，不能解释未开启调试时的全部故障。

建议：小缓冲转临时文件/流式落盘，保持完整原文；定义进程级与单请求采集预算；限制仅作用于诊断采集，不能截断正常转发响应。若采用截断诊断正文，必须明确标注并由用户接受该留存语义。

### 6. 插件适配器有确切的永久分配（P2）

位置：`core/plugin_host/rpc.rs::RpcAdapter::new`、`leak_str`、`leak_slice`；创建入口 `plugin_host/bootstrap.rs`。

provider id、label、拒答字符串及切片使用 `Box::leak` 获得 `'static` 引用。适配器重新创建时会再次分配，旧对象释放也不会回收这些字符串。这是确定的永久分配，通常量小，尚无证据证明它导致当前高频卡死。

建议：调整 trait 借用生命周期或使用可释放的共享所有权。若暂时做字符串驻留，必须说明它仍保留所有曾出现过的不同字符串，不能声称彻底无增长。

另外，插件流虽然使用 unbounded channel，但协议已有 512 KiB credit 窗口，不能只凭通道类型断言无限积压。后续兼容 Magpie 时需要保持并验收背压与取消。

### 7. 首屏仍需解析整个前端 bundle；报表仍有历史扫描（P1/P2）

`island-registry.ts` 使用 eager glob，当前 `ui/islands/ui.js` 为 2,517,900 字节。按需挂载减少首屏 DOM，不会减少整包下载、解析和求值。

`request_stats.rs::usage_summary` 每次读取每日聚合、近 7 天缓存窗口和近 24 小时趋势窄列；已有窄列、覆盖索引、`spawn_blocking` 和前端轮询互斥，但没有按数据版本复用完整报表。前端 JSON 签名只减少绘制，不能省掉后台计算和传输。

建议：先修上述热路径，再做页面代码分包与按数据/时间桶失效的报表缓存。缓存不能跨越日期或小时窗口继续返回旧统计。

## Magpie 插件兼容结论

**现有安装器不能直接加载 Magpie 的插件。实现兼容层可行，但尚未做运行验收。**

| 插件类别 | 当前情况 | 可行路径 |
| --- | --- | --- |
| OpenCode v1 / Magpie 社区 JS、TS、npm 插件 | Magpie 的 Bun 宿主动态加载；本项目不是该插件 API | 独立 Bun 兼容宿主，桥接认证、目录、fetch、usage、checkin |
| Magpie Go 内置插件（`plugins/`） | 通过 Go `init` / `pluginrt.Register` 编译注册，依赖 Go 服务对象 | 无法直接导入；按功能移植或继续由独立 Magpie 实例承载 |
| 中间件、工具、页面、面板、路由策略等扩展 | 依赖各自的宿主服务、窗口 API 和扩展点 | 单独做契约映射，不能归为提供商兼容后自动可用 |

本项目安装格式是 `pack.json` + 协议版本 + 平台入口，启动进程后调用自身的 provider RPC。Magpie 的 `host.js` 接受 `{id,method,params}` 行协议，提供 `init/providers/authorize/callback/load/usage/checkin/tool` 等方法，流式有 `head/chunk/credit/abort`。两边都使用进程通信只说明可以桥接，不说明方法、错误、账号或模型语义相同。

推荐路径：独立兼容宿主，在现有插件管理里显示兼容类型及能力，先覆盖提供商插件。账号主键和所有权、凭证续期、代理、取消与超时、流背压、错误分类、provider id 冲突都必须显式转换。宿主进程隔离不等于操作系统沙箱。

替代路径：让 Magpie 独立运行，把它的网关当自定义上游接入。工作量较小，可使用其插件效果，但插件仍安装在 Magpie 内，不能满足“本项目直接管理和加载插件”的完整目标。

Magpie 仓库许可证为 MIT，复用代码需要保留声明；具体第三方插件包的许可证需要分别核对。

验收至少逐项覆盖 provider-adaptation 的六列：非流式和流式对话、Token 续期、在线模型目录、余额、签到、领取类。插件未提供的能力标为未提供/未知，不能伪装成已实现。还需覆盖两个账号隔离、同名 provider 冲突、卸载后释放、长时间慢消费者与取消。

## 模型溯源结论与建议

现有信息包含 `clientModel`、`upstreamModel`、路由快照、逐次 `attemptDetails`。`payload::send_body` 采集的 `upstreamModel` 是网关解析并发出的名称，不是上游确认的内部执行模型。插件还可能继续转换请求，须标明采集边界。

后端 `AttemptDetail` 已有 model、reasoning、reason、accountId、candidateId、memberId 和时间字段，但当前详情弹窗的类型与表格只展示其一部分，连每轮 model 都没列出。这部分可以先补展示，无需从日志文本猜测。

`provider_loop.rs` 的会话式完成响应以及 SSE 回写会恢复客户端模型名，所以不能用网关最终返回的 `model` 作为上游身份依据。

建议详情呈现：

```text
客户端请求模型 → 路由组/映射 → 每轮网关发送模型 → 上游响应声明模型
                   ↓               ↓                    ↓
              选择/切换原因     提供商、账号、端点      来源字段、请求 ID
```

- 逐次尝试记录：顺序、账号稳定标识、provider、发送 model、上游声明 model、协议、脱敏 endpoint、耗时、状态、换模/换号原因、最终承载轮次。
- 在转换或别名回写前采集上游 JSON / SSE 的模型字段，如 Chat `model`、Responses `response.model`、Anthropic `message.model`、Gemini `modelVersion`。没有该字段明确记“未提供”，插件合成的名称明确标记为插件声明。
- 小型溯源元数据独立于调试正文开关持久化；正文仍按采集与留存策略。不要为了查模型强制打开所有请求的全文留存。
- 支持按 request id、请求模型、发送模型、上游声明模型、provider、账号和不一致状态检索。精确字符串不等只能提示名称不一致，版本别名需要另行解释。
- “网关改变了路由”可以通过本地可信记录查证；“上游私下换了权重却仍返回原名称”不能凭其自报字段证明或排除。不要把名称一致显示成真模型认证。
- 旧记录无采集字段不能补造；只有保存过的原始报文可能提供部分证据，且现有调试表只保留最后一次尝试，不能恢复整个重试链。

## 建议实施顺序与验证

1. 性能修复：按需正文、隐藏页暂停、账号局部刷新、可索引日志计数、系统日志有界查询、调试采集内存预算。
2. 模型证据链：先展示已有逐次 model，再新增改写前响应元数据采集和筛选。
3. 插件兼容：独立 Bun 宿主与插件能力验收，避免将额外运行时与当前卡顿问题混在一起定位。

性能验收需在隔离数据上覆盖 10 万/100 万条记录、成百上千账号、1/5/20 MiB 报文、慢响应、长流和并发。反复切页和开关详情至少 100 次，观察强制 GC 后保留堆是否趋稳、定时器/监听/在途请求是否回到基线；采集 API p50/p95、长任务、JS 堆与后端 RSS。上述验收尚未执行。

本次可复现脚本（本地检查材料）：

```powershell
node --expose-gc .verify/performance-audit/preview-benchmark.mjs
python .verify/performance-audit/counts-benchmark.py
```

实施不得覆盖本仓库路由组、模型管理、账号/Key 选择与权限、倍率、代理订阅及 Docker 定制；本轮未改版本、分支、更新日志，未提交或推送。
