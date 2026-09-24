# Agent Note: IME composition guarding and restored file modes

Status: implemented

[English](2026-09-24-ime-composition-guard-and-rewind-file-modes.md) | 中文

## Problem

有两种跨平台行为在非美式英文桌面之外会出错。

编辑并重发草稿——[ui-chat](../../../../packages/client/ui-chat/README.zh.md) 里的一个普通 `<textarea>`——对每次 keydown 都执行它的 Escape 与 Cmd/Ctrl+Enter 处理，包括取消组合输入的那次 Escape，以及提交中文或日文候选词的那次 Enter。用户在选词时可能关闭草稿，或把只组合了一半的提示词重发出去。输入框编辑器已经用三个组合输入信号守卫它的 keymap；而不使用该编辑器的草稿一个都没有。

[工作区文件 journal](../../../../packages/session/session-rewind-files/README.zh.md) 在基线里记录了每个条目的权限位，却从不应用它们。还原通过同目录临时文件加 rename 发布，因此被回退的文件会采用临时文件的创建 mode——常见 umask 下是 0644。一个 shell 脚本，其字节被某一轮重写或被该轮删除后，回来时不再可执行，尽管基线记录的是 0755；于是还原后的工作区与该轮开始前并不一致。

journal 以宿主报告的名称作为每个路径的键，而一次文件系统写入的路径可能以另一种 Unicode 归一化形式拼写。这种不一致此前没有被审视。

## Decision

**草稿处于组合输入期间，所有草稿快捷键都不生效。** `UserPromptEdit.tsx` 使用与 `packages/client/ui-conversation/src/client/input/editor/keymap.ts` 中 composer keymap 相同的三信号守卫：`KeyboardEvent.isComposing`、遗留的 `keyCode === 229`，以及一个组合输入监视器——它在组合期间保持生效，并在 `compositionend` 之后继续生效 10 ms，因为 Safari 会在该事件之后才投递结束组合的那次 keydown。Escape 与 Cmd/Ctrl+Enter 直接返回且不 preventDefault，因此该手势归 IME 所有。没有待处理组合输入时，keydown 在所有平台（包括 Windows）上的行为与之前完全一致。

**还原会重新应用基线记录的权限位。** `writeAtomically` 在 rename 之前把临时文件 chmod 为记录的 mode——只取低 `0o777` 位——因此 umask 无法决定还原后文件的 mode。在 Windows 上，`chmod` 只映射写位，这个调用无害，且只读属性会经由同一条路径往返。一条不携带 `mode` 字段的 `file/change` 记录（字段存在之前写下的日志）仍会还原其内容，并保留该次写入产生的 mode，这正是可选字段 `FileEntryState.mode` 所声明的语义。

**路径键保持精确码元：scan、比较、还原都不做任何 Unicode 归一化。** 被记录的路径不只是比较键；它也是还原时会在工作区根内重新解析的路径。在把规范等价名称视为不同文件的宿主上——Windows NTFS 与 Linux 文件系统——归一化后的单一键会让一个文件记录下的字节通过计划校验并覆盖它的规范等价兄弟文件，这正是 journal 拒绝执行的那种静默错误还原。在 macOS 上，其文件系统在查找时对归一化不敏感，这种不一致反而会拒绝该轮，属于 fail-closed。因此 journal 比较宿主报告的内容，并把这种拒绝记录为[已知限制](../../../../packages/session/session-rewind-files/README.zh.md#known-limitations-and-deferred-work)。

## Alternatives considered

**把统一的 IME 守卫抽到 `ui-primitives`。** 本次改动不采用：keymap 守卫读取的是 Lexical command 事件，草稿守卫读取的是 React 合成事件，共享 helper 将不得不抽象两种事件类型；三个信号是各调用点针对自身事件类型实现的约定。出现第三个非 Lexical 调用点时才应抽取。

**草稿只按 `isComposing` 守卫。** 不采用：部分引擎投递组合输入 keydown 时并不带该标志，而且 Safari 在 `compositionend` 之后才投递结束组合的 keydown，这些情况下草稿仍会取消或重发。composer keymap 已经为三个信号付过代价。

**在所有位置用 `String.prototype.normalize('NFC')` 归一化路径键。** 因不安全而不采用，理由见 Decision：在宿主把规范变体视为不同文件的地方，合并后的键会把校验步骤变成覆盖错误文件。

**在 `sameState` 中比较 mode，从而记录仅权限变化的改动。** 不采用，因为这是另一个决定且影响面更大：它会改变 `file/change` 记录的内容，并会在自该轮以来只有 mode 变化时拒绝回退。应用记录的权限位已经修复了基线本就能证明的那部分丢失，且不改变「什么算一次变化」。

## Consequences

被回退的脚本重新可执行，被删除后又还原的脚本同样保持可执行，还原后的文件保留其记录的只读位；Windows 行为不变，因为那里的 `chmod` 只移动写位。没有组合输入时，草稿快捷键不变。

`packages/client/ui-chat/tests/user-prompt-edit.client.spec.tsx` 覆盖草稿的 `isComposing` Escape、keyCode 229 Escape、组合输入监视器、`compositionend` 之后窗口内的 Escape 与 Cmd/Ctrl+Enter，以及窗口过去后仍会发生的重发。`packages/session/session-rewind-files/tests/journal.spec.ts` 覆盖被重写脚本与被删除脚本还原后的可执行位（POSIX 宿主，具备可执行位）、所有宿主上还原的只读位、不携带 `mode` 字段的变更记录，以及宿主把规范等价名称视为不同文件时的精确码元键。

没有持久化格式变化：`FileEntryState.mode` 早已存在，没有新增事件，`SESSION_FORMAT_VERSION` 不变。
