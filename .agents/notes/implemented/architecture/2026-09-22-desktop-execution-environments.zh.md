# Agent Note：桌面端执行环境与事件驱动会话等待

Status: implemented

[English](2026-09-22-desktop-execution-environments.md) | 中文

## 问题

桌面端此前只在内置的 Windows Node.js 下运行完整 Harness。项目与工具链位于 WSL2 的操作者，要么把工作放在 Windows 磁盘上、让每次文件操作都跨越 Linux/Windows 边界，要么在发行版内再跑一个彼此独立的 Harness，从而失去 GUI 对会话、审批和运行时状态的单一所有权。没有任何机制能让一个桌面端同时拥有两者。

与此无关的另一问题：通过本地控制端点驱动桌面端的程序，只能得知提示已被受理，而无法得知它已完成。唯一可用的证据是 `send` 的确认，因此调用方只能轮询持久记录、并按时间推断完成；与 Host 位于同一发行版中的调用方，每次这样的调用还必须跨越 Windows 互操作。

## 决策

**执行环境是启动时的选择，在同一个 Host 组合之上有两种 transport。** `$DSH_HOME/desktop/execution-environment.json` 中已保存的选择决定某次启动所用的环境，因此选择 WSL2 并重启即会启动 WSL2 Host。进程环境覆盖（`DSH_DESKTOP_ENVIRONMENT` 配合 `DSH_DESKTOP_WSL_DISTRO`）作为有意的单次启动选择优先于它。无法满足的选择会在启动页失败；桌面端绝不回退到 Windows 本机，因为那会让用户运行在其 Linux 会话与插件都不在的地方。Windows 本机沿用分帧字节管道；WSL2 在一个发行版内运行同一个已安装的 dsh Host，并通过鉴权回环连接访问它。两种 transport 分派到由同一个 `composeDesktopHost` 组装的同一套插件树、Remote 网关、资源路由和客户端资源，因此该选择选定的是 transport，而不是某种 Agent 实现。

**`wsl.exe` 只负责启动、探测和生命周期管理，绝不包装工具调用。** Linux Host 每次启动只启动一次并持续运行。逐次包装会让每次调用都付出进程启动成本，使每个工具游离于 Host 自身的沙箱之外，并把生命周期所有权拆到两套实现上。

**WSL2 transport 绑定回环，并用每次启动的令牌鉴权。** Host 通过仅所有者可读、经 rename 写入的文件发布带版本的绑定——端点、bearer 令牌、进程 ID。Windows 侧会校验版本、拒绝非回环端点，并把握手超时、令牌被拒、Host 会话中途退出报告为彼此不同的失败。不额外暴露端口，也不运行第二个 Agent。就绪的判据是端点能接受连接，而不是绑定文件出现：WSL2 会把 Windows 的回环连接转发进发行版，而该转发比发行版自身的绑定滞后约一秒，因此只信任该文件的启动器会在每次启动后的第一个请求上失败。

**运行时状态按环境隔离，且 WSL2 一侧位于发行版内部。** Windows 本机沿用既有的 `$DSH_HOME` 布局，因此既有安装不受影响。WSL2 Host 把其 Harness home、profile、会话、缓存与凭据保留在发行版内（默认 `~/.dsh-opl`，可由 `DSH_DESKTOP_WSL_HOME` 覆盖）。因此两种环境绝不会写入同一个数据库，也不会把在 Windows 上准备的 profile（其原生模块是 Linux 无法加载的 Windows 二进制）交给 Linux Host。Windows 进程环境中的任何内容都不会跨越边界：`WSLENV` 被显式设置，因此环境中的 Windows 取值无法转发本进程的 `DSH_HOME` 或其凭据。发行版中尚不存在的 profile 目录会在该处创建，并使用打包运行时已携带的 bundle，因为发行版不运行包管理器，而 profile 清单就是组合后的 Host 所读取的全部 profile 内容；已存在的清单保持不变。

**Linux Host 触及的每个路径都会在启动前完成转换。** 内置负载、profile 与绑定文件都位于 Windows 磁盘上，发行版通过 `/mnt/<盘符>` 访问它们；`resolveWslLaunchPlan` 从 Windows 侧的事实推导出全部这些路径，而在发行版内无法表达的路径会让启动失败，而不是被交给 Linux。绑定文件刻意放在共享磁盘上，使 Linux 写入方与 Windows 读取方指向同一个文件。盘符路径映射为 `/mnt/<盘符>`，`\\wsl$` UNC 路径映射为 Linux 路径，指向其他发行版的路径会被拒绝，位于 `/mnt/<盘符>` 的项目被允许使用并给出明确的性能提示，而不是被悄悄迁移。

