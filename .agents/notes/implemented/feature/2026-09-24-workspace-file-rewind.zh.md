# Agent Note: Workspace file rewind

Status: implemented

[English](2026-09-24-workspace-file-rewind.md) | 中文

## Problem

对话按轮回退恢复了对话记录，也如实说明了边界：某一轮写过的文件仍然保持改动。于是回退最常见的动机——某一轮改错了东西——只被回答了一半，而先前那条 note 把这个缺口记为明确边界，而不是缺陷。

补上它需要 harness 此前没有的一样东西：一份持久、可重放的「某一轮写了什么」记录。有两个约束决定了这份记录该怎么取。

写入通过两个边界抵达工作区。Harness 自身发起的文本改动都经过 `ctx.fs.writeText`/`editText`（即 `write`、`edit`、`str_replace_editor` 工具），因此文件系统 seam 能看到。而通过 `ctx.shell`（`bash`、`pwsh`、`run_code`、终端）运行的命令是不透明进程，可以在不回调 harness 的情况下创建、修改、删除或重命名工作区里任意文件。没有任何东西观察这些写入，本部署中也没有可用的操作系统快照。

而且回退绝不能是猜测。靠修改时间推断「这个文件看起来是这一轮改的」，会删除或回退该轮从未碰过的工作，这比不还原更糟。

## Decision

新增 host 包 `@deepseek-ai/dsh-session-rewind-files`：在一轮中第一次派发工具**之前**采集会话工作区的有界内容基线，并在该轮此后每次执行之后追加一条 log-only 的 `file/change` 事件。`session.rewind` 在追加自己的 replacement 之前先通过 journal 还原该轮的文件；无法证明可还原时一律拒绝，且不改动任何东西。

**基线先于写入，正是不透明进程可恢复的原因。** 记录器是一个 `tools/execute` 监听器：只有这个 seam 同时携带调用方的 agent 身份与一次执行的完整时长。委派之前它确保该轮已有基线；在 `finally` 中它与 journal 的已知状态做差异比较。差异比较找出不透明命令移动了什么，而基线仍持有那些路径在它运行之前的字节。无需拦截进程本身，这也是本插件从未听说过的工具同样被覆盖的原因：基线对**任何**工具派发都采集，而不是针对一份声明的写入者名单。

**基线在该轮第一次派发工具时采集，而不是在 `turn/start`。** 因此纯对话的一轮完全不追加事件，已有录像会话及其夹具的事件流保持不变；而派发过至少一次工具的一轮必然有基线，于是「缺少基线」本身即是 journal 出现缺口的证据，而不是清白的证据。没有派发任何工具的一轮不还原任何东西，这是空操作，不是拒绝。

**内容只寻址，不解码。** blob 以其精确字节的小写十六进制 SHA-256 命名，因此跨轮次、跨会话的相同内容在 `$DSH_HOME/rewind-files` 下只存一份，还原可以证明取回的正是当初记录的内容，二进制内容按字节原样往返。单文件（`maxFileBytes`）、条目数（`maxEntries`）与总字节（`maxCheckpointBytes`）上限都是经过校验的 `Config` 字段；超过单文件上限的文件会被记录为「存在但不可验证」，从而拒绝该轮，而不是绕过它做部分还原。

**路径按构造即限定在工作区内。** 遍历只从规范化的工作区根向下进行，从不跟随符号链接，产出以 `/` 分隔的相对路径；还原时会在触碰文件系统之前把每个相对路径重新解析到该根目录之内，并拒绝任何绝对路径、盘符或 `..` 段。工作区之外的写入是「被检测到」而非「被撤销」：文件系统 intent waterfall 在改动前给出目标，`fs/observed` 确认改动落地，因此被确认落在根目录之外的目标会记录 `file-outside-workspace` 并拒绝该轮。

**还原在第一个 replacement 之前验证整个计划。** 每条被记录的路径当前必须恰好持有该轮最后一次改动留下的状态——记录过的文件按内容地址比较，其他条目按类型比较。此后又被移动过的路径会拒绝整次回退，因此冲突的编辑绝不会被丢弃，也绝不会发生部分还原。计划会把一条路径的多次变更收敛为它最初的 before 状态与最后的 after 状态；中间的状态转换作为证据留在日志里。

