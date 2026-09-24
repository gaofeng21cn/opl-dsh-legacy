# Agent Note: Directory Membership on Every Start

Status: implemented

[English](2026-09-23-directory-membership-on-every-start.md) | 中文

## Problem

已注册 Workspace 对自身会话的账本只在首次成功启动时由历史引导构建一次；此后注册表只重建其规范 cwd 的 header 索引。于是所有其他创建会话的组合——无头运行使用的普通 `ctx.sessions.create` 路径、ACP 桥、带 seed 的子会话，以及任何从不调用 `attachSession` 的宿主——都会产生「运行在已注册项目目录中却从不出现在该项目下」的会话。GUI 创建路径只在调用方指定 `workspaceId` 时挂载，因此指定了「项目已拥有的 `cwd`」的调用方同样被漏掉。

侧边栏契约本就承诺相反的行为：会话加入它运行目录所在的项目。缺的是机制，不是意图。

## Decision

目录归属是存储中不可变 `SessionHeader.cwd` 的属性，因此注册表在每次启动时重新应用它，而不是只消费一次。

`WorkspaceRegistry` 在启动收尾时执行会话纳入：对每个已建立索引、规范 cwd 等于某个已注册 Workspace 路径、且没有任何显式 `sessionPlacements` 条目覆盖的会话，调用 `attachSession`。候选按最旧优先挂载，使最新者落在首位——这正是创建与引导本已产生的顺序——已在该账本上的会话不写盘。该轮处理逐会话原子：无法挂载的会话会被记录日志、留在项目之外，并在下次启动重试，而不会让启动失败或留下部分账本。

`SessionCommandController.create` 处理即时情形：调用方提供的 `cwd` 若经 `resolveByPath` 判定已由某个已注册 Workspace 拥有，就通过同一个 `attachSession` 加入该 Workspace。解析是尽力而为的，且绝不创建 Workspace：无主、非目录或无法解析的 `cwd`，以及被拒绝的挂载，都使会话留在项目之外，由下次启动纳入。显式 `workspaceId` 保留其专属的 `session/workspace-attach-failed` 失败，因为该调用方指定的是 Workspace 而非目录。`standalone` 创建为调用方要求保持无项目的任务分配私有目录，因此绝不加入项目；`defaultCwd` 回退同样不做目录推断，因为只有调用方指定的 `cwd` 才表达了用户选择的目录。由于两者都未指定目录，其选择无法在之后的启动中从存储的 header 重新推导，因此二者都在创建时记录注册表的显式项目外 placement：`adoptSessions` 会跳过已放置的会话，此后只有显式 `moveSession` 覆盖该记录才能加入项目。缺少这条记录，创建时的决定与下次启动就会相互矛盾。因此，placement 写入失败会以 `session/membership-unrecorded` 拒绝创建并携带已创建的 `sessionId`，让调用方重试放置，而不是收到一个会被下次启动推翻的成功。

## Supersession

本笔记取代 [Workspace Registration Deletion](2026-07-27-workspace-registration-deletion.zh.md) 中 `## Consequences` 里「re-registration does not automatically re-adopt existing Sessions after bootstrap」一句。该句描述的是「一次性引导」的附带代价。删除决策本身——移除 Workspace 不触碰任何目录、文件或日志，其会话变为 Ungrouped——并未改变，且仍是本笔记的前提。

## Alternatives considered

**保留一次性引导，只在 `session.create` 挂载。** 否决：这只修复了若干创建路径中的一条，会让无头、ACP 与带 seed 的会话继续存在所报告的缺陷；GUI 仍会显示缺少「曾在其目录中运行过的会话」的项目。

**在读取时惰性纳入。** 否决：`sessionIds` 是对持久状态的同步投影。在 getter 中纳入，要么从读路径产生变更，要么报告一种不持久化任何内容的成员资格。

**在 `delete` 时把被删除 Workspace 的每个会话显式置于项目之外。** 这能保留旧的重新注册行为，代价是在领域全局状态中为每个已记账会话增加一条 `sessionPlacements` 条目，并被此后每次顺序、归档或 placement 写入重写——一次 O(N) 全局写入，只为记录目录规则本已一致决定的结果。

**同样从 `defaultCwd` 或 `standalone` 推断归属。** 否决：两者都没有指定调用方选择的目录——`defaultCwd` 是宿主进程的工作目录，`standalone` 目录是为无项目任务私下分配的。

## Verification

Workspace 包测试固定了历史纳入、符号链接 cwd、重启幂等（不重写且会话事实不变）、显式 `null` 与跨项目 placement 在纳入后仍生效、创建时项目外 placement 在重启后仍生效直至被显式移动覆盖、已归档会话保持纳入且归档集合不受影响、无主/缺失/无 cwd 目录不创建项目，以及失败纳入在下次启动重试。Session Controller 测试固定了创建时纳入且已存储 cwd 保持调用方拼写、并发创建不产生重复成员、无主与无法解析的 cwd、在项目拥有的任务目录中执行 `standalone` 创建、不做推断的 `defaultCwd`，以及被拒绝的推断挂载不会让创建失败；这些测试还会在同一持久介质上重启，证明注册在 standalone 私有任务目录或 `defaultCwd` 上的项目都不会收编对应会话，而显式 `moveSession` 仍能把 standalone 会话归组且不改写其 cwd。失败分支同样被固定：项目外 placement 写入被拒绝时，创建以 `session/membership-unrecorded` 失败、报告已创建会话的 id，并在重试放置时接受该 id；打包的控制 CLI 在发送任何请求之前就拒绝同时给出 `--project` 与 `--out`。

## Consequences

项目会找回此前缺失的会话，包括早于其注册的目录的全部历史，以及在 GUI 创建路径之外创建的每一个会话。纳入只触及 header 索引能校验的会话，因此没有记录目录、或目录不被任何项目精确拥有的会话保持 Ungrouped，而显式 placement 始终优先于目录。代价是启动时对 header 索引的一轮遍历，以及每个新纳入会话一次记录写入；账本已完整的项目不写任何内容。未指定调用方所选目录的创建还会多付一次持久写入来记录其项目外 placement；该代价按此类创建发生，而不是重写历史，且正是这条记录让创建时的决定在之后每次启动都成立。「移除后再重新注册同一目录」不再永久丢弃该目录的归属：新项目在本次运行余下时间为空，并在下次启动时重新填充。
