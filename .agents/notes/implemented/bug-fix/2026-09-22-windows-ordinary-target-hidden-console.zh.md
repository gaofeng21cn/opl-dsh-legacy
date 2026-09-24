# Agent Note：Windows 普通子进程目标拥有隐藏控制台

Status: implemented

[English](2026-09-22-windows-ordinary-target-hidden-console.md) | 中文

## 问题

打包版 Windows 桌面端中，每次工具调用都会在用户前台弹出一个空白终端窗口，并持续整个命令时长。受影响机器上的顶层窗口观测记录到：每次普通命令都会新建一个 1199x616 像素的 `CASCADIA_HOSTING_WINDOW_CLASS` 窗口，创建时 `visible=false`，数毫秒后 `visible=true`，命令退出时销毁；取消命令时再出现一次。因此一条两秒的命令会让该窗口显示约两秒。源码与开发模式运行从未出现该窗口。

启动链路就是全部原因。Electron shell 以 `windowsHide` 启动 dsh Host；Host 再以 `windowsHide`、以 `process.execPath` 启动 Windows Job runner；runner 通过 `CreateProcessW(..., CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT, ...)` 创建普通目标。打包应用中 `process.execPath` 是 Electron 二进制——GUI 子系统映像——而 Windows 明确规定：应用不是控制台应用时 `CREATE_NO_WINDOW` 会被忽略，因此 Host 与 runner 都不持有控制台。于是以控制台子系统实现的 target（`bash.exe`、`git.exe`、`node.exe`、`pwsh.exe`）在没有可继承控制台的情况下被创建时会获得一次全新的控制台分配，而 Windows 把该分配交给默认终端应用，由它渲染成窗口。“目标继承 runner 隐藏控制台”这一假设只在 runner 映像本身是控制台应用时成立，也就是源码与开发形态（`node.exe`），而不是打包形态。

## 决策

`spawnCurrentTokenJobProcess()` 在 `CREATE_SUSPENDED` 与 `CREATE_UNICODE_ENVIRONMENT` 之外传入 `CREATE_NO_WINDOW`，因此每个 Windows 普通目标都拥有隐藏控制台，其后代继承该控制台，而不是向 Windows 申请新的控制台。该常量与其他 `CreateProcess` 标志一同由 `abi.ts` 拥有。

runner 保留 `windowsHide: true`：它负责隐藏控制台子系统的 runner 映像，而打包形态的 GUI runner 并不需要它。[桌面执行环境](../architecture/2026-09-22-desktop-execution-environments.zh.md)记录中“隐藏 runner 即可让工具调用不占用户前台”的说法在此更正为创建标志。

受限令牌路径的标志保持不变。`spawnInheritedJobProcess()`（`CreateProcessAsUserW`，Windows ACL 沙箱子进程）仍然不自行创建控制台，因为在 `WRITE_RESTRICTED` 令牌下 `CREATE_NO_WINDOW` 会以 `STATUS_DLL_INIT_FAILED` 死亡。沙箱本身、其 SID 列表、以及它在受限模式下拒绝 Git Bash 的行为都没有变化；普通目标新增的隐藏控制台是被受限子进程继承的，而不是由它申请的。

## 考虑过的替代方案

**以打包的 Node.js 运行时可执行文件启动 runner。** 控制台子系统的 runner 会拥有隐藏控制台，其普通子进程与受限子进程都能继承，从而也关掉受限令牌路径的窗口。本次未采用，因为它会改变打包版每次工具调用所执行的可执行文件，以及该 runner 的解析与原生模块加载，而所报告的缺陷用创建标志即可消除。

**`CREATE_NEW_CONSOLE`。** 它的作用就是创建控制台窗口，也就是要消除的现象本身。

**对 target 使用 `DETACHED_PROCESS`。** 分离进程没有控制台，因此每个控制台子系统孙进程都会自行分配窗口：同一缺陷下移一层。

**在 runner 中 `AllocConsole()` 后再 `ShowWindow(SW_HIDE)`。** 窗口在被隐藏之前已经存在，而这次出现正是要修复的干扰；事后隐藏还会让结果依赖调度时序。

**在 `spawnInheritedJobProcess()` 中使用 `CREATE_NO_WINDOW`。** 受限子进程会在 DLL 初始化期间以 `STATUS_DLL_INIT_FAILED` 死亡，这一点已由沙箱 README 记录为实测结果。

## 影响

打包版桌面端不再为 Windows 普通命令打开控制台窗口，`git.exe`、`node.exe`、`pwsh.exe` 及其他控制台子系统后代都继承 target 的隐藏控制台，而不再自行分配。stdio 处置、退出码、argv 引号处理、Unicode 与含空格路径、Job 拥有的进程树取消、以及 ConPTY 终端路径均不受影响：该标志只决定控制台分配，而在 harness 直接以子进程方式启动控制台子系统子进程的地方，Node 的 `windowsHide` 本就应用同一标志。

target 不再能呈现自己的控制台。harness 中没有任何部分依赖这一点：模型命令是带重定向 stdio 的后台子进程，用户打开的终端是终端 seam 上的 ConPTY 会话，而不是普通 spawn。

仍有两处 Windows 控制台来源，二者均经实测而非假定排除。受限令牌子进程仍会分配窗口，因为它无法申请隐藏控制台，而其父进程——windows-acl runner，同样是 GUI 子系统的 Electron 映像——没有可传递的控制台；在 runner 映像拥有控制台之前，该路径保持现状。win32 沙箱档位的功能探针通过 `spawnSync` 在本边界之外启动其 runner，因此探测该档位的覆盖链仍可能分配窗口；产品链路从不探测该档位。

## 测试

`packages/subprocess/win32-process/tests/ordinary-process.spec.ts` 在与 Job 分配、恢复顺序相同的断言中钉住普通创建的精确标志（含 `CREATE_NO_WINDOW`）；移除该标志时该测试失败。

真实窗口观测在 Windows 11 上使用打包形态：分离的 GUI Electron 父进程（无控制台）→ `LocalSubprocessRuntime.spawn()` → `probeWindowsJob()` → Job runner → `bash.exe`。在修复前的源码上，观测器为一条前台命令和一条取消命令记录到可见的 Windows Terminal 窗口；加上该标志后，前台命令、取消命令与持久 ConPTY 终端都没有记录到任何控制台窗口，同时正确报告了命令的退出码、输出、取消与终端回显。read-only 受限令牌下的 `cmd /c echo` 仍显示窗口，即上文所述的遗留项。
