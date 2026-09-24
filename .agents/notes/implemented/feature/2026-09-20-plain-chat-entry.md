# Agent Note: Plain chat without workspace selection

Status: implemented

The new-session entry policy is superseded by [independent session projects](2026-09-20-independent-session-projects.md). This note describes the retained legacy chat preset.

English | [中文](2026-09-20-plain-chat-entry.zh.md)

## Problem

The GUI requires a workspace before accepting a first message, although questions, translation, and writing do not require local project access.

## Decision

The conversation hero and sidebar offer a plain-chat entry. A fresh installation with no workspace opens a blank chat. These sessions use the shipped chat preset, which contains a conversational persona and context compaction but no model-facing tools or workspace instructions. The existing session creation API records the preset and uses the Host working-directory default internally; no Workspace is created or attached. Session persistence and restart restore the recorded composition through the existing preset projection.

The sidebar groups these sessions under Chats, separately from orphaned project sessions. The project mode picker and preset management choices exclude chat. Recomposition refuses moving a chat into another preset, even before its first message. Opening a workspace creates or reuses a separate project session.

## Alternatives considered

**An implicit folder with the standard preset.** This removes the folder dialog but gives an ordinary conversation local tools. It does not match the visible capability boundary.

**A new session format or a second chat database.** The existing durable preset selection already identifies the conversation and restores its capabilities, so another persistence mechanism would duplicate ownership.

## Consequences

Ordinary chat needs no directory selection and retains the normal session history. It cannot browse the web, operate on local files, execute commands, or delegate work. Transferring existing chat history into a workspace is deferred. Custom Host plugins are still trusted deployment code; this preset is a tool composition boundary, not an operating-system sandbox.
