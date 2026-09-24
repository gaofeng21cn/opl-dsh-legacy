---
description: "逐轮的 workspace 内容基线与变更记录，让 session.rewind 能够还原某一轮写过的文件，凡不能证明的一律拒绝。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-rewind-files

[English](README.md) | 中文

## Summary

本包记录每次工具执行在会话工作区内写入了什么，使对话回退不仅能回退对话记录，还能把那些文件放回去。当某个部署装配了 [`session.rewind`](../../api/session-controller/README.zh.md) 且用户期望「回退这一轮」后工作区回到原样时使用它。

## Table of Contents

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发者说明](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在运行文件系统或 shell 工具、并提供回退能力的 profile 中挂载本插件。它需要工具注册表、projection 注册表与 `ctx.fs`；缺少任一者时 fiber 保持 pending，什么都不会记录。

```yaml
- name: '@deepseek-ai/dsh-session-rewind-files'
  config:
    maxFileBytes: 2097152
    maxEntries: 50000
    maxCheckpointBytes: 67108864
```

### 记录什么

一轮中第一次派发工具之前，journal 会为会话工作区采集一份有上限的内容基线，以 SHA-256 寻址。此后该轮每次执行结束，它都对工作区做一次差异比较，并追加一条 `file/change` 事件说明哪些路径移动了，记录的是内容地址而非内联字节。两种事件都是 log-only：它们不会进入模型可见 surface。

回退只还原这些记录能证明的内容：把记录过的路径写回其变更前内容并重新应用基线记录的权限位、删除该轮新建的路径；只要有任何记录路径当前并非该轮留下的状态，整次还原都会被拒绝。

### 配置

| 字段 | 含义 |
|---|---|
| `maxFileBytes` | 基线记录的单文件上限；更大的文件会被列为未记录，改动它会让该轮不可还原 |
| `maxEntries` | 单次扫描访问的工作区条目上限，超出即截断 |
| `maxCheckpointBytes` | 单次基线读取的总字节上限 |
| `blobRoot` | 覆盖内容寻址存储根目录；默认 `$DSH_HOME/rewind-files` |

### 失败行为

每次拒绝都不改动工作区，因为整个计划会在第一个 replacement 之前全部验证完毕。`session.rewind` 通过 `fileReason` 报告具体条件：`file-journal-absent`、`file-outside-workspace`、`file-unrecoverable`、`file-checkpoint-over-budget`、`file-conflict`、`file-blob-missing` 或 `file-workspace-busy`。没有派发任何工具的一轮没有基线，还原为空操作，这不算拒绝。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

### 为什么基线必须先于写入

写入通过两个边界到达工作区。Harness 自身发起的文本改动都经过 `ctx.fs.writeText`/`editText`（即 `write`、`edit`、`str_replace_editor` 工具），因此文件系统 seam 能看到。而通过 `ctx.shell`（`bash`、`pwsh`、`run_code`、终端）运行的命令是不透明进程，可以在不回调 harness 的情况下创建、修改、删除或重命名工作区里任意文件：没有任何东西观察这些写入，这里也没有可用的操作系统快照。

因此 journal 在该轮第一次派发工具之前采集基线，并在每次执行之后做差异比较。正是这个顺序让不透明进程的写入变得可恢复：差异比较找出移动了什么，基线仍持有那些路径此前的字节。无需拦截进程本身，这也是未知的部署工具同样被覆盖的原因。

### 源码导览

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：工具包装、写入观测、projection 注册 |
| [`src/journal.ts`](src/journal.ts) | `ctx.fileJournal`：基线、逐次执行的差异、还原 |
| [`src/workspace-scan.ts`](src/workspace-scan.ts) | 有界遍历与工作区相对路径规则 |
| [`src/blob-store.ts`](src/blob-store.ts) | `$DSH_HOME/rewind-files` 下的内容寻址存储 |
| [`src/projection.ts`](src/projection.ts) | 从日志重建同样事实的 `fileJournal` fold |
| [`src/types.ts`](src/types.ts) | 事件载荷与原因词汇表 |

### 路径规则与内容寻址

遍历只从规范化的工作区根向下进行，且从不跟随符号链接，因此被记录的相对路径无法逃出该根目录；还原时会在写入前把每个相对路径重新解析到该根目录之内。路径按精确码元比较——journal 不做任何 Unicode 归一化——因此键始终是宿主报告的名称。内容以其精确字节的 SHA-256 寻址，因此跨轮次、跨会话的相同内容只存一份，还原也能证明取回的就是当初记录的内容。二进制内容按字节存储与比较，全程不做解码。写入通过同目录临时文件加 rename 发布（记录的权限位会先应用到该临时文件），因此还原后的文件保留自身 mode，失败时留下原文件而不是被截断的文件。

### 排除的目录

遍历会跳过依赖树、版本控制对象库与语言缓存（`.git`、`node_modules`、`.venv`、`__pycache__`、`.next`、`target` 等）。跳过它们让单次基线与项目自身源码成正比。普通构建产物（`dist`、`build`、`out`）**不**跳过，会像其他文件一样被记录。只要 journal 看到写入落在被排除的目录里就会被拒绝：`ctx.fs` 改动会通过文件系统观测上报，而基线从未记录过的路径会让该轮不可还原。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Session controller](../../api/session-controller/README.zh.md) —— 消费本 journal 的 `rewind` 命令。
- [Session 包导览](../README.zh.md) —— 相邻的持久化会话包。
- [文件系统包](../../fs/fs/README.zh.md) —— 上报观测所经过的 `ctx.fs` seam。

