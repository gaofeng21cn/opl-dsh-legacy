# Agent Note：thinking 模式 CoT 按两种线上字段名回传，并报告控制标记

Status: implemented

[English](2026-09-22-reasoning-passback-and-control-markers.md) | 中文

## 问题

OPL Gateway 上的一个会话有四个轮次以 HTTP 400 `INVALID_REQUEST`、`The reasoning_text in the thinking mode must be passed back to the API.` 结束。chat-completions 转换层仅把思考通道读作 `delta.reasoning_content`；该网关以 `delta.reasoning` 流式返回它，因此每个工具调用轮次都在没有 CoT 的情况下被持久化与回放。这不是 DeepSeek 的官方字段名，所以修复必须在接受该别名的同时保持官方协议可用。

同一路由上另有三个轮次仅以 `TRANSPORT: DeepSeek API request to https://gateway.medopl.com/v1 failed` 失败。一个 code 同时覆盖了连接被拒、DNS 失败、TLS 拒绝、读取停滞与流中途失败，因此记录无法说明是哪一层失败。

此外，该会话中有十二个 assistant 文本块携带 `<thinking>` 分隔符，最后一条消息把整个工具调用以 `<｜DSML｜invoke>` 风格标记携带，而完全没有结构化工具调用。针对同一模型的 Codex 会话也出现过相同标记，因此来源未知，而非明显出自本地。

## 决策

将 `DSH_REASONING_TRACE_DIR` 设为绝对路径可为 Chat Completions 显式启用逐次请求指纹文件。分别观察白名单内的原始推理字段、已组装块、投影输入与序列化后的出站消息。SHA-256 基于 UTF-16LE 计算，使跨分片的代理对可以比较而无需保存正文。工具调用 ID 的哈希将响应事实关联至后续历史；会话日志仍是独立的持久化证据。报告包含失败 HTTP 状态，不包含提示、参数、凭据及响应正文。诊断自行隔离失败，不改变回放或重试。详细历史保留 128 条助手消息及完整摘要；文件需手动清理。别名修复不代表所有推理相关 400 错误均已解决。

`reasoningDelta` 依次从 `delta.reasoning_content`、`delta.reasoning` 解析 CoT，返回第一个非空值，因此同时携带两者的分片只贡献一次而不会重复。空字符串仍表示“无更新”，保留首个实时分片不得打开思考块的既有行为。序列化保持不变：该块以 `reasoning_content` 持久化在 assistant 消息上，这既是网关要求回传的内容，也是历史重建已经回放的内容。

`transportDiagnostics` 在 `fetch` 的包装错误下读取平台错误，并把 `transportStage`（`request` 或 `response-body`）、`causeName`、`causeCode` 附加到 `TRANSPORT` 失败上。只复制错误类名与 errno 风格 code，绝不复制消息，因为消息可能嵌入端点、请求头或凭据。

本词表中属于工具调用的部分由[结果边界记录](2026-09-23-control-recovery-outcome-boundaries.zh.md)在结果层读取：已完成轮次最终可见正文里未被执行的工具语法会把业务结果标为未经验证。`controlMarkerFamilies` 识别观察到的标记族——`thinking` 分隔符、DSML 包装，以及 `invoke`、`parameter`、`tool_calls` 标签名的裸写与 DSML 包裹两种拼写。`WireObserver` 在载荷进入时、`translate` 映射它们之前，读取每个已解析载荷的字段名、分片数与字符数、标记族与原始结束原因，每个通道只保留一段有界尾部，使跨分片拆开的标记仍可匹配且不保留任何文本。chat-completions 适配器把它与转换产出的块对照，并为每个异常尝试调用一次 `onProtocolAnomaly`，同时呈现两侧；标记文本、提示与思考内容绝不保留。可见文本中的标记既不执行也不剥离。

## 考虑过的替代方案

**只把字段改名为 `reasoning`** 会破坏同一适配器服务的官方 DeepSeek 协议。解析两个名字可让两种端点都可用。

**当一个分片同时携带两个名字时拼接两者** 会让每个思考 token 重复，端点在回传时会拒绝。

**从可见文本中剥离标记** 隐藏了证据却没有定位成因，还会静默丢弃模型输出。这里改为报告该异常。

**重试 400 或合成思考文本** 会伪造端点所校验的 CoT；请求必须携带模型自己的文本。

**通用请求／响应日志系统** 会把提示与思考内容持久化到存储中。按尝试的有界对照无需新的日志面即可回答该问题。

**保留完整原始 SSE 以备事后检查** 被拒绝作为默认行为：它会为罕见异常持续把提示与 CoT 写入磁盘。

**只观测转换后的分片** 经审查后被否决：已完成的流记录的是转换产出的结果，而不是端点发送的内容，因此无法区分上游控制语法与本地映射缺陷。原始旁路每个载荷多一次解析，且在未配置接收方时完全跳过。

## 影响

批次 A 已在真实网关上验证：六次请求全部 HTTP 200，跨越五个连续工具调用轮次，每个工具调用轮次都携带其 CoT 并以 `reasoning_content` 回放。一次实时单请求确认该网关流式返回 `reasoning`，从不返回 `reasoning_content`。该 400 无法在孤立的短回放中复现，因此回传路径由多轮链与针对已观察线上形态的离线回归测试固定，而不是靠一次未报错的调用。此变更之前丢失的思考文本不可恢复；那些会话将继续在没有它的情况下回放。

对于标记异常，失败轮次的持久化日志只能直接证明转换后的位置：其文本块携带全部标记文本，而其内嵌紧凑流——由 `text-delta` 分片打包而成，并非原始 SSE——在该步骤中没有思考或工具调用记录。前一步骤在正确组装结构化调用的同时也显示同一形态。由于现有映射只从 `delta.content` 产出文本块，该形态与"标记是作为可见内容在上游进入"相符，而仅看转换结果的视角并不会预测它们应当出现在别处。这是依据映射实现所作的推断，不是原始响应证据，也无法区分是模型发出了该语法还是网关转换出了它。因此根因仍未确定；原始旁路才是让下一次出现变为可判定的手段，已有会话未被修复。未再消耗真实请求尝试复现。

`LlmFailure` 新增三个可选属性，已由 [传输诊断记录](../../../../docs/persistence-changes/2026-09-22-transport-failure-diagnostics.zh.md) 以 same-version 确认，并扩展了由 [有界 LLM 请求恢复](../architecture/2026-06-21-bounded-llm-request-recovery.zh.md) 拥有的载荷。更早的读取方会忽略它们，此前写入的记录只是省略它们，重试路由仍只读取 `LlmFailure.code`。

## 测试

`pnpm exec vitest run packages/llm/llm packages/llm/llm-deepseek packages/llm/llm-retry` 覆盖思考别名、同时携带两个名字的分片、别名词旁官方字段为空的情形、标记族、原始线上统计及其边界、两侧分离、干净轮次保持静默、报告不携带内容、抛异常的接收方不改变流，以及截断的流如实报告部分统计。`packages/llm/llm-deepseek/tests/reasoning-persistence.spec.ts` 驱动真实适配器、真实 agent loop 与真实 JSONL 持久化：运行一个别名思考的工具调用轮次，释放上下文，在新上下文中重新载入已存储会话，并断言下一个派生出的线上请求以 `reasoning_content` 携带该 CoT 且其工具结果已配对。transport-recovery 套件经真实 HTTP/SSE 适配器驱动连接被拒、流中途失败、停滞的响应体、传输重试预算耗尽与凭据脱敏。