**Windows 安装包携带其 WSL2 环境所运行的 Linux 负载。** `resources/wsl` 中包含一个 Linux Node.js 可执行文件、一棵 dsh 树（其生产安装在一个发行版内执行，因此原生模块是 Linux 构建）以及一份清单。`prepare:wsl` 构建它，`package-target.ts` 在 Windows 目标上运行它，electron-builder 将其映射进 `extraResources`。在 Windows 上安装该树再复制会携带 Windows `.node` 二进制，这正是安装必须在 Linux 上执行的原因。该安装需要三项打包主机默认不提供的前提：Linux Node 所在目录必须出现在 `PATH` 上，因为依赖的 lifecycle 脚本按名字调用 `node`，而 `wsl.exe --exec` 不启动登录 shell；生成的工作区必须按 pnpm 的规范 `file:` 规格（会去掉开头的 `./`）为被打包的 subprocess 包登记 `allowBuilds`；复制过滤器必须按发行版的平台判定，从而保留 `node-pty` 的 Linux prebuild，而不是打包主机的。随后 `verify-opl-package.mjs` 要求每个 Windows 应用树都带有 Linux x64 ELF Node.js 可执行文件、私有 Host 入口以及该 Linux PTY addon，因此安装包无法在缺少使其可用的文件时声称支持 WSL2。

**会话等待由事件驱动，并依据持久事实结算。** `session.wait` 订阅 `session/event`，在目标 `turn/end` 原因——`completed`、`failed` 或 `cancelled`——时结算，或在有待处理审批时以 `needs-input` 结算。它绝不轮询。只有活跃 driver 仍能发布事实时，该 Session 才算仍在工作：存在打开的轮次，或该 Agent 的 driver 处于 `running`。仅已注册并不算：Agent 在最后一轮结束后仍保持注册但处于空闲，且除非新输入唤醒它，否则不会再开启轮次——这正是父会话在最后一个子任务或子智能体结束后所处的状态，而依据注册等待会让调用方再也等不到可结算的事件。driver 进入空闲也会释放其等待者，已结算的 Session 报告其记录的内容。唤醒输入会在轮次开启前让 driver 进入 `running`，因此 `prompt` 之后的 `wait` 仍能观测到该提示自身的轮次，而不是它之前的状态。

## 考虑过的替代方案

**把整个 Windows 桌面壳放进 WSL2。** Electron 应用、其窗口和安装包都是 Windows 产物；迁移它们会为了换来一个文件系统而放弃既有的安装、更新与签名体系。

**把每次工具调用都包进 `wsl.exe`。** 理由同上：逐次进程启动成本、不属于拥有它的 Host 的沙箱，以及两个生命周期所有者。

**把发行版根目录挂载为 `\\wsl$` 共享，让 Windows Host 访问它。** 每次文件操作都会跨越该特性本就要规避的同一边界，而且 Host 的沙箱会用 Windows 进程在 Linux 文件上执行 Windows ACL。

**让 Windows 本机与 WSL2 共用一个数据库。** 两个平台相关的运行时写入同一个仅追加日志，会造成损坏而非仅仅过期。隔离是让两者都可恢复的唯一选择。

**轮询持久记录以判断完成。** 不引入静默期就无法区分“轮次很慢”和“已完成”，而且开销随等待者数量增长。

**也让 `user-questions` 暂停上报 `needs-input`。** `user-questions` 接缝是没有持久结算事件的实时 waterfall，因此等待只能从外围工具结果推断答案。只有审批带有持久括号，所以只上报审批；这一缺口会被明确说明，而不是掩盖。

**向现有 Codex 桌面任务注入消息。** 不存在公开接口。稳定的 DSH 事件流是未来常驻协调器可以消费的接口，而 Codex 自动化仍只是周期性巡检兜底。

## 结果

Windows 本机仍是默认项，所有既有安装保持当前行为、数据和插件。切换会被记录，并在下一次重启时生效；正在运行的会话保持其环境，设置界面会如此说明，而不会暗示已实时切换。

WSL2 需要已安装的发行版、不低于内置主版本的 Linux Node，以及随包提供的 Linux 负载。缺少任一项的机器会让启动以具体原因失败，而不是回退到 Windows 本机。发现过程读取 Windows 注册表，因此为其他 Windows 用户安装的发行版不会被列出。

打包 Windows 发行版现在要求构建机上存在可用的 WSL2 发行版，因为 Linux 树的原生模块必须由 Linux 包管理器安装。没有发行版的构建会在 `prepare:wsl` 处失败，而不会产出无法提供其所声称环境的安装包。Linux 负载由同一轮构建刚刚打包出的包集合构成，因此负载的新旧程度不会超过它之前那次工作区构建。

