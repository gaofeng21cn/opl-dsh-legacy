# OPL DSH coordinator setup

The coordinator needs a running OPL DSH desktop and the repository's `apps/desktop/opl/opl-dsh-control.mjs`. The control script reads the desktop profile from the DSH home and uses the loopback endpoint and token internally. It does not start the desktop application.

Create a private JSON config outside version control. The required fields are `controlCli`, `ledgerDir`, and `targetThreadId`; `node` and `dshHome` are optional when the runtime and DSH home are already in the environment.

```json
{
  "node": "node",
  "controlCli": "/absolute/path/to/opl-dsh/apps/desktop/opl/opl-dsh-control.mjs",
  "dshHome": "/absolute/path/to/dsh-home",
  "ledgerDir": "/absolute/path/to/coordinator-ledger",
  "targetThreadId": "the-codex-thread-id"
}
```

On Windows, use a Windows Node executable and Windows paths when the desktop runs natively. Git Bash is only a shell; it does not change the desktop's home or endpoint. For WSL, set `pathMode` to `wsl` and provide the exact `wslDistro`; never infer a distro or translate paths by string replacement. Keep the ledger on the side that owns the coordinator process.

The helper requires a real target Codex thread id. It does not invent a thread, poll the desktop, or claim that a prompt is running from an `accepted` response. Configure and test any wake/queue bridge separately; a successful local control RPC is not proof that a background Codex task will wake.

Keep this file and the config free of API keys, DSH tokens, credentials, machine-specific user data, and historical session ids. Add the private config to `.gitignore` or store it outside the repository.
