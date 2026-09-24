# Agent Note: Auto review 的规则优先路由与 fail-closed 上抛

Status: implemented

[English](2026-09-23-auto-review-rules-routing.md) | 中文

## Problem

已发布的 Auto review 把每个待审调用都交给提出该调用的同一 provider 与模型，既没有本地判定、没有独立 reviewer 路由、没有去重，其失败路径产生的拒绝也不带归属。由此产生四项代价。每个显而易见安全的调用都花掉一次 reviewer 请求。reviewer 与提出动作的模型共用路由，这是最不独立的裁判。没有任何记录能区分策略拒绝与技术失败。而且由于 Auto preset 捆绑 `danger-full-access`，在完全无法运行受限模式的部署中——Windows Native Git Bash 拒绝受限模式，只在显式完全访问下执行——reviewer 的决策是唯一控制。

## Decision

每个受支持调用经过三个阶段，遇到第一个决策即停止：确定性规则，然后配置的快速 reviewer，最后部署的审批答复方。任何阶段都不把失败变成批准。

### 确定性规则

[`src/rules.ts`](../../../../packages/experimental/auto-review/src/rules.ts)是对待审工具名与已解析参数的纯函数。它只判定固定策略的两端，即规则与 reviewer 会给出相同答案的地方：

- `session-local-tool` 放行 `todo_write`、`ask_user_question`、`create_goal`、`update_goal` 与 `get_goal`，它们的全部效果都是 Session 状态。
- `filesystem-destruction` 拒绝递归强制删除文件系统根目录或家目录的 `bash` 或 `pwsh` 命令。
- `credential-exfiltration` 拒绝参数中同时带有凭据存储与网络出口的 `bash` 或 `pwsh` 命令。
- 其余一切以 `unclassified` 上抛。

规则扫描动作字符串叶子值的一个有界样本。扫描被截断只会丢掉候选并上抛，因此该上限的代价最多是一次多余的 reviewer 请求。两条拒绝规则只对属于 shell 工具的 `command` 字符串生效，因此撰写提到同样文本的文档或脚本仍由 reviewer 判定。

### Reviewer 路由

`reviewProvider` 与 `reviewModel` 命名快速路由；两者都缺省时使用 Session 自身的 `request/header.config` 路由。只配置一半，或配置了没有存活 adapter 发布的 provider 时按拒绝处理；该 integration 绝不降级为 Session 路由，因为要求不同 reviewer 的部署不得静默得到提出动作的模型。`reviewTimeoutMs` 直接约束等待：listener 让 reviewer 与超时信号竞速，因此忽略取消信号的 reviewer 无法拖住待审调用，而被中止的 review 在卸载时仍会被等待结清。

### Fail-closed 上抛

`unresolved` 选择未决路径：`'human'`（默认）就那一确切工具与调用 id 询问 `ctx.approval.request()` 一次，`'deny'` 不询问直接拒绝。只有 `allowed-once` 才执行该调用。被拒绝、被取消、无答复方或无法记录的问题都转为拒绝，并在持久化理由中写明原因。审批服务拥有策略、审计与答复方分派，因此不引入新的人工交互机制。

### Review 记忆

一个动作身份由 Session、当前 step、模式、名称与序列化参数构成。并发的同等待审动作共用一次 reviewer 请求。当前 step 内记录的拒绝连同其原始理由被重放，且不产生 reviewer 请求。allow 从不重放：第二次执行是第一个裁决未覆盖的第二个效果，而下一个 step 会重新审查该动作，因为新 step 可能带来新授权。

### 可追溯性

每个决策写出一行 integration 日志，记录种类、决策阶段、规则（若由规则判定）、工具、调用与 Session。该行不含理由，因为 reviewer 理由没有长度上限、会随 reviewer 决定解释的内容增长；理由改由持久化工具错误承载。拒绝把理由持久化到既有的 `AutoReviewDeniedError` 元数据中，因此持久化错误字段保持其声明形态。上抛调用还会记录普通的 `approval/asked` 与 `approval/decided` 事件对。reviewer 的风险等级、prompt、reasoning 与原始响应绝不持久化、不写日志，也不进入面向模型的内容；面向模型的拒绝文本保持不变。

### 配置