位于 Windows 磁盘上的项目在 WSL2 中仍可使用，但明显更慢，这一点会被说明而不是被禁止。同一台机器上的两种环境各自保留会话，因此在其中一种下启动的会话在另一种下不可见；这是让两者都可恢复所付出的代价。由于 WSL2 的 home 与 profile 位于发行版内，通过「桌面插件」安装的 Windows 侧插件仅作用于 Windows 本机。

`session.wait` 只对审批上报 `needs-input`，在结算或调用方取消前持有一个 `session/event` 订阅，且控制调用自带截止时间，因此长等待不会被误判为超时。请求仍然只向外流向 Host，因此该等待不会改变调用方可以做的事。

桌面端与 subprocess 层所拥有的每个 Windows 后台子进程都设置了隐藏控制台：dsh Host、内置 pnpm 事务、Windows Job runner 以及构建辅助进程。打包版 shell 的 Host 与 runner 都运行在 GUI 子系统的 Electron 映像上，自身没有可传递的控制台，因此每个普通目标都以 `CREATE_NO_WINDOW` 创建并拥有隐藏控制台，供其后代继承（[普通目标的控制台](../bug-fix/2026-09-22-windows-ordinary-target-hidden-console.zh.md)）。受限令牌子进程保留其所有者的控制台，因为在 `WRITE_RESTRICTED` 令牌下使用 `CREATE_NO_WINDOW` 或 `CREATE_NEW_CONSOLE` 会以 `STATUS_DLL_INIT_FAILED` 失败，而 runner 映像自身没有控制台时它们仍会自行分配一个。显式打开的终端与 PTY 不受影响。

## 验证

- `apps/desktop/tests/execution-environment.spec.ts` 覆盖选择校验、所有路径形式与转换方向、跨发行版拒绝、盘符挂载提示，以及状态根隔离。
- `apps/desktop/tests/wsl.spec.ts` 覆盖注册表发现、发行版选择、探测结果、Host 启动形态、启动器环境契约，以及精确的已转换启动计划。
- `apps/desktop/tests/wsl-transport.spec.ts` 运行真实的回环服务端与客户端：鉴权、令牌拒绝、版本拒绝、握手超时、就绪性、启动失败、取消与停止。
- `apps/desktop/tests/wsl-real.spec.ts` 在本机装有发行版时针对该发行版运行该 transport，否则自动跳过：`wsl.exe` 启动一个 Linux Node 进程，该进程发布绑定，Windows 侧完成握手并在鉴权回环连接上抓取。
- `apps/desktop-host/tests/desktop-profile.spec.ts` 覆盖首次 WSL2 启动所创建的 profile：清单列出全部 Desktop bundle，且已存在的清单被保留。
- `apps/desktop/tests/execution-environment-store.spec.ts` 覆盖持久化、默认值与不可读文件的上报。
- `apps/desktop/tests/main-startup.spec.ts` 覆盖重启回归：已保存的 WSL2 选择会以已转换的调用启动 WSL2 Host，字节管道 Host 绝不被创建，显式覆盖仍然优先，运行中的 WSL2 环境被报告为当前环境，无法满足的选择会明确失败。
- `apps/desktop/tests/plugin-manager.spec.ts` 覆盖设置界面的「当前/重启后」区分、不可用发行版和无可用发行版状态。
- `apps/desktop/tests/opl-windows-package.spec.ts` 覆盖 Windows 负载：完整的树通过，缺失 Linux Node、Host 入口、Linux PTY addon 或整个负载的树被拒绝。
- `apps/desktop/tests/core-package-set.spec.ts` 覆盖生成的项目为被打包的 subprocess 包 postinstall 登记 `allowBuilds` 时所使用的键。
- `apps/desktop/tests/windows-console.spec.ts` 与 `packages/subprocess/subprocess-local/tests/windows-job.spec.ts` 在每个 Windows 后台 spawn 入口断言隐藏控制台契约。
- `packages/api/session-controller/tests/wait.host.spec.ts` 在真实 agent loop 上运行该等待：四种结果、精确轮次等待、已结算会话、取消、插件新增的原因变体按失败处理，以及生命周期回归——父会话在最后一个子任务结束后其最后一轮已关闭且 Agent 仍处于注册状态时会结算，运行中的 driver 会让等待保持打开，driver 进入空闲会将其释放，无关的生命周期流量被忽略。
- `apps/desktop/tests/control-bridge.spec.ts` 覆盖等待的白名单与调用方截止时间超时。
