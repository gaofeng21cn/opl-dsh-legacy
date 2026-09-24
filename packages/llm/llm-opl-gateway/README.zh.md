---
description: "面向 Harness 的 OPL Gateway 模型路由：用 OPL 账号登录即可访问网关承载的 DeepSeek 模型，无需分发供应商密钥。"
kind: "package-reference"
---

# @one-person-lab/dsh-llm-opl-gateway

[English](README.md) | 中文

## 概述

`dsh-llm-opl-gateway` 通过 OPL Gateway 账号提供 DeepSeek 模型，而不是使用直接的供应商密钥。在 OPL Gateway 设置页登录后，该路由会签发或复用该账号的推理密钥，只保存刷新令牌，并在每次请求时解析密钥。端点为 OPL 已记录的账号绑定，因此机器重启后仍可继续工作。自持供应商密钥的部署应挂载直接适配器。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发者备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在已加载 `dsh-llm` 的组合中挂载该行；该路由以 provider id `opl-gateway` 注册，并在模型选择器中显示为 **OPL Gateway**。

### 何时选择它

当使用者持有 OPL 账号、且部署方不得分发供应商密钥时选择它：账号页负责登录，适配器复用 OPL 为其自身客户端已提供的密钥。自持供应商密钥的部署应改用 `dsh-llm-deepseek`；无人登录的部署也不适用——既无密钥又无 OPL 绑定时，每次请求都会失败并指出无法解析的凭据引用。

### 最小配置

```yaml
- id: llm-opl-gateway
  name: '@one-person-lab/dsh-llm-opl-gateway'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `apiKeyEnv` | `OPL_GATEWAY_DEEPSEEK_API_KEY` | 每次请求解析的凭据引用；账号页在登录后写入 Gateway `DeepSeek` 分组签发的密钥。 |
| `baseURL` | 账号绑定记录的端点，否则为 `https://gateway.medopl.com/v1` | 推理根地址；插件优先使用绑定记录的值，而非内置根地址。 |
| `models` | 一个条目：`deepseek-v4.1-flash`，显示为 `DeepSeek-V4.1-Flash` | 选择器列出的建议目录。 |
| `thinking` | 供应商默认值 | `disabled` 会把该路由的每个对话请求限制为 `off`。 |
| `reasoningEffort` | 供应商默认值 | 该路由的默认推理强度。 |
| `maxTokens` | DeepSeek 适配器默认值 | 默认输出上限；模型自身上限与请求中的显式取值优先。 |
| `defaultContextWindow` | DeepSeek 适配器默认值 | 所选模型没有精确值时的上下文容量。 |
| `streamIdleTimeoutMs` | DeepSeek 适配器默认值 | 单次流读取未完成时的最大空闲时长。 |
| `retryPolicy` | 普通模式，五次重试 | 模型请求的重试策略。 |

生成的[配置目录](../../../docs/config-catalog.zh.md)是每个可接受字段及其 JSDoc 的完整来源。`llm-opl-gateway:` 设置分节可在不重启的情况下覆盖该行，Models 页面写入的正是该分节。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕——点击展开</summary>

### 一条路由，两个平面

