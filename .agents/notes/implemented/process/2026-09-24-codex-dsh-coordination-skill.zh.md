# Agent Note: Codex 协调使用 DSH 反馈桥

Status: implemented

[English](2026-09-24-codex-dsh-coordination-skill.md) | 中文

## Problem

长时间运行的 OPL DSH 任务需要在派发、模型执行、人工暂停和 Codex 验收之间建立持久边界。临时发送提示可能在超时后重复、丢失验收记录，或被误认为已经完成。

## Decision

仓库提供可移植的 Codex Skill：`.agents/skills/opl-dsh-workflow`。其辅助脚本复用已有桌面控制 CLI，在发送提示前注册任务反馈，持久化输入指纹和请求 ID，校验明确的权限预设，并在创建响应含糊时停下等待检查。Skill 定义稳定的消费者认领、结构化推理失败的有界恢复、输入与审批暂停的人工作法，以及消费前的独立验收。配置本机启动命令后，它会启动 DSH 并等待控制连接就绪。它不持有凭据，也不承诺后台唤醒投递；后者需要另行配置桥接。

## Alternatives considered

- **继续把机器专用协调脚本放在仓库外**：一个 checkout 使用方便，但无法审查或复用，也容易泄露路径、线程 ID 和模型选择。
- **Skill 绕过控制 CLI 直接发送提示**：这会重复实现令牌处理，并绕过持久化的任务反馈契约。
- **把已接纳的提示视为已完成任务**：这会丢失接纳、执行、失败和人工暂停之间的区别。

## Consequences

Skill 可随仓库安装，并配置为原生 Windows、macOS 或明确指定的 WSL 发行版。每个协调器使用自己的私有账本和 Codex 目标线程。自动通知仍需要单独验证唤醒桥，而验收与恢复保持显式且有界。

## Testing

`node --test .agents/skills/opl-dsh-workflow/scripts/dispatch.test.mjs` 覆盖注册顺序、幂等重放、输入冲突、创建响应含糊和安全的提示重试。