**记录可重放，而非进程内私有。** `fileJournal` projection 把 `file/checkpoint` 与 `file/change` 折叠成与在线 journal 相同的事实，因此重启后的进程、或一次重试，都能还原它从未观测过的那一轮。没有引入隐藏状态：这两条事件就是记录本身，而 `SESSION_FORMAT_VERSION` 不变，因为词汇表增长并不构成结构性格式变更。

**拒绝是 fail-closed 且稳定的。** `session.rewind` 以 `session/rewind-unavailable`、`reason: 'file-unavailable'` 加 `fileReason` 作答：`file-journal-absent`（什么都没记录，或派发了工具却没有基线）、`file-conflict`（记录过的路径此后被移动）、`file-unrecoverable`（变更路径没有可恢复的内容）、`file-checkpoint-over-budget`、`file-outside-workspace`、`file-blob-missing`，或 `file-workspace-busy`（同一工作区内有其他 agent 正在运行）。同一 Session 的回退会被串行化，因此两个并发请求只会产生一个标记与一次还原，而不是各两次。

## Alternatives considered

**只在 `ctx.fs` 服务处拦截，放弃 shell 写入。** 拒绝，因为不完整：它会静默漏掉 shell 命令的每一次写入，而那占 agent 文件工作的大部分。

**用操作系统 watcher 监视工作区并在变更时快照。** 拒绝：watch 事件到达时内容已被替换，变更前的字节已经不存在；本部署没有 shadow copy 或 OS 快照；而现有的 `workspaceFiles` 变更流由 `fs/observed` 供给，同样看不到 shell 写入。

**在回退时用修改时间推断变更。** 拒绝：它无法区分某一轮的写入与用户的写入，而且它没有可用来还原的内容。靠猜测还原比拒绝更糟。

**把仓库的版本控制当作内容存储。** 拒绝：那会让该能力依赖工作区是一棵干净的 Git 树，而本项工作的验收明确排除 `git reset`/`checkout` 实现。内容寻址让 journal 不依赖任何 VCS 状态。

**在 `turn/start` 为每一轮都采集基线。** 拒绝：它会给纯对话的一轮追加 checkpoint，改变每个已录像会话的事件流与全部夹具，并且为一轮根本不可能写入的回合支付一次工作区扫描。

**把遍历排除的路径视为整轮不可还原。** 拒绝，理由相反：带 `node_modules` 的项目将永远无法回退。被排除的存储只有在 journal 看到写入时才触发拒绝。

## Consequences

只要 journal 记录到了，回退后工作区就会回到该轮开始前的样子，回执中会列出被重写或删除的路径。模型可见 surface 的效果与先前的回退一致，因此其 KV-cache 与整日志投影的后果沿用不变。

边界比「这一轮被撤销」要窄，并已如实记录：不透明子进程写进被排除的依赖存储、版本控制元数据或语言缓存时不可见；工作区之外的写入是被拒绝而非被逆转；基线超出预算的一轮会被拒绝；已记录的内容会被保留，不做垃圾回收。

`packages/session/session-rewind-files/tests/journal.spec.ts` 覆盖基线采集与创建／修改／删除／重命名路径的还原、二进制往返、未触碰文件的保证、本插件从未听说过的工具、拒绝冲突且不重写任何内容、单文件与扫描预算、被排除的依赖存储在两个方向上的行为、越界写入拒绝、符号链接包含、仅凭日志重放，以及内存态只是优化而非记录本身。`packages/api/session-controller/tests/commands-rewind-files.host.spec.ts` 覆盖命令的文件回执、未装配 journal 时的拒绝、冲突拒绝、重试幂等、并发串行化、workspace-busy 守卫，以及没有派发任何工具的一轮。

`KNOWN_SESSION_EVENT_TYPES` 与 persistence catalog 因这两条新事件类型而重新生成——这是该生成集合在本批中的唯一改动——`SESSION_FORMAT_VERSION` 保持为 3；工作区文件的还原能力只覆盖 journal 记录且无冲突的 workspace 文件，外部副作用仍不支持。