适配器继承官方 DeepSeek Messages 适配器，保留原生 Messages 请求组装、流式输出、回放与 token 计量。OPL 搜索服务独立选择本地 Bing 检索或账号鉴权的 Responses 搜索。上游 DeepSeek 搜索提供者仍然独立。参见[桌面搜索设置](../../../apps/desktop/README.zh.md#desktop-control)。

| 文件 | 职责 |
|---|---|
| `src/config.ts` | 配置 schema、`OPL_GATEWAY_DEEPSEEK_API_KEY` 默认值、对外公布的模型，以及到适配器选项的转换。 |
| `src/index.ts` | 适配器子类、provider 身份、密钥解析顺序、设置分节安装与密钥采纳。 |
| `src/adoption.ts` | 用 OPL 绑定填充未设置或此前由本插件采纳的凭据引用，只记录密钥指纹而不记录密钥。 |
| `src/opl-credentials.ts` | 只读访问 OPL 状态目录：记录的绑定、绑定的 bearer 令牌，以及 OPL 观测到的账号事实。 |
| `src/account-service.ts` | `oplGatewayAccount` Remote：状态、登录、刷新、退出，以及本机所需的密钥。 |
| `src/gateway-control.ts` | 网关控制 API 客户端：登录、会话刷新、资料、用量、密钥分组，以及密钥创建或状态变更。 |
| `src/session-store.ts` | 以凭据记录保存的刷新令牌，以及 Harness home 中缓存的账号事实。 |
| `src/types.ts` | 通过本包 `remote` 子路径导出的线路安全账号词汇。 |

### 凭据从何而来

每次请求按同一顺序解析密钥：credentials seam 中 `apiKeyEnv` 的值，其次是 OPL 为其自身客户端记录的令牌，最后以指出该引用的失败告终。采纳面向配置界面而非请求路径——它只填充未设置、或仍保存着本插件此前采纳值的引用，因此 Models 页面输入的密钥不会被覆盖。请求路径与采纳读取同一绑定，且都不写入 OPL 状态。

### 控制平面与推理平面

网关在 `/api/v1` 提供账号管理、在 `/v1` 承载模型流量。登录用账号密码换取会话，把刷新令牌保存为凭据记录，并且仅当账号尚无推理密钥时才签发一把；退出会禁用本插件创建的密钥，而保留操作者自己输入的密钥。账号事实缓存在 `opl-gateway-account.json` 中，其新鲜度窗口与网关自身一致，因此重启后会立即显示账号，过期的观测会被如实标记为过期。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

当包级契约不够用时阅读这些页面。

- [dsh-llm 服务](../llm/README.zh.md)——本路由注册的与供应商无关的服务。
- [llm-deepseek 适配器](../llm-deepseek/README.zh.md)——本路由继承其请求组装的适配器。
- [OPL Gateway 设置页](../../client/ui-settings-opl-gateway/README.zh.md)——负责账号登录的浏览器半边。
- [credentials](../../credentials/credentials/README.zh.md)——保存刷新令牌并按请求解析引用的 seam。
- [settings](../../settings/settings/README.zh.md)——部署或 Models 页面写入该分节的文档。
- [LLM 流式子系统](../../../docs/subsystems/llm-streaming.zh.md)——被继承适配器所实现的流式契约。

-----

<a id="model-experience"></a>
## 模型体验

### OPL Gateway 请求

#### 模型看到什么

所选网关模型收到 Harness 组装好的请求且不作改动：system prompt、消息历史、工具 schema、停止序列，以及诸如 `maxTokens` 与 `reasoningEffort` 的调用配置。本路由不贡献自己的提示词文本，供应商特有的请求扩展字段留在模型输入之外。一个目录字段会改变请求摆放：声明 `systemPromptUpdate: in-history` 的条目会把 system prompt 变更追加在缓存历史之后，而不是重写它。

#### Token 影响

精确的文本与图像输入由供应商分词决定，网关回报的总量具有权威性。`maxTokens` 与记录的推理强度限定生成，`retryPolicy` 重发失败的请求而不改变其内容。切换该路由的端点或 `models` 条目会选中不同模型，输入 token 因而按该模型自身的计量方式统计。

#### KV Cache 影响

未改动的已组装前缀仍可被网关供应商复用缓存，回报用量中会体现。可能导致复用从第一个受影响 token 起失效的包内变更包括：端点、所选模型与公布的目录条目；声明 `systemPromptUpdate: in-history` 的条目让历史前缀在 system prompt 变更后仍可复用。供应商侧的缓存可用性与淘汰不在本包契约之内。

### OPL Gateway 响应

#### 模型看到什么

推理、文本与原始字符串形式的工具参数被转换为 Harness chunk，交由循环记录与组装；本路由不添加任何模型生成的内容。

#### Token 影响

生成的 token 遵循请求中记录的 `maxTokens` 与推理强度，且只有被循环保留的块会影响后续输入。

#### KV Cache 影响

被循环保留的响应块追加到下一次请求，并保留其此前可复用的前缀；被丢弃的块对后续缓存没有影响。切换供应商、端点或模型会选中不同的缓存域。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定该路由的边界；它们是当前包约束，不是网关路线图。

- **一条路由服务一个账号**——插件只持有本机登录的那一个 OPL 会话；需要多个账号的部署应以不同 provider id 与凭据引用挂载多行。
- **对话目录与搜索发现不同**——对话选择器使用配置条目；搜索设置可查询账号模型列表。能发现模型不代表它支持原生搜索。
- **退出只释放本插件签发的密钥**——Models 页面输入的密钥保持有效，因为账号页无法证明其归属。
- **账号读取依赖控制平面**——`/api/v1` 不可达时推理仍可工作，但页面无法刷新事实，并会把缓存的观测标记为过期。
- **搜索能力取决于路由**——OPL 搜索复用登录账号，但只有返回实际搜索来源的模型才能通过能力测试。上游 DeepSeek 提供者仍有独立的端点与凭据。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变量：** 不发布 companion。本包持有的每项可变关系都只有一个写入方——账户服务写入刷新令牌凭据、缓存的账户事实与已采纳密钥指纹——因此不存在可供比对的第二个独立观察。
