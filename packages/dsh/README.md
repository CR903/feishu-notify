# `dsh-feishu-notify` — DSH (Cordis) adapter

Feishu (Lark) cards from **DSH** when a turn ends, when the harness needs your decision, or when it
needs an **answer** from you (including plan review).
Sending goes through the shared `feishu-notify` CLI, which resolves the webhook from **your own
config** — this package ships **no address** and never talks HTTP itself.

> **Status: implemented, not yet published.** Everything below is measured against DSH
> **0.2.0-rc.2** on this machine. `packages/dsh` was linked into a throwaway profile (**since
> deleted**) and the turn-end path (card arrival, `--channel dsh` resolution, uninstall) was verified
> end-to-end; the
> `user-questions/request` waterfall is implemented against the shipped `.d.ts` and covered by stub
> tests, but **has not been observed firing inside a live DSH** (see “Verified vs not” at the end).

## What it does

Two subscriptions — `session/event` (the post-commit fire-and-forget feed) and the blocking
`user-questions/request` waterfall — mapped to cards:

| Hook | Card | Notes |
|---|---|---|
| `session/event` → `turn/end`, `reason.kind === 'completed'` | ✅ 任务完成 | turn wall-clock, model, folded per-turn tokens, session-cumulative output |
| `session/event` → `turn/end`, `kind === 'error'` | ❌ 任务失败 | `LlmFailure` message / code / HTTP status |
| `session/event` → `turn/end`, `kind === 'aborted'` | ⏸ 任务已中断 | cancellation cause (`user` / `parent` / `hook` / `disposed`) |
| `session/event` → `turn/end`, `kind === 'blocked'` | 🚫 任务被拦下 | |
| `session/event` → `turn/end`, `kind === 'max-tokens'` | ⚠️ 已达 token 上限 | |
| `session/event` → `turn/end`, any other `kind` | ❓ 未知状态 | never throws; the raw `kind` is printed verbatim |
| `session/event` → `approval/asked` | 🔔 需要你决定 | tool name + asker's reason |
| `session/event` → `tool/result` with `isError` | ❌ 工具失败 | **off by default** (`toolFailures: true` to enable) |
| `user-questions/request` | ❓ 需要你回答 | the question list (`header` / `question` / options) |
| `user-questions/request` with `intent.kind === 'plan-review'` | ❓ 需要你回答 · 计划待批 | the same card, marked, plus the `approve` label |

Metrics are **omitted, never invented**: no model → no model line, no token usage → no token line.
There is deliberately **no tok/s** — DSH only gives turn wall-clock time (tool waits included), and
dividing by that would be a meaningless number.

## `user-questions/request` is a **blocking** waterfall (read this before changing it)

DSH's only real “the harness needs an answer from you” hook is the Cordis **waterfall**
`user-questions/request` (`@deepseek-ai/dsh-user-questions/lib/types/types.d.ts:145`):

```ts
'user-questions/request'(this: Scoped<Agent>, request: AskUserQuestionRequestEvent,
                         next: () => Promise<AskUserQuestionAnswer>): Promise<AskUserQuestionAnswer>
```

Two rules keep this adapter transparent:

1. **Fire-and-forget.** The handler starts the `spawn` and returns; it never `await`s the send.
   Awaiting an external process inside a blocking hook is how one plugin turns its own network
   round-trip into someone else's latency.
2. **Always delegate.** `next()` must be called and its promise returned — in a Cordis waterfall a
   listener that does not call `next()` **vetoes the rest of the chain**
   (`@deepseek-ai/cordis/lib/index.js:317-331`), so the real answering UI would never see the
   question and `ask()` would resolve with a bogus answer.

