# `packages/dsh` — DSH adapter (placeholder)

**Status: not built yet.** This directory deliberately contains **only this README** —
there is no `package.json`, so nothing here can be published or installed by accident.

The adapter lands with the sub-task `.trellis/tasks/10-18-feishu-notify-dsh`. The
compatibility table in [`../cli/README.md`](../cli/README.md#agent-compatibility)
marks DSH as *not implemented* until then.

## What will live here

| Item | Note |
|---|---|
| Package name | `dsh-feishu-notify` (intended) |
| Runtime role | DSH profile/bundle that calls the `feishu-notify` sender |
| Channel | must pass its own `--channel dsh` so it never depends on the user's `activeChannel` |
| Never does | ship a webhook |

## Why a placeholder README and not an empty package

An empty `package.json` would be a valid workspace and is one `npm publish` away from
shipping a package with no code. A README-only directory documents the slot while
staying unpublished by construction.