`enabled`、`rules`、`reviewProvider`、`reviewModel`、`unresolved` 与 `reviewTimeoutMs` 是 profile `cordis.yml` 中经校验的 `Config` 字段。`enabled` 默认 `true`，因为该层本就经过两次显式启用——安装进 profile，以及为 Session 选择 Auto——再加一个默认关闭的开关只会让文档所述的安装变成空操作。

### Windows Native Git Bash

该审查不读取沙箱状态，也不请求任何限制。在所选 shell 为 Git Bash 的 Windows 主机上，受限模式拒绝启动、只有显式完全访问会执行，此时审查决策是唯一控制，本 integration 中没有任何部分削弱这一点或声称相反。

## Alternatives considered

**按声明名称把所有只读操作加入白名单。** 名称说明不了效果，而更宽的白名单会批准 reviewer 从未看到的主机效果。放行规则只覆盖其所属包定义为仅改动 Session 状态的工具，这类工具的名称与效果是同一个事实。

**为相同动作缓存 reviewer 的 allow。** 缓存的 allow 就是长期授权。reviewer 判定的是某一次执行，而获授权的 medium 动作带有获授权的次数，因此第二次执行不在该裁决范围内。只有拒绝会因为在一个 step 内单调而被重放。

**配置的快速路由不可用时回退到 Session 路由。** 静默降级会在部署以为由另一个模型审查时改用提出动作的模型。改为按拒绝处理并写明不可用的路由。

**只用取消信号约束 reviewer。** `dsh-llm` 要求 adapter 遵守 `options.signal`，因此该信号就是契约。仅依赖它仍会让一个不守约的 adapter 永久拖住工具调用，而这正是超时要约束的失败，因此 listener 另外直接与超时竞速。

**把每个决策记录为 Session 事件。** `SessionEventMap` 成员是读时必需，因此新类型会让不认识它的构建拒绝日志，还需要一次持久化类型确认。该决策不是模型上下文，而工具错误、审批审计事件对与日志行已经承载它，因此不改动持久格式。

**把规则拒绝缓存到当前 step 之外。** 后续的 human 或直接父级指令可以授权先前 step 拒绝的动作。跨 step 重放该拒绝会拒绝人类刚刚批准的工作。

**在本次改动中交付桌面设置卡片。** 卡片需要浏览器半边、settings namespace、tsconfig 编译面与 bundle 组合接线。开关与路由可通过 profile 的 `cordis.yml` 到达，因此卡片在路由落地期间继续延期。

## Consequences

Reviewer 请求缩减到规则无法判定的动作；并发重复只花一次请求，同一 step 内重复的拒绝不花请求。每个拒绝现在写明其决策阶段，因此仅凭持久记录就能区分规则改动、reviewer 改动与技术失败。未决路径不再可能被误认为决策：它要么到达答复方，要么写明为何不能。

规则可能误拒有用工作——在更大的脚本中提到根删除或凭据发送的命令会不经审查被拒绝——这是固定策略本就接受的更安全方向。规则只通过两个工具名上的 `command` 参数识别 shell 命令，因此另一层包装会上抛。默认的 human 路由会到达审批服务，但在 Auto preset 的 `never` 策略下解析为拒绝，因为询问人工需要由[权限 preset 层](../../../../packages/interaction/permission-presets/README.zh.md)拥有的 preset 级改动。配置位于 `cordis.yml` 而非设置页。`docs/config-catalog.md` 与 `docs/module-graph.md` 需要在其他在途工作流稳定后重新生成；catalog 生成器当前拒绝 Git Bash 设置工作引入到 `packages/shell/bash-local` 与 `packages/shell/pwsh-local` 的 schema 展开。

## Testing

`tests/rules.spec.ts` 固定每条规则身份、放行与拒绝两个方向、必须上抛的非灾难性近似情形、shell 工具限制，以及两个扫描上限。`tests/auto-review.spec.ts` 固定：关闭时审查不产生 reviewer 请求、Session 本地放行、灾难性拒绝、配置的快速路由、半配置与未发布路由的失败、reviewer 超时、`rules: false`、审批授予、每种 fail-closed 答复方结果、并发合并、拒绝重放、下一 step 重新审查，以及一组 trace 断言：若报告了决策阶段并未产生的决策、规则或理由即失败。两个文件都对 `src/index.ts` 与 `src/rules.ts` 达到语句、分支、函数与行的全覆盖。
