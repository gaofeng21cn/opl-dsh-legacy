# Agent Note: Conversation-turn rewind

Status: implemented

[English](2026-09-24-conversation-turn-rewind.md) | 中文

## Problem

从产品界面看，发送提示词是不可逆的。编辑并重发只重写最后一条提示词却保留它开启的轮次，fork 则把回退后的状态放进一个新的子 Session，两者都不能恢复用户发送前的这段对话。误发一条提示词、或看到某一轮产生了想要撤回的改动时，用户没有回到当前 Session 发送前状态的办法。

"恢复环境"不可能指一轮的全部副作用。模型通过工具写入的文件、网络调用、外部服务、后台任务与终端都不在 Session 日志能逆转的范围内，靠文本或修改时间猜测只会静默破坏无关的工作。可达且可验证的部分，是 harness 已经持久拥有的状态：模型可见的对话 surface、待处理的 agent inbox，以及客户端的输入框草稿。

## Decision

`session.rewind({ sessionId, seq })` 把对话回退到指定真人提示词之前的状态。Host 追加一条空的 `system/message`——`createSystemMessage('', REWIND_SURFACE_PLUGIN)`——携带 `surfaceOp: { op: 'replace', startSeq: prompt.seq, endSeq: surfaceTail }` 与 `sourceEventSeqs`，引用每一个被遮蔽节点，形状与 compaction、编辑并重发完全一致。由于空的 system 节点不派生任何模型消息，下一次请求看到的就是提示词之前的历史，而被遮蔽的事件全部留在 append-only 日志中。分支范围本身就承载在 replacement 上作为回退元数据，因此不涉及新事件类型、不需要重新生成事件目录、也不触发 `SESSION_FORMAT_VERSION` 之类的版本变更。

`@deepseek-ai/dsh-session/surface` 中的 `isRewindSurfaceEvent` 是这个约定的唯一共享判定，Host 命令与浏览器 Chat 折叠都从它导入。早于回退能力的构建仍会把这样的日志折叠成同样的模型历史——空节点不派生消息——只是失去标记的标签。

命令在五种情况下拒绝且不改变任何状态，以 `session/rewind-unavailable` 加稳定的 `reason` 上报：指定 seq 不是最后一条真人提示词（`not-last`）、Session 没有真人提示词（`no-user-message`）、已归档（`archived`）、有轮次正在运行（`busy`）、或最后一轮从未结束（`turn-open`）。幂等以被指定的提示词为准，而不是客户端铸造的 request id："这条提示词已离开 surface"是提示词本身的函数，因此首次已生效的重试会返回已提交的 replacement 且不再追加。这次读取使用 controller 既有的异步 Session 读取（`readSessionState`），而不是已弃用的同步日志读取接口。

被回退的提示词或其轮次准入的待处理 inbox 工作会被丢弃，判定依据是 seq 不早于该提示词的持久 `agent/inbox/spliced` 记录。即使落在这个窗口内，真人提示词仍然保留：那是用户键入的输入，回退不得破坏它。todo、goal、plan、permission、schedule 与 subagent 状态不回退，任何外部副作用也不回退：重写后的对话，加上[工作区文件回退](2026-09-24-workspace-file-rewind.zh.md)新增的工作区文件，就是该命令所声明范围的边界。

在浏览器中，最后一条真人提示词在编辑操作旁带有回退操作，二者由同一个 owner 事实（`!running && editablePromptSeq === row.seq`）把关。replacement 呈现为一行回退标记，并通过既有的 `SupersededBranchFilter` 声明被遮蔽的分支，因此被移除的行与该轮次的轨道刻度像提示词重写一样离开当前 transcript 代际。接受后，客户端仅在草稿仍为空时把提示词文本放回输入框；此后键入的草稿是更新的输入。

## Alternatives considered

**新增 `session/rewind` 事件类型加一次 replacement。** 两次追加无法原子化，中间崩溃会留下一条没有 surface 效果的回退记录；而且为了一个 replacement 已经承载的记录，还要重新生成 `KNOWN_SESSION_EVENT_TYPES` 与持久化目录。

**用带摘要文本的 `system/message` 作为标记。** 它会作为 system 消息进入模型历史，并可能被 in-history 路由误认为提示词更新；空节点已经是文档化的"不派生消息"形态。

**把 inbox 精确回滚到提示词之前的内容。** 重新插入已被领取的提示词会立刻重跑用户刚撤销的那一轮；丢弃此后所有条目又会删掉用户键入的提示词。只丢弃该轮产生的、非真人来源的工作是安全子集。

**逆转工具副作用。** 当时拒绝，因为不存在任何关于某一轮写入的持久记录，而基于文本或 mtime 的重建是把猜测当作恢复来呈现。工作区文件 journal 后来为会话工作区内的文件提供了这份记录；provider 文本、服务器与终端仍在其外（[工作区文件回退](2026-09-24-workspace-file-rewind.zh.md)）。

**回退成功后用 `not-last` 拒绝重试。** 客户端无法区分"确认丢失"与"请求过期"，已生效的回退会被呈现为失败。以 seq 为键的幂等判定消除了这类假失败。

## Consequences

模型可见效果恰好是提示词之前的前缀，因此幸存历史的 KV cache 前缀仍可复用，被移除的分支不可复用。被回退的 Session 保留全部事件，重新打开、fork 或搜索仍能读到被移除的轮次；整日志投影（stats、turn outline、token 用量）仍会计数它——这与提示词重写代际已经记录的局限相同。

`packages/api/session-controller/tests/commands-rewind.host.spec.ts` 覆盖被接受的回退及其 surface 范围、幂等重试、五种拒绝且日志不变、队列规则的两个方向，以及非法 seq。`packages/core/session/tests/surface.spec.ts` 钉住标记判定与"不派生消息"的折叠结果。`packages/client/ui-chat/tests/user-prompt-rewind.client.spec.tsx` 覆盖行内操作与本地化拒绝文案，`tests/edit-resend-visibility.client.spec.ts` 覆盖标记行与被隐藏的分支（重放与实时到达两种路径），`tests/apply-inject.client.spec.tsx` 覆盖 inject 回调的草稿恢复与逐字拒绝映射。`tests/session.client.spec.ts` 覆盖客户端对象层。

按设计不回退的内容：外部副作用、后台任务与终端、todo／goal／plan／permission／schedule／subagent 状态，以及其他任何 Session 的状态。工作区文件由[工作区文件 journal](2026-09-24-workspace-file-rewind.zh.md) 单独还原它记录到的一切，无法证明可还原时它会拒绝整次回退。回退一轮已经产生这类效果的对话时，只报告对话层面的回滚。
