---
description: "Desktop settings for installing and configuring the Codex DSH coordination skill."
kind: "package-reference"
---

# @one-person-lab/dsh-client-ui-settings-codex

English | [中文](README.zh.md)

## Summary

Adds **Codex collaboration** to desktop Settings: inspect the local installation, install or update the bundled Skill, and choose whether dispatch starts DSH. The desktop writes into the local Codex home, even when the Host runs elsewhere.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

The default web-app bundle includes this plugin. No plugin configuration is needed. Open Settings → Codex collaboration, inspect the destination, then install. Start a new Codex task to load the Skill; restart Codex if needed.

<a id="understand-the-implementation"></a>
## Understand the implementation

The client uses the product-only `dshDesktop.codex` bridge. Electron owns the filesystem transaction, resource paths, and ownership manifest. Modified or unmanaged Skill directories are left intact. Configuration overrides are retained. The host half is empty; no remote service or model credential is exposed.

## Model Experience

None, as this desktop settings page installs an external Codex coordination Skill without contributing DSH model context or changing the worker agent loop and permissions.

#### KV Cache effect

None; this page neither assembles nor sends a model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Desktop only; the page is absent in a plain browser.
- The helper requires native Node.js and a real Codex task ID.
- Installing does not enable the wake bridge.
- A moved application can require updating the Skill configuration again.

**Runtime invariant:** No runtime invariant companion is published because this package owns a settings projection, not a new domain contract. Installer transactions are tested by the desktop package; client tests exercise the actual Loader composition and page actions.

<a id="dev-note"></a>
### Dev Note

None.
