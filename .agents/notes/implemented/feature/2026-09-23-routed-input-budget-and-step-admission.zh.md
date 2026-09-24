# Agent Note: The routed input budget and step admission

Status: implemented

[English](2026-09-23-routed-input-budget-and-step-admission.md) | 中文

## Problem

已路由模型的标称能力并不等于部署的工作预算。DeepSeek 路由声明 1M 上下文窗口，因此 `dsh-compaction-basic` 的比例策略按 1M 计算：在 `thresholdRatio: 0.8` 与 `retainRatio: 0.16` 下，压缩要到 800000 估算 token 才开始，并逐字保留 160000 token 的尾部。运行 272000 token 窗口的部署希望在 244800 token 处压缩、每次请求最多 258400 输入 token，却无从表达：容量属于拥有该路由的适配器，且多个消费者把它读作模型对外声明能力；在那里缩小它会误报提供方实际提供的能力。

压缩也可能失败——没有安全范围、重试耗尽、摘要调用失败——而该步的请求仍被发送。这是策略从未授予的接纳，并用一条警告掩盖了失败。

## Decision

`dsh-compaction-basic` 在其触发与保留策略旁拥有一条按路由的**有效输入预算**：

- `inputBudget` 是绝对 token 预算；解析出的有效预算为 `min(已路由容量, inputBudget)`，因此自身窗口更小的模型保留该窗口，适配器元数据绝不被改写。两个比例都从有效预算换算；绝对 `thresholdTokens` 与 `retainTokens` 按配置取值，只有绝对触发值会收敛到有效预算。
- 触发值（`thresholdTokens`，或 `floor(有效预算 × thresholdRatio)`）启动预步压缩。
- 有效输入预算是预步 listener 的**接纳上限**。

步接纳是显式的。达到或超过触发值时，listener 在保留已定价近期尾部的同时压缩最旧的平衡范围。此后：

- 定价请求仍高于有效输入预算时，该步以 `StepInputBudgetError` 被拒绝；请求绝不发送，错误携带实测 token 数、已到达的触发值与预算。
- 压缩失败但请求仍在预算内时，记录日志并继续该步，因为所配置的预算接纳它。已到达触发值却无法降低的压缩报告 `PressureCompactionError`。
- 适配器未发布该路由容量、策略无法换算、或会话压缩锁已被持有时，属于压缩失败而非接纳决定。未配置预算时保持既有的“警告一次并继续”行为；已配置的 `inputBudget` 是部署自己的显式上限，因此即使适配器未发布容量也会被强制执行。只有既无容量、又未配置预算的路由，才把该上限交给提供方自身的溢出恢复。
- 自动压缩承载整套机制。`auto: false` 不安装任何 listener，因此不会执行步接纳，此时已配置的预算只影响程序化的 `compactIfNeeded` 调用。

已配置的预算还会让一部分保留量校验与容量无关：预算按其自身取值决定触发值，因此放不进该触发值之下的保留量会在加载时拒绝插件，而不是在首次路由请求时才失败。未配置预算时，该比较仍需要已路由模型的容量，并像以前一样在该模型首次使用时失败。

OPL 部署把它所针对的取值——`inputBudget: 258400` 与 `thresholdTokens: 244800`，即其 Codex 配置所用 272000 token 窗口的 95% 与 90% 份额——只放在其自身路由被组合的地方。随包发布的 `standard` preset 把它们作为针对 `opl-gateway/deepseek-flash` 的精确 `modelPolicies` 条目持有，因此挂载该 preset 的其他提供方都按自身容量换算并保留插件默认值；`apps/cli/config/opl-headless.cordis.patch.yml` 把它们放在 base bundle 的压缩行上，约束该 OPL 自有 profile 解析出的每条路由。插件默认值不变，因此其他部署都不移动。

## Measurement and timing

token 统计已在三个层级存在，步接纳复用它们：

- `ctx.tokenMeter.measure(session)` 折叠持久日志，为最新规范请求 envelope 与当前表层定价；当 envelope 匹配时，提供方上报用量会成为测量锚点，因此一步的决策是定价得出的而非猜测。预步路径在可选的免模型剪枝之后、以及每次压缩尝试之后都会重新测量。
- `compaction/summary` 记录 `shadowedTokenCount`（被替换范围的估算价格）与摘要器可选的 `usage`；`compaction/start` 与 `compaction/end` 在持久日志中框定该事务。
- meter 的投影单元（`tokenUsage`、`contextPressure`、`contextBreakdown`）服务占用率显示，拒绝错误则把同一组数字暴露给调用方。

