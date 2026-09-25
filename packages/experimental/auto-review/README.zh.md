---
description: "为 Web 或桌面 profile 添加实验性逐调用 Auto review：先由确定性规则判定，再走快速 reviewer 路由，最后交给部署的审批答复方。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-auto-review

[English](README.md) | 中文

## 概述

为 Auto 权限预设提供工具调用自动审查。确定性规则、配置的审查模型和可用的用户审批处理器决定受保护调用能否执行。无法使用的审查结果不会静默授予执行权限。

## 目录

- [使用本包](#use-this-package)
- [配置该审查](#configure-the-gate)
- [获得的能力](#what-you-get)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

为 Web 或桌面 profile 当前会话权限选择器添加 Auto review。每次原生或 PTC inner 工具调用前，先由确定性规则判定固定策略两端显而易见的动作，其余交给配置的快速 reviewer，reviewer 未决的调用再交给部署的审批答复方。在显式安装此层之前，默认 Web 保持三种权限模式。Auto review 是实验功能：它可能误放行不安全动作、误拒绝有用操作，并消耗额外 token。

完全访问不是安全审查。Auto preset 与 Full access 捆绑相同的沙箱模式与审批策略，因此获准调用会无限制、无确认地执行；审查决策是 Auto 为该组合新增的唯一控制。

### 安装到 profile

从源码 checkout 通过既有 CLI 将包安装到 Web profile：

```sh
pnpm dsh plugin --profile web add ./packages/experimental/auto-review
```

CLI 会在需要时初始化 profile，并将本包声明的 patch 追加到 base 与 Web 层之后。Reconciliation 将 patch 激活为 profile 层；没有 `dsh.bundle.patch` 的包只是已安装依赖。在 composer 或 `/permission` 选择器中选择带右上标 `EXP` 的 `Auto review`，并确认当前会话风险对话框。显式 `/permission auto` 命令直接切换。通用设置与未来会话默认值不提供 Auto。

通过同一 CLI 移除此层：

```sh
pnpm dsh plugin --profile web remove @deepseek-ai/dsh-experimental-auto-review
```

### 两道显式启用

安装此层只是新增选项；为 Session 选择 Auto 才武装该审查。两者同时成立前不会有任何调用被审查，因此处于 Read only、Workspace write 或 Full access 的 Session 不受本包影响。本层不提供自己的桌面设置卡片，`enabled` 与 reviewer 路由写在 profile 的 `cordis.yml` 行中；选择 Auto 仍是逐 Session 的控制入口。

<a id="configure-the-gate"></a>
## 配置该审查

在 profile 的 `cordis.yml`（或更晚的 patch 层）中重述本包行即可修改任一字段。[配置目录](../../../docs/config-catalog.zh.md)是接受字段及其 JSDoc 的穷举生成来源。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 整个审查的显式开关。`false` 时放行每个调用，包括已选择 Auto 的 Session。 |
| `rules` | `true` | 确定性首轮规则。`false` 时每个待审动作都交给 reviewer。 |
| `reviewProvider` | Session 路由 | 快速 reviewer 路由的 provider；须与 `reviewModel` 同时配置。 |
| `reviewModel` | Session 路由 | 快速 reviewer 路由的模型。 |
| `unresolved` | `'human'` | reviewer 未决调用的处理：`'human'` 询问审批答复方一次，`'deny'` 不询问直接拒绝。 |
| `reviewTimeoutMs` | `30000` | 单次 reviewer 请求在被放弃前可运行的毫秒数。 |

只配置 provider/model 之一，或配置了没有存活 adapter 发布的 provider 时按拒绝处理，而不会静默改用 Session 路由。

<a id="what-you-get"></a>
## 获得的能力

Auto 在每个受支持调用的 body 执行前审查一次，包括每个已开始的 PTC `tools.*` inner call；审查分三个阶段，遇到第一个决策即停止。

**规则判定显而易见的两端。** `todo_write`、`ask_user_question`、`create_goal`、`update_goal` 与 `get_goal` 只改动 Session 状态，因此不产生 reviewer 请求即获准。递归强制删除文件系统根目录或家目录、或在同一条命令中读取凭据存储并向外部目的地发送字节的 shell 命令，同样不产生 reviewer 请求即被拒绝。其余动作全部上抛，因此规则只会增加拒绝或省去无谓请求，绝不会批准 reviewer 本会审查的效果。

**Reviewer 判定其余动作。** 上抛动作在配置了 `reviewModel` 时交给它，否则交给 Session 当前 provider 与模型，并附带固定策略与下述五个分区。allow 后立即以 Full access 执行；deny 报告 reviewer 自己的理由。

**答复方判定 reviewer 无法判定的动作。** reviewer 请求失败、未返回协议合法决策或超过 `reviewTimeoutMs` 时不产生裁决；在默认 `unresolved: 'human'` 下，部署的审批答复方会就这一确切调用收到一个问题。只有 `allowed-once` 才执行它。被拒绝、被取消、无答复方或无法记录的问题都转为拒绝，因此该审查绝不把失败变成批准。

并发的同等待审动作共用一次 reviewer 请求；当前 step 已判定的拒绝会被重放而不重问。allow 从不重放：第二次执行是第一个裁决未覆盖的第二个效果，且下一个 step 会重新审查该动作。

被拒绝的调用使用普通工具卡片。折叠行标识 Auto review；展开输出说明 body 未执行，并显示理由。[Web 权限包](../../client/ui-permission-presets/README.zh.md)拥有选择器交互，[工具 UI](../../client/ui-tool/README.zh.md)拥有理由展示。

### 可追溯性

每个决策写出一行 integration 日志，记录种类、决策阶段、规则（若由规则判定）、工具、调用与 Session。拒绝还会把理由持久化到工具错误中；上抛调用还会记录普通的 `approval/asked` 与 `approval/decided` 事件对。reviewer 的风险等级、prompt、reasoning 与原始响应绝不持久化、不写日志，也不出现在面向模型的拒绝中。规则拒绝的理由写明该规则固定的效果；reviewer 拒绝保持 reviewer 原文不变。

因此从拒绝回溯其决策不需要新的持久格式：工具结果携带理由，审批审计事件对覆盖上抛路径，日志行覆盖放行路径。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制——点击展开</summary>

[`cordis.patch.yml`](cordis.patch.yml)把本包自身插入为 `auto-review` 行。[`src/index.ts`](src/index.ts)要求 LLM、permission、Session 与 tools 服务，然后在同一个 effect 中安装 preset contribution 和置前的 pre-execute listener。[`src/rules.ts`](src/rules.ts)是纯函数式的首轮规则集。[权限 owner](../../interaction/permission-presets/README.zh.md)提供当前身份和进程目录；Auto 共用 Full access 既有沙箱与审批值，不改变工具定义。

Reviewer 从当前 Session surface 与待执行调用重建五个分区：固定策略、仅 cwd 的环境、带来源的项目约束、过滤后带来源的历史，以及完整待审动作。原生 schema 来自最新 request header。PTC binding 冻结其 schema，经由调度器传入临时执行元数据；开始与结算事件都不序列化描述或参数 schema。主 agent 的 `system/message` 节点、assistant 正文与 reasoning、tool results 全部排除。[决策记录](../../../.agents/notes/implemented/feature/2026-08-28-auto-review.zh.md)拥有权威、生命周期与 child 继承的理由；[路由决策](../../../.agents/notes/implemented/feature/2026-09-23-auto-review-rules-routing.zh.md)拥有三个阶段、review 记忆，以及配置的快速路由为何绝不降级为 Session 路由。

snapshot 先于规则执行，因此日志与待审调用不一致的 Session 在每个阶段都被拒绝，而不会跳过校验。规则只读取待审名称与参数；reviewer 读取冻结的 snapshot；答复方路径把待执行调用交给审批服务，由后者拥有策略、审计与答复方分派。

卸载时先关闭选择与 review admission，经由既有 preset writer 将存活 Auto Session 迁移到 Full access，再中止并等待在途 review 结清，最后撤回 listener 与 contribution。reviewer 超时是唯一提前结束的等待：被中止的 review 仍会结清，而忽略取消信号的 reviewer 也无法把调用拖过 `reviewTimeoutMs`。旋钮与持久终端在迁移中保持不变。持久 Auto Session 缺少完整 integration 时不能发布；安装后重新打开需要用户显式操作。重装只恢复选项，不把存活 Session 切回 Auto。

本包不发布 runtime invariant companion：同一个 effect 拥有选择准入、review 登记、取消与清理，不存在能与这些自有操作相互偏离的独立观察。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [实验包](../README.zh.md)——发布策略与依赖隔离。
- [Web bundle](../../bundle/web-app/README.zh.md)——此 patch 扩展的稳定 profile。
- [Auto review 决策](../../../.agents/notes/implemented/feature/2026-08-28-auto-review.zh.md)——固定风险策略、权威与生命周期。
- [Auto review 路由决策](../../../.agents/notes/implemented/feature/2026-09-23-auto-review-rules-routing.zh.md)——规则优先路由、review 记忆与 fail-closed 上抛。
- [Tools](../../core/tools/README.zh.md)——执行、取消与 PTC 结果传播。

-----

<a id="model-experience"></a>
## 模型体验

### 逐调用 reviewer

#### 模型看到什么

Reviewer 使用配置的快速路由，否则使用最新 `request/header.config` 的 provider 与模型，并沿用 shipped adapter 默认 reasoning。固定 `REVIEW_POLICY` 替代恰好一个动作的人工审批：allow 后立即以 Full access 执行。其余四个分区只包含上文列出的保留事实。响应为一个严格 JSON text 对象，包含 `risk` 与 `decision`；deny 可附字符串 `reason`。Reasoning blocks 可以位于这唯一 text block 之前。只有 `low + allow`、`medium + allow/deny` 和 `high + deny` 合法。

#### Token 影响

每个受支持调用最多额外产生一次模型请求，不缓存、重试、截断、压缩，也不设单独的小型输出预算；由规则或 review 记忆判定的调用完全不产生请求。超窗请求按拒绝处理，超过 `reviewTimeoutMs` 的请求被放弃。

#### KV Cache 影响

固定 reviewer policy 可以共享前缀；保留历史与待审动作随调用变化。Auto 不向主 agent 增加专门 runtime context 或模式切换提示词。

### 工具拒绝

#### 模型看到什么

拒绝消息为 `Auto review rejected tool "<name>"; its body was not executed`。普通原生错误渲染在前面加 `Error: `。PTC 使用既有 inner-call 异常与 catch 行为；被捕获的拒绝不强制外层 `run_code` 失败。可选理由是面向用户的持久结构化错误详情，绝不进入主模型内容。风险、reviewer prompt、reasoning 与原始响应都不持久化。

#### Token 影响

被拒绝或失败的调用只向主对话贡献其普通错误结果。

#### KV Cache 影响

拒绝追加普通工具结果，不改写更早的上下文，也不隐藏既有模型可见信息。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- Auto 需要显式安装 Web 层；默认 Web、Headless、通用设置与新会话默认值都不包含它。它不提供桌面设置卡片，因此其开关与 reviewer 路由在 profile 的 `cordis.yml` 中修改，而不是在设置页。
- Auto preset 把审批策略固定为 `never`，审批服务在任何答复方被咨询之前就强制执行它。因此默认的 `unresolved: 'human'` 路由会到达答复方 seam、记录其审计事件对，最终仍解析为拒绝；为未分类调用真正询问人工需要 preset 级决策，本包不拥有该决策。
- 规则只通过 `bash` 或 `pwsh` 工具上的 `command` 参数识别 shell 命令，并读取该命令文本，因此经由其他工具或不可见变量达到同样效果的动作会上抛。规则从不放行宽泛工作：`rules: false` 存在，是因为部署可能认为即使 Session 本地白名单也过宽。
- 去重覆盖并发的同等待审动作与同一 step 内的拒绝。重复的 allow 会重新审查；后续 step 中的相同动作也会重新审查，因为新 step 可能带来新授权。
- Auto 不提供文件沙箱。外层 `run_code` transport 及 PTC 程序内直接 Node 效果不经过 inner-tool review。Windows 上的 Native Git Bash 拒绝受限模式，只在显式完全访问下执行，因此在那里审查决策是唯一控制。
- 模型分类可能出错。不提供持久 grant、可配置策略文本或重试层。
- 进程内 Auto child 独立审查自身调用。进程外 child 在父委派调用获准后保留原生权限系统。
- reviewer 在带行级豁免的情况下，通过已废弃的同步 `snapshotEvents()` 读取 Session 动作历史。此前的调用、PTC start 与直接父级的初始 prompt 目前都没有投影或分页读取方，因此迁移按[同步读取决策](../../../.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.zh.md)继续延期。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
