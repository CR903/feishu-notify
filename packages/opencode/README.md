# `packages/opencode` — opencode adapter (placeholder)

**Status: not built yet.** This directory deliberately contains **only this README** —
there is no `package.json`, so nothing here can be published or installed by accident.

The adapter lands with the sub-task `.trellis/tasks/10-18-feishu-notify-adapters-oc-cc`.
Until then, wiring opencode is manual: see
[`../cli/README.md`](../cli/README.md#3-wire-up-your-agent-manual) and
[Agent compatibility](../cli/README.md#agent-compatibility).

## What will live here

| Item | Note |
|---|---|
| Package name | `opencode-feishu-notify` (intended) |
| Runtime role | opencode plugin that calls the `feishu-notify` sender |
| Channel | must pass `--channel opencode` so it never depends on the user's `activeChannel` |
| Never does | ship a webhook, or reuse the author's local `~/.config/opencode/plugins/feishu-notify.ts` (that file holds a personal address) |

## Why a placeholder README and not an empty package

An empty `package.json` would be a valid workspace and is one `npm publish` away from
shipping a package with no code. A README-only directory documents the slot while
staying unpublished by construction.
