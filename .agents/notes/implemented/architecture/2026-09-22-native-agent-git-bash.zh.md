# Agent Note：Native Agent shell 选择

Status: implemented

[English](2026-09-22-native-agent-git-bash.md) | 中文

## 问题

Windows Native Agent 需要 Bash 命令语法，同时不把会话或工具迁入 WSL。仅选择集成终端不会改变模型工具或子进程执行。

## 决策

内置 boot 仅读取一次 shell 选项及可选的 Git for Windows 路径。宿主执行器和四种预设均使用该启动选择。设置卡片原子保存相关字段，验证可执行文件身份，并说明 shell 变更需要完全重启。执行预算仍实时生效。Windows 继续默认使用 PowerShell；POSIX 宿主继续使用 Bash。

Git Bash 在 Windows 受限模式下经由 broker 处理，而不是假定可用。一次性 bash 执行器会收束它自己拥有的启动参数——工作目录必须在 MSYS/Windows 写法、`..` 穿越、盘符切换、UNC 前缀与重解析点统一为同一比较键之后仍落在模式的授权根内，`HOME` 固定到工作区，越界的 shell 启动文件变量被置为 tombstone——然后用真实后端运行真实可执行文件。能力探针证明两个维度：MSYS 运行时能在受限令牌下启动，以及模式的写入边界成对成立（工作区内写入符合模式语义——`workspace-write` 下创建成功、`read-only` 下被拒——而每个可写根之外的写入被拒）。任一维度无法证明时，启动在 spawn 前以 `SANDBOX_UNAVAILABLE` 拒绝，绝不降级为不受限运行。

路径归一化遵循 Git for Windows 实际定义的挂载点：`/c/…` 为盘符、`/tmp/…` 为用户临时目录、`//server/share/…` 为 UNC 共享，其余绝对 MSYS 路径位于 `/` 背后的安装根目录下。`/mnt/…` 与 `/cygdrive/…` 作为 Git Bash 未挂载的 WSL/Cygwin 盘符写法被拒绝，而不会被猜测为盘符。当前主机上受限令牌无法初始化 MSYS 的每用户共享映射，因此 Git Bash 只能在明确批准的 `danger-full-access` 下运行。持久 PTY 终端保留静态拒绝，因为它的会话 shell 在任何能力探针授权之前就已经存在。MSYS 以只列出用户 SID 的安全描述符创建这些每用户对象，受限令牌的写入检查永远匹配不到它们，而把用户 SID 加入限制列表也会同样授权所有环境写入；模式只约束文件写入，因此读取、进程启动与网络访问仍由审批层和宿主自身权限负责。

## 考虑过的替代方案

仅热切换执行器会使模型工具及随后挂载的预设使用不兼容的命令语言。通过 System32 bash 启动 WSL 会改变文件系统与进程归属。自动回退 PowerShell 会把 Bash 文本交给错误的解析器。添加用户 SID 或不受限重试会削弱权限约束。因此不采用这些方案。

## 结果

用户可为已授权完全访问的 Native 工作选择 Git Bash，只读或工作区内修改继续使用 PowerShell。切换选项不迁移对话，也不改变权限模式。标准设置文档管理内置选择；自定义 settings-file 部署自行管理对应组合。

## 验证

Windows 测试通过真实 Loader、文件设置与子进程提供者启动，覆盖中文及空格路径、原生 Node/Git、退出输出、取消、超时、不可变启动选择和持久 PTY 后端。受限测试断言启动前拒绝、权限模式不变、守卫先于探针、junction 越界、外来挂载与穿越写法的工作目录拒绝，以及已批准运行的进程树清理。broker 单元测试固定 MSYS/Windows 路径统一（盘符、UNC、设备前缀、`/tmp`、安装根目录，以及被拒绝的 `/mnt`/`/cygdrive` 写法）、启动守卫与 PTY 静态拒绝；执行器级测试通过脚本化 subprocess 缝隙驱动真实探针，固定两个已证明维度、边界内对照、泄漏与未创建文件两种失败，以及找不到可用探测位置时的拒绝。组合测试覆盖所有内置预设与 POSIX 门控，并断言没有任何内置行挂载不受限的 `dsh-bash-local`。Windows 控制台隐藏沿用现有子进程实现；这些测试没有独立验证可见弹窗行为。受限 Git Bash 的实际执行路径未在本机验证——探针在 MSYS 运行时维度即失败——POSIX 通道负责 bwrap/Landlock/Seatbelt 套件。
