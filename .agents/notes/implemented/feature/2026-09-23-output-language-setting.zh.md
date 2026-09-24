# Agent Note: Output language setting

Status: implemented

[English](2026-09-23-output-language-setting.md) | 中文

## Problem

此前没有任何方式让用户选择模型的输出语言。浏览器 `locale` 段只管产品文案，部署 persona 文本由组合拥有，因此使用英文界面部署的中文用户，除非每次对话单独要求，否则收到的仍是英文回复与英文文档。harness 需要一个持久、用户可改的偏好，以及一条把该偏好作用于最终回复与 agent 生成的文档／报告的提示词通路。

## Decision

`dsh-system-prompt` 拥有 `output-language` 命名空间，字段为 `language: 'default' | 'zh' | 'en'`。段缺失时解析为 `default`，不渲染任何指令，因此已有用户文档保持该设置出现之前的行为，无需迁移。该段存放在唯一的 Host 范围设置文档中（文件提供方下为 `$DSH_HOME/settings.yaml`），因此重启后依然存在；设置接缝没有按工作区划分的层。

注册表把 `default` 渲染为空 `harness:output-language` 段，把 `zh`/`en` 渲染为一条指令：要求最终回复以及模型生成的每份文档、报告或说明文档使用该语言，同时保持代码、标识符、命令、文件路径与引用原文原样，并遵从用户对另一种语言的明确要求。段文本提供方在每次组装时重新读取已解析的设置，因此已提交的写入或外部文档编辑从下一次请求生效，无需重新注册该段。组合不新增配置字段：用户文档是唯一来源，其默认值为 `default`。

`OUTPUT_LANGUAGE_SECTION` 被导出，注册顺序为 `100` —— 位于 `deployment:persona-prefix` 之后、计划与工具指导之前 —— 且 `PromptSectionOrderName` 新增 `OUTPUT_LANGUAGE`。在 agent 作用域注册的同名段只对该 agent 遮蔽这条指令，沿用现有的作用域遮蔽规则。

Web 客户端在「设置 → 插件 → 插件配置」中把它呈现为**输出语言**卡片（`dsh-client-ui-settings-plugins`）。卡片只提供 Host schema 接受的三个值 —— 默认、中文、English —— 暂存一个选择并在保存时经由与其他插件卡片相同的、带 revision 栅栏的设置 scope 写入；重置会清除用户层，于是回落到未改动文档本就会解析出的同一个 schema 默认值。

指令只覆盖书面输出。它不声称控制模型内部推理，也没有任何代码为满足该偏好读取或改写 reasoning 内容；模型思考仍可能是中英夹杂。渲染后的提示词沿用既有的 `renderPrompt` → `system/message` 通路到达模型，因此该指令与其他段一样随提示词写入日志。

## Alternatives considered

**新增 `packages/context/output-language` 独立插件。** 为贡献一个提示词段，需要新的包骨架、base bundle 行和依赖边；而提示词注册表已被所有 profile 挂载，并拥有其他 harness 自有段，该段理应放在那里。

**在 `dsh-system-prompt` 上新增 `Config` 字段而不是设置命名空间。** 那只属于组合：用户无法在应用中修改，也不会持久化到设置文档。本需求是用户偏好，不是部署可调项。

**扩展已有的 `locale` 命名空间。** 该段由浏览器 locale 插件注册并写入；Host 提示词通路将读取一段外来的、无类型的段，而两个选择彼此独立——英文界面完全可以产出中文回复。

**在每个步骤或轮次注入 runtime 上下文消息。** pre-step 用户消息能穿透 `complete: true` persona 与上下文抑制，但它会在模型历史中重复正文、每步消耗 token，并扰动提示词前缀复用，而这条策略本应由提示词注册表拥有。

**过滤或改写 reasoning 内容以消除中英夹杂。** 已否决：该设置只作用于书面输出，provider 可见的 reasoning 历史不归它编辑，reasoning 协议处理另有归属。

## Consequences

该偏好是用户可见的产品设置：`default` 完全保持现有行为——未挂载设置提供方时组装结果与之前逐字节一致——`zh`/`en` 增加一个指令段，它在每次请求中重复；切换选择会使该段起的前缀复用失效。`complete: true` 的 persona（已交付的 `chat` 与 `minimal` 预设）会替换整份系统提示词，因此这些 agent 收不到输出语言指令。

`packages/core/system-prompt/tests/output-language.spec.ts` 逐字固定模型可见的指令文本，并覆盖该设置可能失败的场景：无设置提供方、段缺失、显式 `default`、早于该段的已有文档、`zh`、`en`、在线提交与重置、设置提供方晚于注册表挂载、整个上下文销毁重建后的持久化，以及全局作用域加按 agent 遮蔽。`packages/core/system-prompt/tests/system-prompt.spec.ts` 在每次组装中都固定这个新段。`packages/client/ui-settings-plugins/tests/output-language.client.spec.tsx` 固定卡片本身：两种界面语言下三个选项及其自称名称、暂存写入、在同一 Host 文档上重新挂载后的回读、未改动文档读作默认、移除覆盖项的重置、被拒绝的写入，以及命名空间不可用时不渲染任何内容。
