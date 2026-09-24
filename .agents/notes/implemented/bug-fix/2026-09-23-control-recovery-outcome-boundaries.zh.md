# Agent Note: 恢复结果按已记录的事实区分

Status: implemented

[English](2026-09-23-control-recovery-outcome-boundaries.md) | 中文

## Problem

已派发任务的通知会把循环记为 `completed` 的轮次报告成业务成功，即使该轮最终可见正文里仍带着工具调用标记——DSML 的 `invoke`/`parameter` 块，或裸标签写法。没有任何东西执行过这些标记，因此读到 `completed` 的派活方会去审查一个并未完成任务的工作。投递出去的通知里没有接收方可检查的字段，而唤醒消息的第一行只写着 `completed`。

在这个缺口周围，轮次结束的其他事实在恢复边界上都缺少聚焦覆盖：未以 `[DONE]` 结束的 SSE 流（`STREAM_CLOSED` 失败）、精确的 reasoning_text 失败、操作者停止，以及手动继续。停止还留下一个陈旧续做的洞：`session.cancel` 会保留待处理的 inbox 工作，因此已被准入、但尚未被任何轮次认领的自动续做指令会开启操作者的下一轮，使旧投递在手动停止之后追加续做。

[已派发任务反馈记录](../feature/2026-09-22-dispatched-task-feedback-and-wake-seam.zh.md)负责本记录所扩展的任务登记表、续做接缝与唤醒投递。

## Decision

结算时会读取该结算轮次自己的最后一条 assistant 消息，并把其中可见正文里发现的工具调用族作为 `leakedToolSyntax` 记录在任务记录与投递载荷上。状态仍是 `completed`，因为那是循环记录的事实；摘要、该字段以及唤醒消息中专门的 `attention:` 行说明业务结果未经验证。只读取最后一条 assistant 消息：当该消息没有请求任何工具调用时轮次才会 `completed`，因此那里的标记本应是调用；较早的步骤、思考块、工具结果与更早的轮次都不读取。词表是工具调用子集——DSML 包装、`invoke`、`parameter`、`tool_calls`——而不是线级诊断的完整集合，因为可见正文里的 `thinking` 定界符并不否证一次完成。该词表刻意比[控制标记线级诊断](2026-09-22-reasoning-passback-and-control-markers.zh.md)更窄：那篇记录负责原始线路证据并同时报告定界符，而结果声明只会被"没有任何东西执行过的工具语法"否证。泄漏语法的完成不具备自动续做资格，因此 `resumeFailed` 回答 `not-applicable`，不会有自动续做跟进。

手动停止——取消原因为 `user` 的 `turn/end`——会让该会话仍处于待处理状态的每一次自动续做收手：从活动 Inbox 移除已排队的指令，清空 receipt 上的 `resumeSubmitted`，同时保留 `resumeAttempt` 与 `resumeRootTaskId`（预算是已花费，而不是退回），并把该尝试任务报告为 `cancelled`，摘要点名这次撤回。之后的重放会针对已停止的会话重新校验并回答 `superseded`。已被某个轮次认领的指令不作处理；由该轮次自己的中止结束来结算它。

记录与载荷字段都是带 `.default(null)` 的追加字段，因此更早构建写下的记录仍能载入，域版本也不变。控制 CLI 把 `resumeFailed` 的非 `resumed` 决定连同原因打到 stderr 并以退出码 5 结束，因此只读退出状态的调用方不会把"没有提交任何指令"当成一次恢复，也无法机械重试一个终局答案。让已接受的交接不被二次发送的发送方重试规则，仍由[已接受反馈交接记录](2026-09-23-stop-requeue-after-accepted-feedback.zh.md)负责。

## Alternatives considered

**用新的终态而不是追加字段来报告。** 增加一个 `TaskState` 成员会让状态本身说出区别，但状态词表是持久域格式的一部分：新增成员会让其后写入的每条记录对更早的构建不可读；而该域使用 `single` 布局，版本提升会直接拒绝已有存储而不是迁移它。追加的可空字段加上明确的摘要说明同一事实，却没有这种断裂。

**把泄漏语法的完成当作 `failed`。** 那会对循环自己记录的原因说谎，并把该结果归入由 reasoning_text 失败拥有的"可续做"词表。

**把"交接摘要"或任何简短回答检测成假完成。** 文本形状不是协议失败的证据，这样的启发式会误标合法的简短回答。只有测试框架识别为未执行控制序列的语法才会被报告。

**停止后保留已排队的续做指令，交给下一轮消费。** `session.cancel` 按设计保留待处理的 inbox 工作，对操作者自己的消息这是对的。自动指令属于发送方，因此它收手；否则旧投递会在操作者接下来所做的一切中追加续做。

**让接收方判断非 `resumed` 的回答是否算失败。** 服务已经报告了原因，但只看进程退出状态的调用方会把每次被回答的调用都读成成功。退出码 5 让这次收手可见，同时不改变服务的行为。

## Consequences

`completed` 的任务记录现在多带一个可空字段，忽略它的接收方看到的仍是循环记录的状态；读者据以行动的是摘要与通知里的 `attention:` 行。泄漏语法的完成会通知（它的状态是 `completed`，属于默认 `notifyStates`），这是刻意的：派活方必须知道该结果需要审查，而通知从不提供续做操作。

收手让手动停止在任务登记表上多了一个持久效果：尝试任务以 `cancelled` 结束，而不是等待一条永远不会到来的指令。它已花费的预算仍然算作已花费，因此之后的手动继续是一次新的登记，而不是第二次自动尝试。

CLI 的退出码 5 是接收方流程的新契约；退出码 1 仍表示请求本身失败，3 与 4 的含义不变。`send`、`steer-queued`、队列投影、唤醒传输，以及 Git Bash、WSL、侧边栏与打包相关的工作都没有改变。

## Testing

`packages/api/task-feedback/tests/task-feedback.recovery-diagnostics.host.spec.ts` 跑真实的会话日志、投影、存储与服务，只把提示面与 Agent 注册表的 Inbox 替换为替身。它覆盖：泄漏语法的完成在实时与从恢复历史读出两种情形下（状态、标记族、摘要、载荷、唤醒消息与 `not-applicable` 回答）；普通完成、较早步骤的引用、思考块与更早轮次都不被标记；SSE `STREAM_CLOSED` 失败保留自己的消息、轮次与证据，同时 `resumeFailed` 拒绝它；reasoning_text 预算报告带已用与配置数量的 `budget-exhausted`，并在重放中保持有界；手动继续报告 `superseded`，仍在运行的手动继续报告 `running`，两者都不提交任何内容；操作者停止报告带原因的 `cancelled`；已排队的自动续做在该停止时被撤回并在重放时被拒绝；已被认领的续做仍由它自己的中止轮次结算；非所有者消费者无法消费当前代次的领取。

`apps/desktop/tests/opl-control.spec.ts` 让打包后的 CLI 对着脚本化的 loopback 端点运行，断言 `budget-exhausted`、`superseded` 与 `not-applicable` 以退出码 5 结束并把原因打到 stderr，`resumed` 以退出码 0 结束，服务器拒绝以退出码 1 结束。
