# Agent Note: Output language setting

Status: implemented

English | [中文](2026-09-23-output-language-setting.zh.md)

## Problem

Nothing let a user choose the language of what the model writes. The browser `locale` section governs product copy only, and deployment persona text is composition-owned, so a Chinese-speaking user of an English-UI deployment still received English replies and English documents unless they asked per message. The harness needed one durable, user-editable preference and a prompt path that applies it to final replies and to the documents and reports the agent produces.

## Decision

`dsh-system-prompt` owns the `output-language` namespace with `language: 'default' | 'zh' | 'en'`. An absent section resolves to `default`, which renders no directive, so an existing user document keeps the behavior it had before this setting existed and needs no migration. The section lives in the one Host-wide settings document (`$DSH_HOME/settings.yaml` under the file provider), so it survives restarts; the settings seam has no per-workspace layer.

The registry renders `default` as an empty `harness:output-language` section and `zh`/`en` as one directive asking for the language of final replies and of every document, report, or documentation file the model produces, while keeping code, identifiers, commands, file paths, and quoted source text unchanged and honoring an explicit user request for another language. The section text provider re-reads the resolved setting at every assembly, so a committed write or an external document edit applies to the next request without re-registering the section. The composition mounts no config field: the user document is the only source, and its default is `default`.

`OUTPUT_LANGUAGE_SECTION` is exported and registered at order `100` — after `deployment:persona-prefix` and before plan and tool guidance — and `PromptSectionOrderName` gains `OUTPUT_LANGUAGE`. A same-named section registered in an agent scope shadows the directive for that agent alone, the existing scoped-shadow rule.

The web client exposes the section as the **Output language** card on Settings → Plugins → Plugin configuration (`dsh-client-ui-settings-plugins`). The card offers exactly the three values the Host schema accepts — Default, 中文, English — stages one choice, and writes it on Save through the same revision-fenced settings scope every plugin card uses; Reset clears the user layer, which leaves the schema default the same untouched document already resolves.

The directive covers written output only. It makes no claim about the model's internal reasoning, and no code reads or rewrites reasoning content to satisfy the preference; reasoning text may still mix languages. The rendered prompt reaches the model through the existing `renderPrompt` → `system/message` path, so the directive is logged with the rest of the prompt like every other section.

## Alternatives considered

**A dedicated `packages/context/output-language` plugin.** It would need a new package skeleton, a base-bundle row, and a dependency edge to contribute one section that the prompt registry already owns; the registry is mounted by every profile and owns the other harness-owned sections, so the section belongs there.

**A `Config` field on `dsh-system-prompt` instead of a settings namespace.** Composition-only: a user could not change it from the app, and it would not persist in the settings document. The requirement is a user preference, not a deployment tunable.

**Extend the existing `locale` namespace.** That section is registered and written by the browser-locale plugin; the Host prompt path would read a foreign, untyped section, and the two choices are independent — an English UI can legitimately produce Chinese replies.

**Inject a runtime-context message on each step or turn.** A pre-step user message survives `complete: true` personas and context suppression, but it repeats prose in model history, costs tokens on every step, and unsettles prompt-prefix reuse for a policy the prompt registry exists to own.

**Filter or rewrite reasoning content to remove mixed-language thinking.** Rejected: the setting governs written output, provider-visible reasoning history is not this setting's to edit, and reasoning protocol handling is owned elsewhere.

## Consequences

The preference is a user-visible product setting: `default` preserves current behavior exactly — an assembly with no settings provider is byte-identical to before — and `zh`/`en` add one directive section, which repeats per request and invalidates prefix reuse from that section onward when the selection changes. `complete: true` personas (the shipped `chat` and `minimal` presets) replace the whole system prompt, so those agents receive no output-language directive.

`packages/core/system-prompt/tests/output-language.spec.ts` pins the model-visible directive text verbatim and covers the cases this setting can fail: no settings provider, an absent section, an explicit `default`, a pre-existing document without the section, `zh`, `en`, a live commit and reset, a settings provider attaching after the registry, persistence across a dispose-and-rebuild of the whole context, and the global scope plus per-agent shadow. `packages/core/system-prompt/tests/system-prompt.spec.ts` pins the new section in every assembly. `packages/client/ui-settings-plugins/tests/output-language.client.spec.tsx` pins the card: the three choices with their self-described names in both UI languages, the staged write, the read-back on a fresh mount over the same Host document, the untouched document that reads as Default, the reset that removes the override, a refused write, and the unavailable namespace that renders nothing.