耗时可以推导，但无人上报。每条持久会话事件都携带 `seq` 与墙钟 `time`，因此压缩耗时是 `compaction/summary.time - compaction/start.time`（摘要调用）与 `compaction/end.time - compaction/start.time`（含剪枝与提交的整个事务）。没有任何插件记录、聚合或发出该耗时，压缩结果也不携带它。

有三处缺口在此记录而不在此关闭：

1. 持久记录只保留被遮蔽范围的价格。一次压缩前的实测总量与压缩后的实测总量都不持久，因此要报告压缩后的压力必须从日志重新折叠。
2. 压缩耗时在插件表面积上没有归属；事件的 `time` 字段是唯一来源，也没有任何环节替用户或运维执行那次减法。
3. 压力检查本身没有计价：每一步都会解析模型容量并执行 O(表层) 的 `measure()`，没有预算或遥测覆盖该成本。

## Alternatives considered

**把适配器的 `contextWindow` 改写为部署预算。** 否决：该值是模型对外声明能力，被占用率显示、模型发现与溢出检测读取。部署预算不是提供方事实，1M 能力必须保持可报告。

**用标称窗口的比例表达预算。** 否决：这会复现部署正要离开的策略。1M 的比例仍是 1M，而真正重要的点——触发值、保留尾部与接纳上限——都是绝对 token 数。

**只用比例，部署比例为 244800/258400。** 否决：部署拥有来自其自身运行时配置的绝对数字；YAML 里的循环小数掩盖了哪个数字才是权威，并会诱发静默漂移。

**拒绝每一步未降到触发值的压缩。** 否决：固定开销（系统提示词与工具 schema）本身已超过触发值的路由永远无法压缩，拒绝会把它锁死。循环回归测试恰好固定了这种形状（400 token 窗口）。硬上限是有效输入预算，而不是触发值。

**对超预算请求保持“警告并继续”。** 否决：那正是本次改动要移除的静默接纳。高于有效预算的请求如今会使该轮失败，而过去会被尝试发送。

**通过 `PreStepDecision` 的 `reject` 拒绝该步。** 否决：`reject` 以 `blocked` 关闭轮次，并在没有诊断信息的情况下丢弃已领取批次；抛出的错误则把实测数字、触发值与预算带入轮次错误面。

**把预算放在 `llm-opl-gateway` 适配器配置上。** 否决：预算是部署运行的所有路由共同遵循的部署策略，而适配器的容量字段恰恰是本次改动拒绝覆盖的提供方元数据。

## Verification

`packages/compaction/compaction-basic/tests/compaction-basic.spec.ts` 固定了策略与接纳路径：由有效预算换算的触发值与保留量（1M 路由上是 41344 而非 160000）、更小模型收敛到自身窗口、绝对触发值在更小路由上收敛、恰好触发时压缩与低一 token 时闲置、压缩无法达到预算时拒绝、失败但请求仍在预算内时继续、已配置预算时无适配器容量也拒绝、未配置预算时保留提供方溢出恢复的路径、锁的“警告一次”路径、`auto: false` 即使有预算也不安装接纳、加载时的保留量/预算拒绝，以及保留尾部中的工具调用/结果完整性。`tests/loader-composition.spec.ts` 通过真实 Loader 抽取随包发布的 standard preset 压缩行与 OPL headless patch 并解析它们：OPL 路由在标称 1M 上得到 258400/244800/41344，在 64000 上得到 64000/64000/10240，而其他每个提供方都保持 800000/160000。既有的 `compaction-loop-repro.spec.ts` 真实循环套件固定了固定开销超过触发值的窗口仍能完成其轮次。

本次改动涉及的两个录播会话快照——`snapshots/acp/image-compaction` 与 `snapshots/session/compaction-recovery`——在该修复下重放通过，前提是检出内容解析了 ACP 边车符号链接，且 Windows agent shell 选择 git-bash（这是 fixture 录制的 `bash` 工具所要求的）。

## Consequences

模型保留其标称 1M 能力，而部署按 258400 token 进行规划、定价与接纳；该路由上的保留量为 41344 token 而非 160000；高于有效预算的请求绝不发送。失败以携带成因数字的错误形式可见。

代价有四。绝对触发值高于更小路由的预算时会收敛到该路由窗口，因此该路由在其窗口处压缩，而不是按配置份额压缩——这是有意为之，但也意味着一个绝对触发值无法在多种容量间保持成比例的余量。持续高于预算的序列如今使所在轮次失败，而过去会被尝试并可能在提供方处成功。已配置的预算把一部分保留量校验提前到加载时，因此过去能加载、在首次使用时才失败的配置如今会直接拒绝插件。此外 `PressureCompactionError` 与 `StepInputBudgetError` 加入本包的公开错误面，区分压缩失败的消费者必须处理它们。
