# Agent Note: OPL 搜索选择与桌面会话控制

Status: implemented

[English](2026-09-21-opl-search-and-desktop-control.md) | 中文

## Problem

OPL 对话凭据不能启用上游 DeepSeek 搜索端点。用户也需要让另一个编程助手向可见的桌面会话委派工作，而无需启动第二个 Agent 运行时。

## Decision

OPL 搜索服务可通过已有公共 HTTP 抓取提供者执行本地 Bing RSS 检索，或通过已有 OPL 账号执行云端 Responses 搜索。设置提供模型发现、显式能力测试、保存选择，以及按模型与发起会话分组的统计。失败请求也计数；缺失 token 用量保持未知。统计不存储查询和凭据。测试使用拟选配置，不改变已保存的选择。

Desktop Host 为已有 Remote 网关增加回环适配器。轮换的私有 bearer 绑定与有限的方法白名单保护会话和搜索操作。浏览器 Origin 被拒绝。内置 Windows 命令使用该适配器，因此可见会话、运行中的 Agent 与审批状态只有一个所有者；[控制 CLI 插话入口](2026-09-23-control-steer-entry.zh.md)记录其提示词投递模式与排队条目插话。快照读取在首帧后关闭流；关闭时取消未完成调用并等待结束。

这部分替代了[桌面打包记录](../architecture/2026-08-25-electron-desktop-packaging-and-updates.zh.md)的不开放端口限制；渲染进程管道、profile 独占与包归属仍以该记录为准。[上游默认搜索决策](2026-07-31-web-default-search.zh.md) 在 OPL 组合之外仍适用。

## Alternatives considered

仅通过 DeepSeek 对话路由搜索，会在网关转换丢弃搜索工具时失去原生检索。模型列表不能充分证明检索能力，因此测试要求实际来源。独立无界面进程会分离 GUI 审批与运行状态。仅靠像素自动化无法可靠关联请求受理与持久完成。

## Consequences

本地搜索无需额外凭据，但受网络可达性和搜索引擎验证失败影响。云端搜索消耗所选模型的额度；全文抓取仍使用本地网络。搜索计数是本地统计，不是账单依据。桌面控制让持有绑定的调用方访问当前用户的会话，不绕过工具权限。发送确认不代表完成；调用方需检查关联的会话记录。提供者、解析器与鉴权 HTTP 测试覆盖确定性边界；安装版桌面验收验证组合与依赖模型的路径。
