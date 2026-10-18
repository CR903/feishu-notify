# `dsh-feishu-notify` — DSH (Cordis) adapter

Feishu (Lark) cards from **DSH** when a turn ends or the harness needs your decision.
Sending goes through the shared `feishu-notify` CLI, which resolves the webhook from **your own
config** — this package ships **no address** and never talks HTTP itself.

> **Status: implemented, not yet published, and not yet verified inside a live DSH profile.**
> Steps 0–2 of `.trellis/tasks/10-18-feishu-notify-dsh` are done (package skeleton, pure mapping
> + tests, CLI wiring + tests). The real-profile end-to-end run (AC2), the capability table (AC5)
> and the bilingual README (R6) belong to that task's Step 3–4 and are still open.
> Everything below is measured against DSH **0.2.0-rc.2** on this machine.

## What it does

One subscription — `session/event` (the post-commit fire-and-forget feed) — mapped to cards:

| Session event | Card | Notes |
|---|---|---|
| `turn/end`, `reason.kind === 'completed'` | ✅ 任务完成 | turn wall-clock, model, folded per-turn tokens, session-cumulative output |
| `turn/end`, `kind === 'error'` | ❌ 任务失败 | `LlmFailure` message / code / HTTP status |
| `turn/end`, `kind === 'aborted'` | ⏸ 任务已中断 | cancellation cause (`user` / `parent` / `hook` / `disposed`) |
| `turn/end`, `kind === 'blocked'` | 🚫 任务被拦下 | |
| `turn/end`, `kind === 'max-tokens'` | ⚠️ 已达 token 上限 | |
| `turn/end`, any other `kind` | ❓ 未知状态 | never throws; the raw `kind` is printed verbatim |
| `approval/asked` | 🔔 需要你决定 | tool name + asker's reason |
| `tool/result` with `isError` | ❌ 工具失败 | **off by default** (`toolFailures: true` to enable) |

Metrics are **omitted, never invented**: no model → no model line, no token usage → no token line.
There is deliberately **no tok/s** — DSH only gives turn wall-clock time (tool waits included), and
dividing by that would be a meaningless number.

## Not implemented (and why)

- **“Waiting for your answer” / plan review.** The task design assumed
  `session/event → user-question-reply`, but `user-question-reply` is **not** a `SessionEventMap`
  member — it is a `MessageSourceMap` member (`@deepseek-ai/dsh-user-questions/lib/types/types.d.ts:104`),
  i.e. `user/message.source.kind`, so registering that event name would never fire. DSH's only real
  “answer needed” hook is the **blocking** waterfall `user-questions/request`. No non-blocking hook
  exists → not implemented rather than faked.
- **`agent/turn-stopping` as “turn finished”.** It fires *before* the turn closes and another listener
  may `agent.steer()` it back to life — using it would send false “done” cards.
- **Answering from the card.** The approval/question waterfalls belong to the DSH client UI. Cards
  are one-way (same as the opencode adapter).
- **`sessionStats` / TPS / generation-only time.** That projection is mounted by the `dsh-web-app`
  bundle only, so non-web profiles don't have it.

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
- **Version drift.** Built against DSH 0.2.0-rc.2. No `@deepseek-ai/dsh-*` peer is declared on
  purpose (rc versions in peer ranges are a minefield); every service is duck-typed.

## Development

```bash
npm test -w packages/dsh
```

No DSH runtime is needed: pure mapping functions and a fake-`ctx` harness cover the event mapping,
plus a real `spawn` against a stub executable that proves the argv contract.
