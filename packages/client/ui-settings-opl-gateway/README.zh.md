---
description: "dsh Web 客户端的 OPL Gateway 设置页：登录网关账号、查看余额与用量，并释放本机持有的密钥。"
kind: "package-reference"
---

# @one-person-lab/dsh-client-ui-settings-opl-gateway

[English](README.md) | 中文

## 概述

提供 OPL Gateway 账号与搜索设置页面。用户登录后可查看用量、两条通道的就绪状态，并管理搜索偏好。Host 负责认证、独立的 DeepSeek 与 Codex 密钥及模型请求故障切换；页面展示状态，不保存秘密值。

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

`dsh-client-ui-settings-opl-gateway` 为设置界面提供 OPL Gateway 账号页：用户用账号邮箱与密码登录，然后查看余额、当日与累计用量，以及推理密钥的状态。该页正是让 `opl-gateway` 模型路由的凭据得以解析的界面，因此在此登录就是该路由的配置步骤。事实来自适配器所读取的同一账号界面，超过新鲜度窗口的观测会被标为过期，而不会冒充当前值。

DSH 向 Gateway 申请 **DeepSeek** 分组的独立 API Key，并使用官方 DeepSeek 适配器。已有的 OPL 账号会话可提供登录状态；OPL App 使用的 Codex 分组推理密钥不是 DSH 密钥。独立的「搜索」页提供云端或本地搜索选择、测试和本机用量统计。

打开设置并选择 **OPL Gateway**，即可登录、刷新账号事实，或退出本机。

### 何时选择它

在挂载 `opl-gateway` 模型路由的地方一并挂载它，使该路由的使用者能在应用内登录。若本机的 OPL 安装已记录绑定，缺少本页仍可继续工作——适配器会申请 DeepSeek 分组的 DSH 专用密钥——但无人能从 Harness 内登录、刷新或释放密钥。提供直接供应商密钥的部署两者都不挂载。

### 最小配置

本页不需要配置，它是组合中的一个客户端插件行：

```yaml
- id: ui-settings-opl-gateway
  name: '@one-person-lab/dsh-client-ui-settings-opl-gateway'
```

该行与适配器的行配对；本页写入的正是适配器解析的凭据引用，因此只挂载其一，会得到一个其登录无人消费的账号页。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕——点击展开</summary>

本包分为两半。host 半边不注册任何内容；浏览器半边向 `settings.section` 账本贡献一个设置分节（id `opl-gateway`，顺序 30），并拥有自己的字典命名空间 `settings.oplGateway`。

每个操作都是对账号 Remote 的调用——`oplGatewayAccount.status`、`signIn`、`refresh` 与 `signOut`——业务失败会显示其消息，而错误码只作为支持凭据保留，不作为文案展示。密码仅在登录时穿过线路一次；Harness 之后保存的是刷新令牌，它与所有其他登录一样存放在 credentials seam 中。

| 文件 | 职责 |
|---|---|
| `src/index.ts` | host 半边：node 侧无需注册任何内容。 |
| `src/client/index.ts` | 分节注册、区域命名空间，以及由 Remote 支持的注入回调。 |
| `src/client/OplGatewaySection.tsx` | 页面本体：未登录表单、账号事实、新鲜度行与操作按钮。 |
| `src/client/locales.ts` | 两种语言的页面文案。 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

当包级契约不够用时阅读这些页面。

- [llm-opl-gateway 适配器](../../llm/llm-opl-gateway/README.zh.md)——本页为其确立凭据的路由。
- [ui-settings](../ui-settings/README.zh.md)——本页注册分节所依凭的设置外壳。
- [ui-primitives](../ui-primitives/README.zh.md)——本页组合所用的控件。
- [credentials](../../credentials/credentials/README.zh.md)——登录后保存刷新令牌的 seam。
- [remotes](../../api/remotes/README.zh.md)——账号方法所跨越的 Remote 边界。

-----

<a id="model-experience"></a>
## 模型体验

### 设置与通知

#### 模型看到什么

本页面本身不向 `GenerateOptions` 添加提示词或工具。账号配置会决定下一次请求使用的模型通道；通知仅展示已有任务状态。

#### Token 影响

页面和通知不额外调用模型。

#### KV Cache 影响

页面不直接修改缓存。切换通道后的缓存行为由对应模型适配器决定。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定本页的覆盖范围；它们是当前包约束，不是设置路线图。

- **每台机器一个账号**——本页登录单个 OPL 账号，下次登录会替换已保存的会话；切换账号意味着重新登录。
- **本页只读取事实，不负责配置**——端点、模型目录与推理强度仍位于 Models 页面与插件配置中，因此账号页无法改变路由指向。
- **不保存密码**——登录后仅保留刷新令牌，因此已保存会话无法续期的账号必须在本页重新登录。
- **事实可能过期**——本页显示最近一次观测及其新鲜度行，而不会阻塞在控制平面上；网关不可达时保留上一次观测。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变量：** 不发布 companion。本插件向槽账本贡献两个设置分区，并调用 Host 的账户与搜索 Remote；账户会话、缓存事实与槽注册分别属于 Host 服务与槽账本，因此本包不存在两个独立观察可能不一致的关系。
