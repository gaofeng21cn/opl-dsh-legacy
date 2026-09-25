---
description: "Session V4→V5 相邻迁移：保留历史文件和事件坐标，扩展 rewind 消息来源词汇。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-format-v4-to-v5

[English](README.md) | 中文

## 概述

本包是 V4→V5 的相邻 Session 迁移。它保留 V4 header、事件、消息身份、序号和继承截点，只推进代际标记，使当前 Session 能识别 `rewind` 生产者来源。文件读取和后继文件发布由持久化层负责；本包负责编解码器、迁移阶段和目标校验。

## 目录

- [使用本包](#use-this-package)
- [V4→V5 规范](#v4-to-v5-specification)
- [实现说明](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

普通恢复请使用构建时固定的 [Session 格式目录](../session-format-catalog/README.zh.md)。直接导出用于目录组装和针对性测试。历史代际仍保留在磁盘上；持久化层只会在完成校验后把 V5 后继发布到源文件旁边。

```ts
import { sessionFormatV4ToV5 } from '@deepseek-ai/dsh-session-format-v4-to-v5'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
const sourceHeader = { version: 4, id: 'example', createdAt: 1, isSeeded: false, delegationDepth: 0 }
const physicalHeader = { ...sourceHeader, type: 'session' }
const targetHeader = sessionFormatV4ToV5.migrateHeader(sourceHeader)
const restore = sessionFormatCatalog.createRestore(physicalHeader, {
  recovery: 'strict', validation: 'current',
})
```

<a id="v4-to-v5-specification"></a>
## V4→V5 规范

该边界是有意设计的恒等转换。它复用 V4 物理 framing，原样输出每个事件和字段，并把 header 版本从 `4` 提升到 `5`。随后由当前 Session 校验 `rewind` 消息来源。不会重命名、重排、投影或丢弃事件。

V4 读取器会拒绝 V5 header。V5 读取器保留此前所有相邻迁移，只对 V4 输入使用这条边界。缺少继承标记、V4 行损坏、未知必需事件或当前消息来源无效时，恢复会拒绝并且不会发布后继文件。

<a id="understand-the-implementation"></a>
## 实现说明

| 文件 | 作用 |
|---|---|
| `src/codec.ts` | 在已发布 V4 framing 上提供 V5 header 与行编解码 |
| `src/migration.ts` | 保留事件和继承截点的流式恒等阶段 |
| `src/validation.ts` | V5 header、行和完整 artifact 校验 |
| `src/index.ts` | 相邻迁移的公共导出 |

本包没有 Cordis 挂载，也不会发起模型或网络请求。目录生成器通过 package manifest 中的 `dsh.sessionFormatMigration` 发现它。

<a id="further-exploration"></a>
## 进一步阅读

- [V3→V4 迁移](../session-format-v3-to-v4/README.zh.md)——前一条结构迁移。
- [Session 格式目录](../session-format-catalog/README.zh.md)——完整历史恢复和当前校验。
- [JSONL 持久化](../session-persistence-jsonl/README.zh.md)——源代际检查与后继发布。
- [Session 格式状态](../../../docs/session-format-status.zh.md)——定稿与发布代际的权威记录。

<a id="model-experience"></a>
## 模型体验

### Session 恢复

#### 模型看到的内容

模型看到的投影消息与 V4 artifact 相同。`rewind` 标记是空的 developer replacement，不会成为模型可见内容。

#### Token 影响

迁移不会增加消息或 token。

#### KV Cache 影响

事件和消息身份保持不变，当前投影可以稳定复用；缓存行为取决于恢复后的对话。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **一条相邻边界**——本包只处理 V4 输入，更早格式由前置边界负责。
- **不改写源文件**——发布和文件锁由 JSONL 持久化提供方负责。
- **不产生外部轨迹**——迁移不会暴露模型推理、工具活动或网络诊断。

<a id="dev-note"></a>
### 开发备注

无。

本包不发布运行时不变量 companion，因为这个纯迁移库不持有可独立变化的运行时状态。