-----

<a id="model-experience"></a>
## 模型体验

### 回退之后的工作区状态

#### 模型看到什么

记录本身不产生任何模型输入。journal 不注册工具、不添加提示词段落，只追加 `file/checkpoint` 与 `file/change` 这两条 log-only 事件，因此无论是否装配本插件，一次请求的消息、工具定义与系统提示词都不变。唯一的模型可见差异是间接的：回退之后，被回退那一轮写过的工作区文件重新持有该轮之前的内容，因此之后读取这些路径会得到更早的状态，而不是那一轮留下的结果。

#### Token 影响

记录期间没有：没有任何请求会增加消息、工具定义或提示词段落。回退会移除模型可见 surface 的一条分支，从而按该分支所承载的内容减少下一次请求的输入 token——这正是回退命令本身既有的效果。

#### KV Cache 影响

记录期间无影响。回退会丢弃模型可见 surface 的一条分支，这与回退命令本身已有的前缀失效效果相同；幸存的前缀仍可复用。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了 journal 能证明的范围，每条都是当前约束，而非待修的缺陷。

- **写入被排除目录的不透明操作不可见** —— shell 命令若在 `node_modules`、`.git` 或语言缓存内写入，遍历记录的路径没有任何变化，该轮仍可能报告还原成功。依赖树与版本控制元数据不在本 journal 声称可撤销的范围内。
- **工作区之外的写入只能拒绝，不能撤销** —— 只有当操作通过文件系统观测上报时 journal 才能发现越界写入，并且它会拒绝该轮，而不是假装还原。
- **基线超出预算的一轮不可还原** —— 工作区超过 `maxEntries` 或 `maxCheckpointBytes`，或单个文件超过 `maxFileBytes`，都会拒绝该轮，而不是只还原一部分。
- **内容会被保留，不做垃圾回收** —— 每个记录过的版本都留在 `$DSH_HOME/rewind-files` 下；目前不会清理已经离开 surface 的那一轮的 blob。
- **内存态只是优化，不是事实来源** —— 存储由 `file/checkpoint` 与 `file/change` 事件折叠重建，因此从未观测过该轮的进程同样能还原它。
- **只有权限变化、内容未变时不会被记录** —— 可验证路径按内容地址比较，因此字节不变的 `chmod` 不会记录任何内容，回退也不会撤销它。重写已记录内容时会重新应用该路径记录的权限位，这正是还原后的脚本仍可执行的原因。
- **路径键是精确码元，绝不做归一化** —— journal 使用宿主报告的名称，因此在查找时对 Unicode 归一化不敏感、但存储拼写可能不同的宿主上（macOS），以另一种归一化形式拼写的文件系统写入无法匹配其基线条目，只会拒绝该轮。对键做归一化并不是安全的修法：在把规范等价名称视为不同文件的宿主上（Windows NTFS、Linux 文件系统），归一化后的单一键会让一个文件记录下的字节通过校验并覆盖它的兄弟文件。

<a id="dev-note"></a>
### 开发者说明

<details>
<summary>供维护者的工作上下文 — 点击展开</summary>

记录器是 `tools/execute` 包装器，而不是文件系统服务的装饰器：只有这个 seam 同时携带调用方的 agent 身份与一次执行的完整时长。文件系统 intent waterfall 在改动前给出目标，`fs/observed` 确认改动落地；两者合起来即可发现越界或未覆盖的写入，无需包装服务。基线在一轮中第一次派发工具时采集，而不是在 `turn/start`，因此纯对话的一轮完全不追加事件，已有录像会话的事件流保持不变。

</details>

**运行时不变式：** 不发布 companion。本包只拥有一个 projection fold，其状态由 projection 注册表做 schema 校验；它依赖的工作区观测（`session/event` 顺序、`tools/execute` 括起、`fs/observed` 的后续 emit）分别由 dsh-session、dsh-tools 与文件系统工具拥有并在运行时检查。
