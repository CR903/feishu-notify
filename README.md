# feishu-notify (monorepo)

Feishu (Lark) bot notifications for local AI agents — one config layer, one sender, one
adapter per agent. **No webhook is ever compiled in**: the address is resolved at send
time from the user's own config, and if it cannot be resolved the sender exits `2` with
guidance instead of delivering to somebody else's bot.

This repository is a **single repo with three packages** (`npm` workspaces): the CLI is built,
the opencode adapter is built and awaiting publication, and DSH is still a placeholder.

## Packages

| Package | Path | Status | What it is |
|---|---|---|---|
| `feishu-notify-cli` | [`packages/cli`](./packages/cli) | ✅ **implemented** (not on npm yet) | The core: the `feishu-notify` bash sender + the `feishu-notify-cli` Node config/diagnostics/`install` CLI. Ships both binaries. |
| `opencode-feishu-notify` | [`packages/opencode`](./packages/opencode) | ✅ **implemented** (not on npm yet) | opencode v2 plugin: cards on turn end / permission / form, routed with `--channel opencode`. Holds **no** webhook — it calls the sender, which resolves the address from your config. |
| `dsh-feishu-notify` (intended) | [`packages/dsh`](./packages/dsh) | ✖ **not built** — README-only placeholder | DSH profile/bundle that calls the sender with `--channel dsh`. |

> `packages/dsh` contains **no `package.json` on purpose** — a README-only directory cannot be
> published by accident. It is filled in by the sub-task `10-18-feishu-notify-dsh`.
> `packages/opencode` is a real workspace now; its plugin does not ship until the parent task
> publishes it.

Legend: ✅ implemented and measured · ⚠ assumed / not directly observed · ✖ not implemented.

## Layout

```
.
├── package.json                 # private root: workspaces ["packages/*"], test fan-out
├── LICENSE                      # MIT (every package carries the same copy)
├── README.md / README.zh-CN.md  # this file — repo overview
└── packages/
    ├── cli/                     # the implemented core package
    │   ├── package.json         #   name: feishu-notify-cli, bin ×2, files whitelist
    │   ├── bin/feishu-notify    #   the sender (bash)
    │   ├── bin/feishu-notify-cli#   config/init/channel/doctor/resolve/footer/install (Node)
    │   ├── lib/                 #   config resolution, commands, sender, wiring self-check, install targets, secret gate
    │   ├── tests/               #   assertions + byte-exact golden fixtures
    │   └── README.md            #   the full documentation for the package
    ├── opencode/                # the implemented adapter (not published yet)
    │   ├── package.json         #   name: opencode-feishu-notify, main → src/feishu-notify.ts
    │   ├── src/feishu-notify.ts #   the plugin (no webhook: passes --channel, the CLI resolves it)
    │   ├── scripts/deploy.mjs   #   copy the plugin to the live dir; --check is a drift gate
    │   ├── tests/               #   module / channel / sender-resolution / routing / live-hash suites
    │   └── README.md            #   install, events, channel semantics, troubleshooting
    └── dsh/README.md            #   placeholder (no package.json)
```

## Start here

The complete documentation — install, config format, command reference, agent
compatibility, security model, rollback — lives in the package READMEs:

- [`packages/cli/README.md`](./packages/cli/README.md) (English) · [`README.zh-CN.md`](./packages/cli/README.zh-CN.md) (中文)
- [`packages/opencode/README.md`](./packages/opencode/README.md) (English) · [`README.zh-CN.md`](./packages/opencode/README.zh-CN.md) (中文)

Quick version (install the CLI **globally** — two real binaries in one bin directory; do not point
your wiring at a development checkout, which is how the 2026-10-18 rename made notifications fail
silently):

```sh
npm i -g feishu-notify-cli            # puts both commands on PATH
feishu-notify-cli init                # asks for your webhook, verifies with a test card
feishu-notify-cli doctor              # wiring self-check (sender/resolver/Node, dangling symlinks) + per-channel reachability
feishu-notify-cli install --dry-run   # show what would be merged into your agent configs; writes nothing
feishu-notify-cli install             # wire it up: claude-code writes; opencode is declared once its package is published; dsh is gated
```

Add `--channel <name>` when you want a target pinned to a specific bot: for Claude Code it is
appended to the hook command, for opencode it is written into `options.channel`. Without it, each
caller uses your config's `activeChannel`.

From a clone (this is also the state until the package is published):

```sh
node packages/cli/bin/feishu-notify-cli init
# or, from inside the package:
cd packages/cli && node bin/feishu-notify-cli init
```

## Develop

```sh
npm test                      # from the repo root: fans out to every workspace
cd packages/cli && npm test   # the CLI suite
cd packages/opencode && npm test   # the plugin suite (includes the live drift gate)
npm run secret-scan           # the publish gate (whole-repo git index + the CLI tarball)
```

`npm test` from the root runs the workspace `test` scripts (`packages/cli` and
`packages/opencode`). The plugin suite's live-hash gate **skips** on a machine where the plugin was
never deployed (`deploy --check` exit `2`); it fails only on real drift. The secret gate
deliberately scans the **whole repository index** (not just the current directory) so that neither
the root files nor the other packages can drift out of its view.

## License

MIT — see [`LICENSE`](./LICENSE).
