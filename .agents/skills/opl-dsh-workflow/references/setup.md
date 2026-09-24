# OPL DSH coordinator setup

The coordinator needs a running OPL DSH desktop with task feedback and permission services, and the repository's `apps/desktop/opl/opl-dsh-control.mjs`. The control script reads the desktop profile and uses its loopback endpoint and token internally. It does not start the desktop application. DSH continues to own the model, tools, permissions, and worker session; the Skill supplies the Codex coordination workflow.

Create a private JSON config outside version control. Required fields are `controlCli`, `ledgerDir`, and `targetThreadId`. `node`, `dshHome`, `timeoutMs`, and `pathMode` are optional. To let the Skill start DSH, add `startCommand`; `startArgs`, `startCwd`, and `startupTimeoutMs` are optional companions. Paths in the config must be absolute native paths; `node` and `startCommand` may be executables on `PATH`. The control timeout is a positive integer in milliseconds, at most 86400000; omission uses 150000. The startup timeout is at most 120000ms and defaults to 30000ms. Unknown fields are rejected.

```json
{
  "node": "node",
  "controlCli": "/absolute/path/to/opl-dsh/apps/desktop/opl/opl-dsh-control.mjs",
  "dshHome": "/absolute/path/to/dsh-home",
  "ledgerDir": "/absolute/path/to/coordinator-ledger",
  "targetThreadId": "the-codex-thread-id",
  "pathMode": "native",
  "startCommand": "/usr/bin/open",
  "startArgs": ["-a", "OPL DSH"],
  "startupTimeoutMs": 30000
}
```

When `control.json` is absent, the helper starts the configured command once, passes through the coordinator environment (including `DSH_OPL_HOME`), and waits for the same authenticated Desktop binding that `opl-dsh-control.mjs` reads. On Windows, use the installed executable path instead, for example `C:/Program Files/OPL DSH/OPL DSH.exe` with an empty `startArgs` array. If no launcher is configured, the helper remains probe-only and reports the missing binding.

Run the coordinator and desktop on the same native operating system. On Windows, use Windows Node and Windows paths; in JSON, escape backslashes or use forward slashes. Git Bash does not change the desktop's home or endpoint. WSL-to-Windows path bridging is not implemented: `pathMode: "wsl"` is rejected. Run the helper in the native Windows environment for a native Windows desktop.

## Task and operation identities

`--task` identifies the ongoing task and its DSH session. `--operation` identifies one initial prompt or continuation. Both accept 1–128 letters, digits, dots, underscores, colons, or hyphens, beginning with a letter or digit. Keep the same operation id and input files when retrying an interrupted command. Use a new operation id for a reviewed continuation, including an intentional repetition of the same prompt. The helper derives distinct feedback task ids and prompt request ids from these identities; receipts report both. Use the returned `taskId` for the control CLI's feedback commands.

`dispatch` creates a session, or adopts `--session` when explicitly supplied. `continue` reuses the task's session; it can initially adopt an explicit `--session` into a new local task ledger. `--cwd` is only valid on `dispatch` and must be an absolute existing directory. Omission creates a project-free session. `--provider` and `--model` must appear together; `--effort` requires both.

The helper checks effective session permissions before sending. An explicit `--preset` is installed only when creating a session; on an existing session it is an expectation, never a permission change. Without `--preset`, the first observed preset is recorded and later operations must still match it. If the effective preset changes, inspect the session and supply the intended preset explicitly. The helper never calls `selectPermissions` to widen an existing session.

## Retry and recovery

The private version 2 ledger preserves each operation's stages. It writes a complete temporary file, flushes it, and atomically renames it over the prior ledger. One exclusive lock protects the ledger during a command. A crashed process may leave a lock: check its recorded PID and verify that no command is still running before removing the stale lock. Do not remove a lock merely because a request is slow.

Creation records an explicit session id before calling DSH. If creation loses its reply, retry the same command to let DSH adopt that identity. A successful creation is recorded before model selection, permission validation, or feedback registration continues. A prompt with an uncertain reply remains `sending`; retry the same operation to resend only its stable request id, which DSH deduplicates. A `sent` operation returns its receipt without further control calls. Changed input under the same operation id is rejected.

A new continuation requires terminal feedback for the previous operation, no other active feedback task, no live session turn, and an empty inbox. Use an exclusively coordinated DSH session: do not submit prompts from another UI or coordinator during dispatch. Feedback registration observes the first subsequent turn and does not correlate a prompt request id, so concurrent external input cannot be attributed safely. Continuations retain parent/root feedback ids and the original automatic-resume budget.

Version 1 ledgers are rejected because they lack operation identities and may contain an ambiguous creation. Preserve the old file, inspect its session and task receipts through the control CLI, then use a separate version 2 ledger with `continue --session SESSION` only after the previous work is settled. Do not replay an unconfirmed prompt under a new operation id.

The helper requires a real target Codex thread id. It does not invent a thread, poll the desktop, or claim that an accepted prompt is running. Configure and test any wake/queue bridge separately; a successful local control RPC is not proof that a background Codex task will wake. Keep API keys, DSH tokens, credentials, and historical session ids out of committed configuration and documentation.
