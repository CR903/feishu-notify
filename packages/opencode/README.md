# `opencode-feishu-notify`

An [opencode](https://opencode.ai) v2 plugin that turns agent events into Feishu (Lark) cards —
**by calling the `feishu-notify` sender**, never by holding a webhook itself.

**Status: implemented, not on npm yet.** The code is complete and measured against the live
plugin it replaces; what is missing is the registry round trip (see
[Not measured yet](#not-measured-yet)).

| | |
|---|---|
| Package | `opencode-feishu-notify` (workspace `packages/opencode`) |
| Plugin id | `feishu.notify` |
| Runtime | opencode v2 (measured on `2.0.32`); loaded from `opencode.json` `plugins` or `~/.config/opencode/plugins/` |
| Sends via | `feishu-notify` (the bash sender from `feishu-notify-cli`) |
| Holds a webhook | **No.** It passes a channel *name*; the CLI resolves the address from your config |
| Hard dependency | [`feishu-notify-cli`](../cli) — **install it first** |

## Dependency: the CLI must come first

The plugin is a thin event adapter. Everything that touches the network lives in the CLI:

```text
opencode event
  → opencode-feishu-notify      (this package: decide what to say, dedupe, title, metrics)
  → feishu-notify               (bash sender: build the card, POST it)
  → feishu-notify-cli resolve   (Node: read YOUR config, hand the webhook to the sender)
```

So before wiring the plugin:

```sh
npm i -g feishu-notify-cli     # puts BOTH feishu-notify and feishu-notify-cli on PATH
feishu-notify-cli init         # store your webhook, verified with a test card
feishu-notify-cli doctor       # wiring self-check + one real card per channel
```

**Where the plugin looks for the sender** (resolved on every send — no hard-coded bin directory):

| Order | Candidate | Notes |
|---|---|---|
| 1 | `$FEISHU_NOTIFY_BIN` | explicit override. If set but not executable, the send **fails loudly** — it is not silently ignored |
| 2 | `~/.local/bin/feishu-notify` | only if it is an executable file |
| 3 | `feishu-notify` on `PATH` | covers nvm / Homebrew / pnpm global prefixes |
| 4 | none of the above | **nothing is sent**; one `ERROR` line is written to the log (see [Troubleshooting](#troubleshooting)) |

If none is found, the log names every location it tried and tells you to install the CLI. This is
deliberate: the previous version hard-coded `~/.local/bin/feishu-notify`, and on a machine whose
npm prefix is elsewhere notifications simply never arrived — visible only in a debug log.

## Install

### Before the package is published

`feishu-notify-cli install --target opencode` declares this package in `opencode.json`, but it
**refuses while the name is unresolvable** (it checks with `npm view` first, so you never end up
with a config that points at nothing). Until the package is on npm, wire it by hand:

```sh
# from a clone of this repo
cd packages/opencode
node scripts/deploy.mjs            # copies src/feishu-notify.ts to ~/.config/opencode/plugins/
node scripts/deploy.mjs --check    # hash gate: live file == packaged file (writes nothing)
```

opencode auto-loads `~/.config/opencode/plugins/*.ts`, so no `opencode.json` change is needed in
this mode. The deploy script backs the previous file up as `feishu-notify.ts.pre-package.bak`
**once** and never overwrites that backup, so it stays a real rollback point.

### After publication

```sh
feishu-notify-cli install --target opencode --channel opencode --dry-run   # show the exact change
feishu-notify-cli install --target opencode --channel opencode
```

That writes:

```json
{
  "plugins": [
    { "package": "opencode-feishu-notify", "options": { "channel": "opencode" } }
  ]
}
```

Notes on the declaration:

- **`options.channel` is the routing decision.** Set it when you have a dedicated bot
  (`"opencode"`, `"team-a"`, …). Omit it and the plugin asks for `opencode` first and then
  degrades — see [Channel semantics](#channel-semantics).
- A bare string (`"opencode-feishu-notify"`) and the object form above normalize to the same
  target on opencode 2.0.32 (measured). A bare string cannot carry `options`, so it is only
  suitable for the single-bot case; `install --channel …` therefore writes the object form.
- A non-absolute target is treated as a **package name** and installed/resolved by opencode's
  package manager. A target that fails to resolve only marks the plugin as failed — it does not
  stop opencode from starting.

## What triggers a card

| Event | Card | Status |
|---|---|---|
| `permission.asked` | 🔔 需要你决定 — action, up to 8 resources, optional message | ⚠ **never observed arriving**; structurally reachable (same ephemeral class as `form.*`) |
| `form.created` | ❓ 需要你回答 — form title, up to 6 fields with their options | ✅ measured |
| `session.execution.succeeded` | ✅ 任务完成 — or ❓ 等你决定 when the final text reads like a question | ✅ measured |
| `session.execution.failed` | ❌ 任务失败 — error type/message | ✅ measured |
| `session.execution.interrupted` | ⏸ 任务已中断 — reason | ✅ measured |
| `session.text.ended` | — accumulates the assistant's final text only; no card | ✅ measured |
| `session.idle` | silent fallback for a kernel that stops dispatching `execution.*`; runtime 2.0.32 never dispatches it | ✅ measured |

**Why text questions have no event of their own.** A turn that ends with "shall I run this?" emits
only `session.execution.succeeded` plus the final text. The plugin therefore inspects the last 240
characters of that text with a deliberately narrow heuristic (trailing `?`/`？` including trailing
quotes, `是否`, `要不要`, `需要你`, `请你(确认|决定|选择|授权|批准)`, `请确认`,
`你(来)?(确认|决定|选择)`, `(可以|好|行|对)吗`, sentence-final `吗`, `(有没有|有)(问题|异议|意见)吗`,
`要我(继续|接着)?(做|执行|创建|改|删)`). Sentence-final quoting includes full-width `”`/`’`
(so `……吗”` is recognised). Mislabelling an ordinary wrap-up is worse than missing a question, so
the list stays narrow.

**Title format.** `<prefix> · <session title, truncated to 40 chars>`.

**Metrics line** (second block of the card body, measured):

```text
**🤖 deepseek-v4-flash**
输出 1.3k tok · 耗时 1m12s（生成 45s）· ≈29 tok/s（生成期）
```

Model comes from `ctx.session.get()`, output tokens are the delta of the session-cumulative
`tokens.output`, elapsed time is wall clock from `session.execution.started`, and generation time
sums `session.step.started` → `session.step.ended` (tool waiting excluded). After a plugin
hot-reload the generation window cannot be rebuilt, so TPS is labelled
`（平均，含工具等待）` instead of being presented as a measured rate.

**Cross-instance dedupe.** opencode loads a plugin once per client; one
`session.execution.succeeded` was measured arriving **5 times within 5 ms**. Cards are gated by a
file-level atomic claim (`open(…, 'wx')` under `~/.local/share/opencode/feishu-claims`), with an
in-memory check only as a cheap first pass: five instances, one card.

## Channel semantics

The plugin never sees a webhook. It passes `--channel <name>` and lets the CLI resolve it:

| Your config | What happens |
|---|---|
| has the channel (`opencode`) | one send, no retry — the bot you configured |
| only `default` (the common single-bot setup) | the first attempt exits `2` ("no such channel") → the plugin retries **without** `--channel`, i.e. your `activeChannel`, and logs the degradation as an `ERROR` line |
| nothing configured | nothing is sent; the CLI's `init` guidance goes into the log |

Two properties are load-bearing:

1. **Degradation is explicit and logged.** It is never silent, because "my notifications went to
   the other bot" is the failure users cannot debug.
2. **There is no built-in address to fall back to**, and the plugin never retries against a
   different channel name. An unresolvable webhook is an error, not a message delivered to
   somebody else's bot.

`--source opencode` is always passed, so the card footer/source identifies the caller.

## Troubleshooting

**Log file** (both levels go to the same file):

```text
~/.local/share/opencode/feishu-notify.log
```

| Level | Written when | Contains |
|---|---|---|
| `ERROR` | **always** — send failure, channel degradation, sender not found, body-file write failure, event-stream termination (no notifications after it) | `notify FAILED (…)`, `notify DEGRADED: …`, `找不到发送端 …`, `event stream error …` |
| debug | only with `FEISHU_NOTIFY_DEBUG=1` | event payloads, metrics reconciliation, resolved sender path and argv |

Start here when a card does not arrive:

```sh
grep ' ERROR ' ~/.local/share/opencode/feishu-notify.log
```

The `ERROR` lines are unconditional: they do not require you to have enabled debug logging
beforehand. `FEISHU_NOTIFY_DEBUG` is process-level — the opencode **server** is long-lived, so
changing it requires restarting the server, not just the client command.

**Log file missing entirely?** Nothing failed yet (debug lines are off), or the plugin never
loaded. Check that opencode sees it:

```sh
node scripts/deploy.mjs --check   # in packages/opencode: exit 0 = live == packaged
```

`--check` exits `2` when the live file does not exist (never deployed — not drift), `1` on drift
or a symlink (a symlink can go dangling silently, which is why the deploy copies instead).

**Nothing sent, log says `找不到发送端`.** Install the CLI globally (`npm i -g
feishu-notify-cli`) or point `FEISHU_NOTIFY_BIN` at the sender. Setting `FEISHU_NOTIFY_BIN` to a
non-executable path is an error on purpose: silently falling through would make the override look
applied while a different binary ran.

**Card arrives but from the wrong bot.** `options.channel` is unset (so the plugin asked for
`opencode`, then degraded) or names a channel that does not exist. Check with
`feishu-notify-cli channel list`, then set `options.channel` to a name that is really there.

**Two cards for one turn.** More than one plugin instance is loaded, or two wirings exist at once
(`~/.config/opencode/plugins/feishu-notify.ts` **and** a `plugins` entry in `opencode.json`).
Keep one. The file-level claim collapses duplicates from concurrent instances, not from
deliberately double-wired copies.

## Not measured yet

Stated as unverified rather than implied:

| Item | Why |
|---|---|
| `permission.asked` actually arriving | No such event has ever been observed on 2.0.32. The handler is implemented and structurally plausible; the timing is **not** verified |
| "declaring the package installs it" end to end | Needs a published package. The syntax and normalization are measured; the registry round trip is not |
| Windows | The sender is bash + `curl` + `python3`. Out of scope |

## Tests

```sh
npm test               # from packages/opencode (or the repo root: fans out to all workspaces)
```

| Suite | Covers |
|---|---|
| `tests/plugin-module.test.mjs` | module smoke (`id`, `setup`), the `looksLikeQuestion` case table, the G4 full-width-quote regression, `bun build` |
| `tests/channel-fallback.test.mjs` | `channelFromOptions`, argv construction, the narrow "channel not found" predicate, the three-state degradation decision, log levels |
| `tests/notify-bin.test.mjs` | sender resolution order (env / `~/.local/bin` / PATH / none), "no spawn when unresolved", and the unconditional `ERROR` log |
| `tests/routing.test.mjs` | real sender + stub `curl`: which bot the card is addressed to in all three config states (no card is sent) |
| `tests/live-gate.test.mjs` | the deployed file is byte-identical to the packaged file and contains no address |
| `tests/deploy.test.mjs` | the deploy script's file-system contract (backup once, atomic replace, `--check` exit codes) |

## License

MIT — see [`LICENSE`](./LICENSE).