Net effect: the handler is transparent (the promise you get back is exactly `next()`'s), and the
only thing we add before delegating is a `spawn`. See `tests/user-questions.test.mjs` for the
falsifiable version of this — a hanging sender promise must not stop `next()` from being called
synchronously.

## Not implemented (and why)

- **Answering from the card.** The approval/question waterfalls belong to the DSH client UI. Cards
  are one-way (same as the opencode adapter) — we notify, we never answer.
- **`agent/turn-stopping` as “turn finished”.** It fires *before* the turn closes and another listener
  may `agent.steer()` it back to life — using it would send false “done” cards.
- **`sessionStats` / TPS / generation-only time.** That projection is mounted by the `dsh-web-app`
  bundle only, so non-web profiles don't have it.
- **`session/event → user-question-reply`.** The original task design assumed this; it is wrong.
  `user-question-reply` is a `MessageSourceMap` member
  (`@deepseek-ai/dsh-user-questions/lib/types/types.d.ts:104`), i.e. `user/message.source.kind`, not a
  session event — registering that name would never fire. The real hook is the waterfall above.

## Config

Only two keys; the webhook and channel definitions still live in the CLI's own config
(`~/.config/feishu-notify/config.json`):

```yaml
# profile cordis.patch.yml — a patch config replaces the whole config
- id: feishu-notify
  name: dsh-feishu-notify
  config:
    channel: dsh          # the --channel name, not an address
    toolFailures: false
```

Every card class is on by default (turn end, approvals, user questions / plan review); only
`toolFailures` is opt-in because a single turn can produce dozens of failing tool calls.

## Which bot do the cards go to? (the `dsh` channel)

`channel: dsh` is a **name**, never an address — the CLI resolves it from *your* config. Today
`dsh` and `default` point at **the same bot** on the machine this was built on (verified: their
webhook fingerprints match, `opencode`'s does not — see the snippet below). That is a deliberate
current choice, not a defect: one bot, per-adapter channel names, so the wiring is already in place.

To give DSH its own bot later, only the CLI config changes — nothing in this plugin:

```bash
# 1. create the bot in the Feishu group, copy its webhook, then feed it on stdin so it never
#    lands in argv / shell history (the plugin still ships no address):
printf '%s' 'https://open.feishu.cn/open-apis/bot/v2/hook/…' \
  | feishu-notify-cli channel add dsh --webhook-stdin --force

# 2. verify reachability + see the effective wiring (also prints each channel's masked address):
feishu-notify-cli doctor --channel dsh
```

`--force` is required because the channel already exists. After the swap the plugin needs no
restart of its config — it only ever passes `--channel dsh`.

> **Checking whether two channels share a bot.** `doctor` (and `channel list`) print a **masked**
> address: the unique part of a Feishu webhook is the *token* (`…/bot/v2/hook/<token>`), and that is
> redacted — so two channels on one bot look exactly like two channels on different bots, and no
> same-address call-out exists today. If you want to compare without printing the address, fingerprint
> it locally (Node is already a dependency of this project; output is 8 hex chars + the channel name):
>
> ```bash
> node -e '
> const fs = require("fs"), crypto = require("crypto");
> const file = process.env.HOME + "/.config/feishu-notify/config.json";
> const c = JSON.parse(fs.readFileSync(file, "utf8"));
> for (const [name, entry] of Object.entries(c.channels ?? {})) {
>   console.log(crypto.createHash("sha256").update(String(entry.webhook)).digest("hex").slice(0, 8), name);
> }
> '
> ```
>
> Equal fingerprints ⇒ same bot. Adding that call-out inside `doctor` would be a change in
> `packages/cli`, which is outside this adapter's scope.

## Install (once published)

```bash
dsh plugin --profile <name> pnpm add dsh-feishu-notify
```

The package declares `dsh.bundle.patch`, so the plugin manager appends it to `dsh.profile.bundles`
automatically. For local development, point the dependency at this directory instead
(`link:` / `--dsh-dev-dir` via `feishu-notify-cli install --target dsh`).

## Uninstall

`dsh plugin --profile <name> remove dsh-feishu-notify` also drops it from `dsh.profile.bundles`.
If you added an `- id: feishu-notify` override to the profile's own `cordis.patch.yml`, delete that
line too — a patch matching no row only produces a startup warning, but it is still litter.

## Troubleshooting

Failures are logged at **ERROR level unconditionally** (no debug flag gates them):

- **No card at all.** Check the DSH log for `dsh-feishu-notify: 找不到发送端 feishu-notify`.
  The sender is resolved on every send: `FEISHU_NOTIFY_BIN` → `~/.local/bin/feishu-notify` → `PATH`
  → give up. If `FEISHU_NOTIFY_BIN` is set but not executable, it is **not** silently ignored —
  that error means exactly what it says.
- **Cards go to the wrong bot.** The `--channel` name must exist in the CLI config; note this
  adapter, unlike the opencode one, does **not** retry without `--channel`.
- **No “需要你回答” card.** That hook is a **scope-filtered** waterfall: listeners tagged with an
  agent scope only see that agent's questions, while an untagged listener (this plugin registers on
  the root context) is admitted globally (`@deepseek-ai/dsh-scope/lib/index.js:329-337`). If you
  re-register it from an agent-scoped context you narrow it deliberately. Note we are a *listener*,
  not an answerer — if no UI claims a request DSH still reports `NO_PROVIDER`, exactly as it would
  without us.
- **Version drift.** Built against DSH 0.2.0-rc.2. No `@deepseek-ai/dsh-*` peer is declared on
  purpose (rc versions in peer ranges are a minefield); every service is duck-typed.

## Development

```bash
npm test -w packages/dsh
```

No DSH runtime is needed: pure mapping functions and a fake-`ctx` harness cover the event mapping,
plus a real `spawn` against a stub executable that proves the argv contract.

## Verified vs not

| Area | State |
|---|---|
| `turn/end` → card, real profile, `--channel dsh` resolution, uninstall | ✅ observed end-to-end in a throwaway profile |
| `user-questions/request` mapping + fire-and-forget / `next()` contract | ⚠ stub tests only — **never observed firing in a live DSH** (no real `ask_user_question` was driven through a live profile) |
| Root-context listener admitted by the scoped waterfall | ⚠ read from `dsh-scope` source (untagged ⇒ global), not observed at runtime |
| `approval/asked`, `tool/result`, the other four `turn/end` reason kinds | ⚠ stub tests only |
| Install from the npm registry (`dsh plugin … add dsh-feishu-notify`) | ⚠ package is not published yet |
| DSH versions other than 0.2.0-rc.2 | ⚠ not tested |
