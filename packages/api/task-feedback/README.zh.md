---
description: "把派发出的任务登记到真正执行它的 DSH 会话上，并将结果持久交接给派活方会话——供接线控制面的维护者与读取契约的派活方使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-api-task-feedback

[English](README.md) | 中文

## 概述

跟踪派发的 DSH 任务，并向调用会话发送有界的结果通知。持久化任务与回执记录防止重复领取审查，并支持接收方恢复。审批和问题通知保留用户决策；有界恢复仅适用于已定义的思考回放故障。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发说明](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

`dsh-api-task-feedback` 以调用方自铸的 id 记录一个已派发任务，在无任何模型参与的前提下监听绑定的 DSH 会话，并为每次"应通知"的状态变化向派活方会话排入一条有界通知。默认只通知 `completed`、`failed`、`waiting_approval`、`waiting_input`，因此纯进度的 `running` 迁移绝不会唤醒审查方的付费模型。投递是自动的：已结算的任务、或因审批/提问而暂停的任务，都由服务自身的调度器交给唤醒传输，因此从不轮询的派活方也能得知结果。领取带有持久的所有者、代次与租约，因此重复通知不会开启第二次审查，崩溃接收方的领取会被后来的接收方回收。被记录为精确 reasoning_text 协议错误的失败，最多获得配置数量的有界自动续做，每次都是在原会话中提交的一条持久用户指令。循环记为 `completed` 的轮次，若其最终可见正文仍带有工具调用标记，则报告为 completed，并把 `leakedToolSyntax` 记为发现的标记族、摘要说明结果未经验证，因此派活方不会把未执行的工具语法读成业务成功；该结果不具备自动续做资格。暂停通知是结构化的，而非一个裸状态：它携带经有界处理的问题正文与所给选项，或审批及其工具，并带上答案所属的会话，因此派活方会把问题转达给操作者，而不是自己猜一个答案或恢复该会话。需要闭合派活回路时选它：调用方登记 `{taskId, sessionId, turn, target, acceptance}`，服务报告 `queued`、`accepted`、`running`、`waiting_approval`、`waiting_input`、`completed`、`failed`、`cancelled`、`disconnected`，由 outbox 投递结果，再由接收方自己的持久台账让已重复入队的消息成为空操作。

Host 必须组合 `sessionProjections`。`taskFeedbackFacts` 投影从已提交事件重建恢复指令所属轮次与最终可见文本中的工具语法诊断，并随事件增量维护；任务恢复不再同步扫描 Session 历史。

在真正运行被派发会话的 Host 上挂载它；桌面控制桥把它暴露为 `taskFeedback` 命名空间。

### 何时选它

当外部派活方必须知道 DSH 任务已结束、又不愿轮询会话、也不愿唤醒模型去盯着时使用。一次性 `session.wait` 调用即可满足的场景不必用它——那种调用已经能把同样的持久事实报告给愿意阻塞的调用方。

### 最小可用配置

```yaml
- name: '@deepseek-ai/dsh-api-task-feedback'
```

登记任务，再读回来：

```json
{ "namespace": "taskFeedback", "method": "register", "args": { "request": {
  "taskId": "review-42",
  "sessionId": "session-abc",
  "turn": 1,
  "target": { "kind": "codex-thread", "threadId": "<caller-supplied>" },
  "acceptance": "the reviewer checks the recorded evidence"
} } }
```

| 方法 | 含义 |
|---|---|
| `register` | 把任务持久绑定到会话、轮次、目标与验收标准。以 `taskId` 幂等。 |
| `task` / `tasks` | 读取单个或全部任务。 |
| `outbox` | 读取全部已排队、已送达、已确认或已退役的通知，并含 needs-input 投递宣告的有界暂停。 |
| `wake` | 探测配置的唤醒可执行文件能否启动，并报告观测到的事实。 |
| `ack` | 记录接收会话自报的投递阶段：`received`，随后 `review-started`。按 `deliveryId` 幂等；重复或更旧的确认绝不会让阶段倒退。 |
| `receive` | 领取一条投递以供审查。首次领取答 `review`，仍拥有未完成领取的消费者答 `resume`，其他消费者在所有者租约仍有效时答 `busy`，已消费答 `skip`。 |
| `receipts` | 列出接收方的消费台账，使重启后能发现仍欠的领取。 |
| `consume` | 审查结束后，带上领取时得到的 `claimEpoch` 把投递标记为已消费。只有它能让重复消息答 `skip`，且过期代次会被拒绝。 |
| `resumeFailed` | 针对 reasoning_text 协议错误的确定性有界自动续做操作：以接收方的 consumer 身份领取投递、确认失败轮次仍是目标，并提交一条持久续做指令或报告为何不提交。 |
| `flush` | 先等待监听器的写入落定，再对每条到期投递尝试一次。 |

投递阶段是彼此独立的事实，而非一根进度条：`enqueued` 表示本地已持久、`delivered` 表示传输层已接手、`received` 表示目标已确认收到、`review-started` 表示目标自报已开始后续轮次。后两者只能由接收会话推进；发送方从不写入它们，传输层的接受最多只到 `delivered`。投递阶段不等于消费：接收方另有一张 `receipts` 台账记录自己的领取，正是它让重复消息不会开启第二次审查。

### 收件与消费

通知包含任务、投递、会话、轮次、验收标准与证据位置，其中 `delivery:` 行就是接收方的幂等键。传输仍可能产生重复消息，因此接收方先领取投递、再开始审查，审查结束后记录消费：

1. `receive <taskId> <deliveryId> [--consumer ID]` —— 领取投递。返回的 `action` 就是接收方需要的全部决定：首次领取是 `review`，仍拥有未完成领取的消费者是 `resume`，其他消费者在所有者租约仍有效时是 `busy`（此消息不得开始工作），审查已完成则是 `skip`。
2. 完成审查，然后 `consume <taskId> <deliveryId> --epoch <claimEpoch>` —— 记录审查已结束。只有消费才让之后的消息答 `skip`；被新所有者回收的代次会被拒绝。

领取在 `receive` 作答前已持久，并带上所有者、代次与租约。重复、并发或重放的消息都无法开启第二次审查：所有者租约仍有效时到来的其他消费者得到 `busy`，所有者自己得到 `resume`。传入稳定的 `--consumer` id 才能让重启后的接收方立刻恢复自己的领取；没有身份的消费者则要等租约过期。租约过期的领取会以新代次被回收，旧所有者的 `consume` 随即被拒绝，因此崩溃的审查能被接管而不会与仍在工作的接收方相撞。重启后的接收方运行 `receipts`，并恢复每一条状态不是 `consumed` 的条目；这条未完成的领取就是恢复点，因为 `receive` 已经确认过该投递，发送方不会再发。这次恢复由接收方——而非发送方——负责。

### 转达会话等待中的暂停

`waiting_input` 或 `waiting_approval` 通知是转达请求，而不是作答请求。其载荷携带 `needsInput`：`kind`（`question` 或 `approval`）、持有该暂停的 DSH `sessionId` 及其 `turn` 与日志游标、同时也是投递 id 后缀的稳定 `pauseId`、经有界处理的 `questions` 及其选项与 `multiSelect`，或带 id 与工具的 `approval`。未被唤醒的派活方通过控制面找到同一条目：

```sh
opl-dsh-control.cmd outbox --thread <its own thread id> --pending
```

每个条目都点明其 `deliveryId`、目标、阶段与载荷。派活方随后执行与结果通知相同的 `receive` 与 `consume` 调用，并把问题交给自己的操作者：答案属于通知点名的那个会话，该会话会继续等待它的人类。本服务从不提交答案、从不替人决定审批，`resumeFailed` 对 needs-input 投递回答 `not-applicable`，因此这里的任何接口都无法把一个问题变成提示词。问题正文、选项标签与工具名都会被压平为一行，并分别受 `needsInputMaxChars`、`needsInputMaxQuestions`、`needsInputMaxOptions` 限制；每一项都作为不可信结果数据引用，因为它是调用方写的、而接收方模型会读它。

当失败通知带有 `resumeEligible` 时，该失败就是无法按原请求重试的 reasoning_text 协议错误。接收方执行一个确定性操作，而不是自己拼装重试：

```sh
opl-dsh-control.cmd resume-failed <taskId> <deliveryId> [--consumer ID]
```

`resumeFailed` 以接收方在 `receive` 时使用的同一稳定 consumer id 领取投递；若本次调用省略该 id，则延续该投递上已记录的领取，因此先执行通知里的 `receive` 再执行 `resume-failed` 不会因新铸身份而被自己挡住。它随后确认失败轮次仍是目标（未在运行、没有更新的消息或轮次、目标未变），然后要么在原会话提交一条持久用户指令，要么报告 `not-applicable`、`superseded`、`running`、`busy` 或 `budget-exhausted`。它会登记一个与原任务共享续做预算的后续任务，并在新轮次完成、再次失败或暂停时通知原 Codex 目标。指令带确定性 request id，因此重复通知或崩溃重放提交的是同一条指令，而不会多开一次尝试。已准入但未观测到提交的尝试在再次提交前会重新执行取代检查，因此操作者手动继续之后的重放不会追加过时的续做指令，也不会留下把该手动轮次当成自动续做的后续任务；而指令已记录在会话日志或其活动 inbox 中的尝试会直接幂等重放，从而恢复"提交成功但 receipt 标记写入失败"的情况。尚未被任何轮次认领的已排队指令，会在操作者停止会话时被撤回（`stop` 是保留 inbox 的取消），因为保留它会让操作者的下一轮以过时的自动续做开头；随后该尝试任务被报告为 `cancelled`，摘要点名这次撤回，准入与已花费的预算仍留在台账上，之后的 `resumeFailed` 会针对已停止的会话重新校验并报告 `superseded`，而不是再准入一次尝试。准入还会持久化提交该指令时的游标与结束轮次基线，后续任务绑定的是消费了它自己那条指令的轮次，而不是最后结束的那个轮次。登记时未绑定轮次（因指令在任何轮次认领之前就被记录而呈现为 accepted 且 `turn: null`）的尝试任务，会在会话随后恢复时按会话已记录的指令重新绑定，且两种附着顺序都成立：会话已附着时由服务自身的恢复遍历处理，会话稍后才附着时由 `session/created` 补偿处理。因此登记晚于该轮次时——后续写入失败或进程重启——会依据会话自身已记录的事实结算：已完成、已再次失败、已暂停等待审批或仍在运行的续做轮次都会被如实报告，而不是继续等待一个已经发生的事件；其后发生的人工轮次也绝不会被当成续做结果。旧的 `failed` 记录绝不被改写；后续尝试是独立记录并带父级关联。预算耗尽时要告知你的操作者；其他错误一律走正常审查，绝不自动续做。

运行在桌面 Host 上的接收方通过已鉴权控制桥：

```sh
opl-dsh-control.cmd outbox --thread codex-thread-1 --pending
opl-dsh-control.cmd receive <taskId> <deliveryId> --consumer codex-thread-1
opl-dsh-control.cmd receipts
opl-dsh-control.cmd consume <taskId> <deliveryId> --epoch 1
opl-dsh-control.cmd resume-failed <taskId> <deliveryId> --consumer codex-thread-1
```

当服务给出的决定不是 `resumed`（`not-applicable`、`superseded`、`running`、`budget-exhausted`、`busy` 或 `consumed`）时，`resume-failed` 以退出码 5 结束，并把该决定与原因打到 stderr，因此只看退出状态的调用方不会把"收手"读成一次恢复；这些答案都是终局，重跑该命令不会改变它们。其他位置的接收方用同一 bearer token 把同样的调用 POST 到控制桥端点，或经远程接口调用 `taskFeedback` 的这些方法。`ack` 仍是更底层的投递阶段记录（`received`，随后 `review-started`），并会同步维护 receipt 台账；它不能替代 `receive`——后者才决定审查是否运行。把消息入队不是回执，传输层接受移交也不是。带所有者的领取能让重复审查请求幂等，并支持恢复中断的审查；由于传输无法保证 exactly-once，系统不承诺通知恰好送达一次。

自动续做预算由接收方自己的 receipt 台账计数，而不是另写一份。每条被准入的失败投递恰好写入一条 receipt 记录，任务上报告的计数由这些记录派生，因此任务记录写入丢失或重启都不会让同一次尝试重复占用预算，也不会让重放再次占用。台账以原始派发任务为键，而不是某条投递或某个重试 id；以新 task id 登记的重试传入 `parentTaskId` 或 `rootTaskId`，从而共享同一份预算。默认每个原始任务两次续做；`maxAutoResumes: 0` 完全关闭自动续做。

### 投递调度

服务自行调度投递。每条新入队通知只武装一个唤醒点；被拒的尝试按封顶指数退避重试；任意时刻最多只有一个唤醒点与一个投递 pass，且该 pass 会先等待监听器的写入再读取 outbox。传输成功接收入队后，发送方停止重试：在目标队列中等待的同一条通知若再次入队，只会产生重复唤醒。重启只重试被传输拒绝的通知；也会为尚未落盘通知的应通知状态补入队，从而修复任务写入与 outbox 写入之间的崩溃。接收方一经领取，其 receipts 台账而非发送方 outbox 会告诉重启后的接收方仍欠什么。没有任何会话监听器阻塞在投递上，整条回路也不发起任何模型请求。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `autoDeliver` | `true` | 服务是否自行调度投递。关闭后由部署自有的调度器通过 `flush` 驱动 outbox。 |
| `maxDeliveryAttempts` | `5` | 单条投递在被停止调度前的最大尝试次数；耗尽的投递保持待发且未确认。 |
| `retryBaseMs` / `retryMaxMs` | `1,000` / `60,000` | 封顶指数退避的基数与上限。 |
| `summaryMaxChars` | `500` | 单条通知摘要行的长度上限。 |
| `notifyStates` | `completed`、`failed`、`waiting_approval`、`waiting_input` | 会产生通知的任务状态。`queued`、`accepted`、`running`、`cancelled`、`disconnected` 只被观测，除非部署显式加入，否则不通知。 |
| `maxAutoResumes` | `2` | 一个原始派发任务最多提交的自动续做次数。计数由持久 receipt 台账派生，因此重启或以新 id 重试都不能重置。`0` 关闭自动续做。 |
| `claimLeaseMs` | `600,000` | 接收方的领取在其他消费者可回收未完成审查前保持有效的时长。以同一身份再次出现的消费者无需回收。 |
| `needsInputMaxChars` | `500` | 一条 needs-input 通知所携带的单个问题、选项标签、选项描述或工具名的长度上限；更长的文本以 `…` 截断。 |
| `needsInputMaxQuestions` | `8` | 一条 needs-input 通知所携带的问题数量上限。 |
| `needsInputMaxOptions` | `12` | 单个问题可携带的选项数量上限。 |

`flush` 仍可供需要按需尝试 outbox 的调用方使用；它与调度器共用同一条 pass 链，因此显式 flush 绝不会与调度器同时发送同一条投递。

### 唤醒传输

出厂默认是 `unconnected`：它拒绝一切投递，`wake()` 报告缺失能力，因此没有部署会默默声称已唤醒会话。能触达目标的部署显式配置传输；这里不读取机器环境，也不假设任何发行版或安装路径。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `wakeTransport` | `unconnected` | `unconnected` 拒绝一切投递；`codex-queue` 执行 `codex queue --thread … --message …`。 |
| `wakeExecution` | `native` | `native` 直接启动可执行文件；`wsl` 通过 `wsl -d <distro> -- <executable>` 启动。 |
| `wakeExecutable` | 空 | Codex 可执行文件的绝对路径或 `PATH` 名称。`codex-queue` 必填。 |
| `wakeDistro` | 空 | 可执行文件所在的 WSL 发行版。`wakeExecution: wsl` 必填，其他情况会被拒绝。 |

`codex-queue` 传输以参数数组运行（绝不拼 shell 字符串），带 `windowsHide`、有界超时，并在超时或卸载时取消；无法启动、非零退出或超时的进程会被如实报告，绝不当作已投递。`wake()` 用同一条入口、同样的界运行 `codex --version`，在可执行文件确实运行时报告 `executable-started`。该探测只证明入口能启动，仅此而已：它无法表明目标线程存在，也无法表明入队消息能触达它，因此本接口故意不报告 `connected` 状态。

```yaml
- name: '@deepseek-ai/dsh-api-task-feedback'
  config:
    wakeTransport: codex-queue
    wakeExecution: wsl
    wakeExecutable: /home/<user>/.local/bin/codex
    wakeDistro: <distro>
```

### 任务状态的含义

监听器只读会话自身的持久事件。已登记进程退出不算完成；Host 已无法观测的会话记为 `disconnected`——任务保留位置，既不被取消也不被重派。`waiting_approval` 与 `waiting_input` 报告暂停；本服务从不替人作答，因此被派发任务仍等待它的人类。暂停通知携带经有界处理的问题与选项，或审批及其工具，外加答案所属的会话、轮次与游标，其 `answer location:` 与 `do not answer:` 两行要求接收方转达；同一条通知随任务记录一并持久化，因此在任务写入与 outbox 写入之间崩溃后重建的投递仍携带它。`completed` 记录的 `leakedToolSyntax` 非空时，该完成声明不被正文支持：该轮最后一条 assistant 消息带有未被执行的工具调用标记，因此状态仍只是循环自己的事实，而字段、摘要与通知里的 `attention:` 行都说明业务结果未经验证。默认只有 `notifyStates` 里的四个状态会唤醒审查方；部署可以加入其余状态，但 `running` 通知会用一次付费模型轮次去播报进度，这正是它默认关闭的原因。同一日志游标处两次不同的审批或提问会产生两条通知，因为等待类投递的身份是稳定的暂停键；同一请求的重放或同一暂停的重复事件不产生任何通知。恢复会按轮次号匹配具名轮次、按游标匹配未具名轮次，因此登记之前就已结束的轮次无法结算任务；本 Host 启动之后才恢复的会话在附着时补偿，因为带 seed 的会话不会为其载入的历史逐条发布事件。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

- 登记表、outbox 与接收方台账是 `task_feedback` 存储域的三张表，分别以任务 id 与投递 id 为键。投递 id 对 (任务, 状态) 稳定；等待类投递还带上其稳定的暂停键（审批为决定事件位置，结构化提问为游标加所问问题 id），重放请求因此是空操作，而两次不同的暂停仍彼此独立。
- 监听器是一个 `session/event` 订阅，外加一个始终 `next()` 的 `user-questions/request` 透传监听器，因此组合该部署的既有应答者仍能收到问题。全过程无轮询、无模型轮次。
- `fromSeq` 是该任务观测的第一个日志位置（含端点）；登记时默认取会话的下一个序号。
- 在本 Host 恢复之后才附着的会话会在其 `session/created` 边上补偿，因为带 seed 的会话不会为其载入的历史逐条发布事件。具名轮次按轮次号匹配；未具名轮次忽略登记时已在日志上的那次结束，旧轮次因此无法结算它。
- 接收方的 `receipts` 表是独立于 outbox 的消费台账：`receive` 领取并回答审查、恢复、跳过还是忙碌；`consume` 结束领取；`receipts` 列出重启后的接收方仍欠什么。receipt 带 `ownerId`、`claimEpoch` 与 `leaseExpiresAt`；回收过期或无主的领取会提升代次，`consume` 会拒绝调用方已不再持有的代次。发送方在传输接收入队时就停止重试；领取另行把投递记为 `received`。
- 合格失败的准入也记在 receipt 上：`resumeAttempt`、`resumeRootTaskId`、`resumeRequestId`、`resumeTaskId`、`resumeFromSeq`、`resumeLastEndTurnAtRegistration` 与 `resumeSubmitted`。receipt 写入是唯一的准入提交点，也是预算条目；`resumeRootTaskId` 让服务能按原始任务统计准入数，而任务记录上的 `autoResumeCount` 只是该台账的派生缓存。后续任务带上指令身份（`resumeRequestId`），并在会话记录该指令后带上其日志位置（`resumeInstructionSeq`）：该指令出现之前任何轮次都不得结算该任务；而任何轮次认领之前就已记录的指令，由其后第一个结束的轮次结算。手动停止时撤回已排队指令会清空 `resumeSubmitted`，同时保留 `resumeAttempt` 与 `resumeRootTaskId`，因此该尝试仍占用预算，但重放无法再把自己呈现为已观测到的提交。
- `settled()` 是监听器异步写入的静默点；`idle()` 是投递泵的静默点；`flush()` 先等前者，再串到后者之后。
- 调度器最多只持有一个已武装的唤醒点（更近的截止时间会替换更晚的），并对定时器 unref，因此待重试不会让进程保持存活。卸载会取消唤醒点并等待已在运行的 pass。
- 终态只写一次。重放或重复的 `turn/end` 无法改写已记录的结果。
- 仅重试被传输拒绝的发送，并使用封顶指数退避和次数上限。被传输接收或已耗尽重试次数的投递仍保持待处理、未确认，不会被静默丢弃；传输接收只表示已入队，不表示目标已收到。
- 恢复会为缺失投递的应通知状态补入队，从而修复任务写入与 outbox 写入之间的崩溃。
- 升级会退役当前 `notifyStates` 不再包含的待发投递，因此旧版本入队的 `running` 条目不会被重投。退役只置 `retired` 而保持 `acknowledged` 为假，绝不报告为已收到。
- 目标会话只能通过已安装的 `WakeAdapter` 唤醒。出厂默认适配器拒绝一切投递并探测出 `not-connected`，绝不声称通道已连通；见下方限制。

</details>

<a id="model-experience"></a>
## 模型体验

### 任务结果通知

#### 模型看到什么

服务观察 `turn/end` 及相关会话状态，本身不添加提示词。配置的唤醒传输可以把有界且不受信任的任务摘要交给调用方。

#### Token 影响

服务不调用模型。只有选择处理通知的接收方才会发起模型轮次；默认不通知仅有进度变化的状态。

#### KV Cache 影响

不直接改变缓存。接收会话通过自己的正常消息路径追加已接受的通知。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- **Codex 投递需要显式的传输配置。** 任何默认值都无法猜出某台机器的 Codex 安装位置：出厂默认是 `unconnected`，部署需为自己的机器设置 `wakeTransport`、`wakeExecution`、`wakeExecutable`、`wakeDistro`。适配器以有界的 `codex queue --thread` 参数数组运行；可执行文件无法启动或队列拒绝通知时，outbox 保留该投递并按有界策略重试。队列成功接收不代表目标已收到，但发送方不会重试成功入队的通知，以免重复追加；接收方从持久化的 receipts 台账恢复中断的审查。
- **`wake()` 探测不是连接。** 该探测运行 `codex --version`，所以 `executable-started` 只表示配置的可执行文件启动过。它无法表明目标线程存在，也无法表明入队消息能触达它，调用方不得把它读作已连通的投递通道。
- **消费由接收方拥有。** 没有任何发送方代码写入 `received`、`review-started` 或 receipt；接收方用 `receive` 领取、用 `consume` 结束。传输层入队或 `wake()` 探测绝不会被报告为已开始审查。
- **`received` 之后中断的接收方从自己的台账恢复，凭自身身份或等租约到期。** 领取会停止发送方的重试，因此审查中断后的恢复取决于接收方运行 `receipts` 并恢复每一条不是 `consumed` 的条目。传入稳定 consumer id 的接收方拥有自己的上一次领取，可立即恢复；其他消费者必须等 `claimLeaseMs` 过期才能接管，而被回收的代次正是阻止旧所有者继续完成它的机制。这次查询就是已记录的故障边界；从不运行它的接收方会把自己的审查一直挂着。
- **自动续做有界且条件精确。** 只有 `turn/end` 失败的结构化 `LlmFailure` 是 HTTP 400 invalid request、且明确说明 reasoning_text must be passed back 时才算合格；仅仅提到该 token 的文本不算。每个原始任务最多执行 `maxAutoResumes`（默认两次）次续做，计数由持久 receipt 台账派生并被重试共享，预算耗尽会带着已用与配置的数量报告为 `budget-exhausted`，而不是继续重试；记录结果为未经验证的工具语法泄漏的轮次绝不自动续做：标记检查只设置 `leakedToolSyntax`，对它发起的恢复请求回答 `not-applicable`。续做轮次保持会话原有的模型选择与思考状态，不伪造思考、不删除历史、不重新执行已提交的工具。
- 成功入队的通知只发送一次；只有传输明确拒绝时才重试。收到确认与开始审查仍由接收方负责；审查中断后从 receipt 台账恢复，不靠发送方再次投递。这里不承诺 exactly-once。
- 跨 Windows native/WSL 协调不在本批范围。服务运行在 Windows 原生 Host；WSL 接收方按自身网络提供的路径访问已鉴权 loopback 控制桥，该路径是部署侧问题。
- 不发布 invariant 伴生包，因为本包不拥有任何可被独立观测撕裂的关系：其表只由一个服务写入，其状态迁移派生自拥有它们的会话日志。

<a id="dev-note"></a>
### 开发备注

`tests/task-feedback.host.spec.ts` 驱动真实的会话日志、投影注册表、存储域与一个模拟接收会话，全程无模型、无 key、无网络；它覆盖通知策略、恢复（含服务恢复之后才附着的会话、登记之前就已结束的轮次、以及 outbox 写入未落盘的通知）、消费台账（重复消息、确认丢失、跨重启的中断领取、并发领取、租约到期后的接管、过期所有者被拒）与有界自动续做（精确 reasoning_text 条件及其近似反例、被更新的轮次/消息/取消取代、通知在同一 consumer 身份下的"先领取后恢复"协议、手动轮次后拒绝过时的已准入续做、两次续做写入边界与重启下同一次准入只计一次、重试血缘、崩溃后的提交重放、以及续做轮次的反馈）。`tests/task-feedback.controller.host.spec.ts` 让同一续做流程跑在生产 `SessionCommandController` 的 prompt 路径上，搭配真实 Agent 注册表、会话日志与 Inbox，仅替换外部模型选择与传输，覆盖提交重放、手动轮次后收手、以及"指令已入队但 receipt 标记写入丢失"的恢复。`tests/task-feedback.recovery-diagnostics.host.spec.ts` 钉住结果边界：最终正文带 DSML/工具标记的已完成轮次（实时与从恢复历史读出）报告为未经验证，而普通完成、较早步骤的引用、思考块与更早轮次都不被标记；未以 `[DONE]` 结束的 SSE 流保留自己的失败原因且被 `resumeFailed` 拒绝；reasoning_text 预算报告 `budget-exhausted`；手动继续报告 `superseded` 或 `running` 且不追加任何内容；手动停止撤回已排队的自动续做并把该尝试报告为 `cancelled`；非所有者消费者无法消费当前代次的领取。`tests/task-feedback.resume-tracking.host.spec.ts` 保留延迟登记回归：后续任务写入丢失，等到重放登记该任务时续做轮次已完成、已再次失败、已暂停等待审批或仍在运行，或其后已有一个人工轮次结束；每个用例都断言绑定本身，最后结束的轮次无法冒充续做结果。它还保留基于持久 JSON 根目录的冷恢复回归：登记时未绑定轮次的尝试任务，在服务先于保存的会话恢复时、以及在服务恢复时会话已附着时，都会从恢复的历史中补绑定；覆盖其后的人工轮次、仍在运行的续做轮次，以及第二次恢复不得重复通知。`tests/task-feedback.loop.host.spec.ts` 让同一流程跑在真实 Agent loop 上：生产 `SessionCommandController` 把指令排入真实 Inbox，真实轮次认领并记录它，循环把它跑到结束，延迟登记仍绑定该轮次；只替换模型传输。`tests/independent-review.host.spec.ts` 保留并发与确认竞态回归。`tests/wake.host.spec.ts` 用真实 Node 可执行文件运行有界进程执行器与参数数组。`tests/task-feedback.loader.spec.ts` 通过 Loader 与 Include、基于真实存储、会话与投影提供者启动真实插件，并覆盖"保存的会话在服务恢复之后才附着"的重启顺序。
