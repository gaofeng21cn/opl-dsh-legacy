# Agent Note: Codex coordination uses the DSH feedback bridge

Status: implemented

English | [中文](2026-09-24-codex-dsh-coordination-skill.zh.md)

## Problem

Long OPL DSH tasks need a durable boundary between dispatch, model execution, human pauses, and Codex acceptance. Ad-hoc prompts can be duplicated after a timeout, lose their acceptance record, or be mistaken for completed work.

## Decision

The repository ships a portable Codex Skill at `.agents/skills/opl-dsh-workflow`. Its helper uses the existing desktop control CLI, registers task feedback before sending a prompt, persists an input fingerprint and request id, validates an explicit permission preset, and leaves ambiguous creation responses for inspection. The Skill defines stable consumer claims, bounded recovery for structured reasoning failures, human handling for input and approval pauses, and independent review before consumption. When a local start command is configured, it starts DSH and waits for the control binding. It neither owns credentials nor promises background wake delivery; the latter requires a separately configured bridge.

## Alternatives considered

- **Keep a machine-specific coordinator script outside the repository** — it can be convenient for one checkout, but it cannot be reviewed or reused and tends to leak paths, thread ids, and model choices.
- **Send prompts directly from the Skill without the control CLI** — this would duplicate token handling and bypass the durable task-feedback contract.
- **Treat accepted prompts as completed work** — this loses the distinction between admission, execution, failure, and human pauses.

## Consequences

The Skill can be installed with the repository and configured for native Windows, macOS, or an explicitly named WSL distribution. Each coordinator chooses its own private ledger and Codex target thread. Automatic notification still requires a separately verified wake bridge, while review and recovery remain explicit and bounded.

## Testing

`node --test .agents/skills/opl-dsh-workflow/scripts/dispatch.test.mjs` covers registration ordering, idempotent replay, conflicting inputs, ambiguous creation, and safe prompt retry.
