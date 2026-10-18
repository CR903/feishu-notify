# feishu-notify-cli

Feishu (Lark) bot notifications for local AI agents — a sender, a config layer, and **no compiled-in webhook**.

The webhook is resolved at send time from the sources below, and if none of them has it the sender exits `2` with guidance. It never falls back to a built-in address: an unresolvable webhook is an error, not a message delivered to somebody else's bot.

Two commands ship in this package:

| Command | Runtime | Role |
|---|---|---|
| `feishu-notify` | bash | The sender. POSTs a card or a plain-text message to the resolved webhook. This is what hooks and agent plugins call. |
| `feishu-notify-cli` | Node ≥ 18 | Config and diagnostics: `resolve`, `init`, `channel`, `doctor`, `footer`, `install`. |

> **Where this package lives.** `feishu-notify-cli` is the `packages/cli` workspace of the
> `feishu-notify` monorepo (repo-root README: [`../../README.md`](../../README.md)). Paths in
> this file that start with `bin/`, `lib/` or `tests/` are relative to **this package**.
> The two adapter workspaces are `packages/opencode` — implemented (plugin,
> [`README`](../opencode/README.md)) but not published yet — and `packages/dsh`, still a
> README-only placeholder.

> **Not on npm yet.** `GET https://registry.npmjs.org/feishu-notify-cli` returns 404 as of this commit — publishing happens after review in the parent task. Until then, run the CLI from a clone:
>
> ```sh
> node bin/feishu-notify-cli init      # run from packages/cli; instead of: npx feishu-notify-cli init
> ```

## What it does

| Capability | Detail |
|---|---|
| Resolves the webhook | `--webhook` → `--channel` → `FEISHU_NOTIFY_WEBHOOK` → config `activeChannel` → error |
| Sends | Interactive card (title + markdown body) or plain text; body from an argument or from a file |
| Hook modes | `--hook` / `--idle` / `--done` read the hook's JSON on stdin (`last_assistant_message`, `prompt`) and append a source + timestamp footer |
| Configures itself | `init` sends a test card first and writes the config only if that card arrived |
| Diagnoses itself | `doctor` first checks the **wiring chain** the hooks actually run through (sender → resolver → Node ≥ 18, including dangling symlinks), then sends a real test card per channel |
| Installs itself | `install` merges the hooks/plugin declarations into the agents it finds (`claude-code`, `opencode`, `dsh`), idempotently, with a `*.bak.<timestamp>` per touched file |
| Multi-channel | Named channels (`default`, `opencode`, `claude`, …) with one `activeChannel`; callers can pin a channel per target |
| Card footer is yours | The line under the card is the config field `footer` (≤40 chars, no newlines). Unset → the neutral `feishu-notify`; set to `""` → timestamp only |
| Keeps secrets out | Every printed value is masked; a secret gate in `npm test` scans source and `npm pack` output for real hook tokens |

## What it does not do

- **Does not create your Feishu bot.** You create a custom bot in Feishu and copy its webhook. This tool only stores and uses it.
- **No card interactivity.** Buttons, callbacks and approvals are out of scope; cards are one-way.
- **No aggregation, muting or scheduling.** One event in, one card out.
- **No silent fallback.** Missing config is an error (`exit 2`). That is deliberate — see [Security](#security). The price is that a broken config stops notifications instead of degrading quietly.
- **`install` does not cover everything yet.** `claude-code` is wired end to end. `opencode` is gated on the plugin package being published (the installer refuses to declare an unresolvable name), and `dsh` is gated on the adapter existing (the installer probes, prints the exact change it *would* make, and refuses to write). See [Wiring](#3-wire-up-your-agent-one-command).
- **`install` never runs a package manager.** For DSH it writes the profile manifest and prints the `dsh plugin … pnpm install` command for you to run; it does not execute pnpm/npm installs itself, so `--dry-run` staying write-free is a property the tool can actually guarantee.
- **No Windows.** The sender is bash + `curl` + `python3`. The CLI side is Node and portable, the sender is not.
- **No DSH adapter.** Not implemented in any form.

## Requirements

| Requirement | Why |
|---|---|
| **Node ≥ 18** | The CLI is Node, and the bash sender calls it to resolve the webhook. On the author's machine `/usr/local/bin/node` is **v14.17.5**, which cannot even parse the resolver — hence the explicit interpreter search below. |
| `bash`, `curl`, `python3` | Inherited from the original sender: bash runs it, `curl` posts the payload, `python3` parses the hook JSON from stdin. |
| macOS / Linux | The sender is bash. Windows is out of scope. |

**How the sender picks Node** (`bin/feishu-notify`), in order, skipping any candidate whose major version is `< 18`:

1. `$FEISHU_NOTIFY_NODE`
2. `node` on `PATH`
3. `/usr/local/bin/node`
4. `/opt/homebrew/bin/node`
5. `$HOME/.nvm/versions/node/*/bin/node`

If none qualifies, the sender still tries the CLI directly and, when that fails, prints a hint pointing at Node ≥ 18 and `FEISHU_NOTIFY_NODE`. It also finds the resolver itself, in this order: `$FEISHU_NOTIFY_CLI` → a `feishu-notify-cli` next to the script (the layout `npm i -g` produces) → `$HOME/.local/bin/feishu-notify-cli` → `PATH`.

## Quick start

### 0. Install the CLI itself (globally — this matters)

```sh
npm i -g feishu-notify-cli      # put the two commands in a real bin directory
```

**Why global rather than a clone or `npx`.** The wiring that hooks depend on is "a `feishu-notify`
on `PATH` that can find a `feishu-notify-cli` next to itself". A global install produces exactly
that: two real files side by side in one bin directory.

What must *not* happen is the live setup depending on **a development checkout path**. On
2026-10-18 this repository was renamed while `~/.local/bin/feishu-notify-cli` was a symlink into
it. The link went dangling, the sender exited `2`, and notifications stopped **silently** — the
error only existed inside the hook's process, where nobody was looking. `doctor` now detects that
exact state ([Wiring health](#wiring-health-r11)); the structural fix is to not point production
at a working copy, and the installer therefore writes the bare command name `feishu-notify` (resolved
through `PATH`) instead of any absolute path.

Running from a clone is fine for trying it out:

```sh
node packages/cli/bin/feishu-notify-cli doctor      # from the repo root
```

but do not wire hooks to that path.

### 1. Configure

```sh
npx feishu-notify-cli init
# or, from a clone:
node bin/feishu-notify-cli init
```

Interactive `init` asks for the webhook, **sends a test card to verify it**, and writes the config only after the card was accepted. Automation:

```sh
feishu-notify-cli init --non-interactive --webhook "https://open.feishu.cn/open-apis/bot/v2/hook/<PLACEHOLDER>" --channel default
feishu-notify-cli init --non-interactive --webhook-stdin < secret.txt   # keeps the URL out of argv/ps
feishu-notify-cli init --non-interactive --webhook "$URL" --no-verify   # skips the card (not recommended)
```

### 2. Check

```sh
feishu-notify-cli doctor
```

`doctor` does two things, in this order:

1. **Wiring self-check** — walks the chain a real hook runs through (sender → resolver → Node ≥ 18),
   classifying every candidate with `lstat` so a **dangling symlink** is reported as such instead of
   as "missing", and prints the fix (`rm` the broken link, `npm i -g feishu-notify-cli`).
2. **Per-channel reachability** — sends one real card per channel and prints `结论：N/M 通`; exits `1`
   if a channel is unreachable. The cards carry the **effective footer**, so what you see on the test
   card is exactly what your notifications will look like.

The wiring verdict deliberately does **not** change the exit code: hooks run in the agent's
environment (different `PATH`, different `HOME`), so a ✗ here is a strong, actionable warning rather
than a definitive failure of the channels. `doctor --json` carries `wiring` for scripts.

### 3. Wire up your agent (one command)

```sh
feishu-notify-cli install --dry-run     # print the plan; writes nothing
feishu-notify-cli install               # ask for confirmation, then write
feishu-notify-cli install --yes         # non-interactive
```

What each target does today — measured, not aspirational:

| Target | Probe | Action | State |
|---|---|---|---|
| `claude-code` | `~/.claude/settings.json` | Merges two hook groups: `Notification` (matcher `idle_prompt`) → `feishu-notify --idle`, and a matcher-less `Stop` → `feishu-notify --done`. Existing hooks are kept; dedupe is by command string, plus "same event, same tool" so you never get two cards per event | ✅ writes |
| `opencode` | `~/.config/opencode/opencode.json` | Appends `opencode-feishu-notify` to `plugins` (object form `{"package": …}` by default, or `--opencode-form bare`). With `--channel <name>` the entry carries `options: { "channel": "<name>" }`, so the plugin's routing intent is explicit instead of being covered by its default value | ⛔ **refuses** while the package is not resolvable (verified with `npm view`), so you never get a half-wired config |
| `dsh` | `~/.dsh/profiles/*/package.json` | Adds the package to `dependencies` **and** `dsh.profile.bundles` | ⛔ **refuses by default** (the adapter package does not exist yet; a bundle that cannot resolve makes DSH fail to start). It prints the exact change and the `dsh plugin … pnpm install` command; `--dsh-dev-dir <path>` switches to a `link:<abs>` dev wiring |

Guarantees, all of them asserted in `tests/install.test.mjs`:

- `--dry-run` writes nothing, and the plan it prints is the **same data** the real run executes.
- Every file it writes is backed up first as `<file>.bak.<timestamp>`; the run ends with `cp -p …` rollback lines.
- Running it twice produces **zero** file changes on the second run (byte-hash assertion, no new backups).
- A failing target does not stop the others, and is reported with its own error and rollback line.
- A file that is a symlink is never written (writing through it would hit your dotfiles repo; replacing it would break the layout) — the installer refuses and tells you what the link points at.

`--channel <name>` is only written when you pass it explicitly: appended to the Claude Code hook
commands, and stored as `options.channel` for the opencode plugin. By default neither carries a
channel and the sender uses `activeChannel`.

### 4. Wire up your agent (manual)

The installer covers the paths above; this section is what to do by hand when it refuses, and the
reference for what the installer writes. Both paths below call the **sender**, which resolves the
webhook itself.

**Claude Code** — `~/.claude/settings.json`, merging two entries into `hooks`. These are the entries installed on the author's machine, copied verbatim:

```json
{
  "hooks": {
    "Notification": [
      {
        "matcher": "idle_prompt",
        "hooks": [{ "type": "command", "command": "~/.local/bin/feishu-notify --idle", "timeout": 10000 }]
      }
    ],
    "Stop": [
      {
        "hooks": [{ "type": "command", "command": "~/.local/bin/feishu-notify --done", "timeout": 10000 }]
      }
    ]
  }
}
```

Notes: hook handlers run in shell form (`sh -c`), so `~` expands and `--idle` / `--done` get the hook JSON on stdin. Add `--channel <name>` if you want this target pinned to a specific bot (`--channel claude`); without it the `activeChannel` is used. The `timeout` numbers are copied from the working local config — current Claude Code docs describe the field in seconds, so re-check it for your version. `install` writes the **bare** command name instead of `~/.local/bin/…`, so the hook survives a `PATH`-based global install and cannot go dangling when a repository moves.

**opencode** — opencode auto-loads plugins from `~/.config/opencode/{plugin,plugins}/*.{ts,js}` (measured on this machine's runtime 2.0.32) and also from the `plugins` array in `opencode.json`. The plugin that emits these notifications is implemented in `packages/opencode` ([`opencode-feishu-notify`](../opencode/README.md)) but **not published yet**; what it does is call the sender and let the CLI resolve the channel:

```sh
feishu-notify --channel opencode --source opencode --title "…" --file /tmp/msg.txt
```

`install` declares the package for you once it exists (see [Wiring](#3-wire-up-your-agent-one-command)); until then it refuses. Do **not** copy the author's local `feishu-notify.ts`: that file still contains a personal webhook. See [Roadmap](#not-yet-implemented--roadmap).

## Configuration reference

| Item | Value |
|---|---|
| Path | `${XDG_CONFIG_HOME:-$HOME/.config}/feishu-notify/config.json` |
| Path override | `FEISHU_NOTIFY_CONFIG` (absolute, or relative to `cwd`) |
| File mode | `0600`; the directory is created `0700` |
| Write | temp file + `rename` (atomic); refuses to overwrite a symlink, a directory, or a config it cannot parse |
| Format | `version: 1` |

```json
{
  "version": 1,
  "activeChannel": "default",
  "footer": "feishu-notify",
  "channels": {
    "default": { "webhook": "https://open.feishu.cn/open-apis/bot/v2/hook/<PLACEHOLDER>", "label": "默认" },
    "opencode": { "webhook": "https://open.feishu.cn/open-apis/bot/v2/hook/<PLACEHOLDER>", "label": "opencode" },
    "claude": { "webhook": "https://open.feishu.cn/open-apis/bot/v2/hook/<PLACEHOLDER>", "label": "Claude Code" }
  }
}
```

Channel names must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. `channel remove` refuses to delete the last channel or the active one without `--force`.

### `footer` (card footer)

`footer` is an optional top-level string — the text that appears under every card, next to
the timestamp. It exists because the original private script hardcoded a company name
there, and a company/personal identity has no business being baked into a published tool.

| Value | Result under the card |
|---|---|
| *(absent)* | `feishu-notify · <timestamp>` — the neutral default |
| `"Your Team"` | `Your Team · <timestamp>` |
| `""` | `<timestamp>` only |

Constraints: a string of at most **40** characters with **no newlines**; `init --footer <text>`
refuses anything else (and refuses it *before* sending the verification card). A hand-edited
config that violates the constraint degrades gracefully: the sender falls back to the neutral
default rather than failing to notify. Read it with `feishu-notify-cli footer` — the footer is
**not** a secret, so it is printed in clear (unlike webhooks).

### Resolution precedence

| Order | Source | Notes |
|---|---|---|
| 1 | `--webhook <url>` | highest; does not read any file |
| 2 | `--channel <name>` | looks up `channels[name]`; unknown name → `exit 2` listing the names that exist |
| 3 | `FEISHU_NOTIFY_WEBHOOK` | env; wins over the config file |
| 4 | config `activeChannel` | the normal path |
| 5 | none of the above | `exit 2`, stderr carries `请运行：npx feishu-notify-cli init` |

Every source is validated the same way: `https` only, and for `*.feishu.cn` / `*.larksuite.com` hosts the path must be `/open-apis/bot/v2/hook/<token>` with a token of ≥ 8 chars that is not a placeholder. `--webhook` is validated too, so a typo fails fast instead of sending nowhere.

### Failure behaviour

| Situation | Result |
|---|---|
| No config file | `exit 2` + "run init" guidance |
| Config is not valid JSON | `exit 2`, names the path, **never auto-overwrites** |
| `channels` missing / empty / wrong shape | `exit 2` with the specific shape error |
| `activeChannel` missing | `exit 2` + how to set it |
| Channel not found | `exit 2` + the list of available channels |
| Non-https or wrong-shaped URL | `exit 2` + why |
| `footer` hand-edited into an invalid value (too long / newline) | **Not fatal** — footer is decorative: `feishu-notify-cli footer` exits `2` with the reason, and the sender falls back to the neutral default. Unlike a bad webhook, it never stops a notification |

**"Never falls back to a built-in address" is a safety property, not a bug.** A fallback would mean that a user who mistypes a channel sends their notification — with their source paths and message text — to a stranger's bot. The chosen trade-off is a loud error. The *footer* is the deliberate exception: it carries no secret and no routing, so its failure mode is "neutral text", not "no notification".

## Command reference

### `feishu-notify-cli`

| Command | Purpose |
|---|---|
| `resolve [--channel <n>] [--webhook <u>] [--config <p>] [--json]` | Print the resolved URL on stdout; `source=… channel=… webhook=<masked>` goes to stderr, so the sender can capture stdout safely |
| `init [--non-interactive] (--webhook <u> \| --webhook-stdin) [--channel <n>] [--label <t>] [--footer <t>] [--config <p>] [--no-verify] [--force]` | Write the config; verifies with a test card first and writes **nothing** if the card fails |
| `channel list [--json]` / `add <n> …` / `remove <n> [--force]` / `set-active <n>` | Manage channels |
| `footer [--config <p>] [--json]` | Print the effective card footer on stdout (`source=…` on stderr). Exit `2` if the config is unusable — the sender falls back to the neutral default |
| `doctor [--channel <n>] [--json]` | Wiring self-check (sender → resolver → Node, dangling symlinks included) + per-channel reachability test |
| `install [--dry-run] [--yes] [--target <t>…\|--skip <t>…] [--channel <n>] [--opencode-form <f>] [--dsh-dev-dir <p>] [--no-verify]` | Probe the agents on this machine and wire them in idempotently; `--dry-run` prints the plan and writes nothing |
| `help`, `version` | — |

Exit codes: `0` success · `1` usage error or runtime failure (card not delivered, channel exists, …) · `2` configuration problem. `--webhook-stdin` exists so a URL read from a file never appears in `ps` output; it is mutually exclusive with `--webhook`.

`install` exits `1` when a target failed, when everything it could do was refused, or when a target you named explicitly with `--target` was skipped or refused.

### Wiring health (R11)

The chain a hook actually runs through has three links, and **any of them can fail silently** because
the error lands in the agent's hook process, not in your terminal:

```
hook → feishu-notify (sender) → feishu-notify-cli (resolver) → Node ≥ 18
```

`doctor` walks it in that order, resolving candidates exactly the way `bin/feishu-notify` does
(`$FEISHU_NOTIFY_CLI` → next to the sender → `$HOME/.local/bin` → `PATH`, then the Node search order),
and classifies each candidate with `lstat`, so a **dangling symlink** is reported as a dangling
symlink rather than as a missing file — the two need different fixes:

```text
  ▸ 接线自检（真实 hook 走的那条链：发送端 → 解析器 → Node ≥ 18）…
    ✓ 发送端        ~/.local/bin/feishu-notify
    ✗ 解析器        <找不到>
        ✗ ~/.local/bin/feishu-notify-cli：悬空符号链接 → ~/project/renamed-away-repo/bin/feishu-notify-cli（目标不存在）
    ✓ Node ≥ 18    ~/.nvm/versions/node/v22.23.2/bin/node（v22.23.2）
    修复：
      - ~/.local/bin/feishu-notify-cli 是悬空符号链接（→ …）：rm … 然后 `npm i -g feishu-notify-cli`
      - 发送端找不到解析器 feishu-notify-cli：装一次即可 — `npm i -g feishu-notify-cli`
```

A broken candidate that a later one covers up is still printed: it works today, and stops working the
day `PATH` changes. `doctor --json` exposes the same data as `wiring`, the check cannot change the
exit code, and the test suite pins that behaviour (`tests/wiring.test.mjs`).

### `feishu-notify` (sender)

| Flag | Effect |
|---|---|
| `"text"` (positional) | Message body |
| `--title <t>` | Card title (default: `<source>通知`) |
| `--file <path>` | Body read from a file (missing file → `exit 1`) |
| `--text` | Send a plain-text message instead of a card |
| `--hook` / `--idle` / `--done` | Hook modes; read JSON from stdin. `--done` with no message content exits `0` **silently**, before any config lookup |
| `--source <s>` | Override the detected source (`终端` / `VS Code 插件端` / `桌面端`) |
| `--webhook <url>` / `--channel <n>` | Forwarded to the resolver (see precedence) |

Exit codes: `0` sent · `1` no message / missing file / non-200 from Feishu · `2` webhook unresolvable or invalid.

Card payload (from the byte-exact golden fixtures):

```json
{
  "msg_type": "interactive",
  "card": {
    "header": { "title": { "tag": "plain_text", "content": "终端通知" }, "template": "blue" },
    "elements": [
      { "tag": "markdown", "content": "…\n—\n**来源**: 终端\n🕐 <TIMESTAMP>" },
      { "tag": "hr" },
      { "tag": "note", "elements": [{ "tag": "plain_text", "content": "feishu-notify · <TIMESTAMP>" }] }
    ]
  }
}
```

The `note` content is the [`footer`](#footer-card-footer) config value (here the neutral
default) followed by the timestamp. Only that one string changes when you set a footer —
the golden fixtures prove it: for all four card cases the payloads differ **only** in the
note content, and after normalising the note they are byte-identical (that assertion lives
in `tests/footer.test.mjs`). The webhook is **not** part of the payload (it is only curl's target).

## Agent compatibility

| Agent | Integration point | Measured status |
|---|---|---|
| Terminal / any script | direct call | ✅ Sender measured: 5 byte-exact golden fixtures, exit-code matrix, resolution precedence |
| Claude Code | `~/.claude/settings.json` hooks (`Notification`/`idle_prompt` → `--idle`, `Stop` → `--done`) | ✅ Hook entries installed and their shape verified. ⚠ The hook process's own `PATH` has **not** been directly observed — the sender's resolver/interpreter discovery was instead exercised under a sanitized `PATH` in `tests/sender-compat.test.mjs` (including a fake v14 `node`, to prove it is skipped) |
| opencode (v2, runtime 2.0.32) | plugin in `~/.config/opencode/plugins/` | ✅ Plugin side measured end-to-end: notification timings, title rule, metrics line, cross-instance dedupe (details below). ✖ The packaged adapter `opencode-feishu-notify` is not published, so there is no install path for third parties yet |
| DSH (DeepSeek Harness) | profile bundle | ✖ Not implemented |

Legend: ✅ measured · ⚠ assumed / not directly observed · ✖ not implemented.

## Notification semantics (opencode side)

These come from the opencode adapter as it exists today (`~/.config/opencode/plugins/feishu-notify.ts`), not from this CLI. They are recorded here because they define what a user actually receives — the CLI itself only renders the title and body it is given.

| Event | Card | Status |
|---|---|---|
| `permission.asked` | 🔔 需要你决定 (+ action, up to 8 resources, message) | ⚠ **Never observed arriving** — structurally it should be reachable (same ephemeral class as `form.*`), but no such card has been seen |
| `form.created` | ❓ 需要你回答 (+ form title, up to 6 fields with options) | ✅ measured |
| `session.execution.succeeded` | ✅ 任务完成, or ❓ 等你决定 when the final text reads like a question | ✅ measured |
| `session.execution.failed` | ❌ 任务失败 (+ error type/message) | ✅ measured |
| `session.execution.interrupted` | ⏸ 任务已中断 (+ reason) | ✅ measured |
| `session.text.ended` | — accumulates the assistant's final text only | ✅ measured |
| `session.idle` | silent fallback for a kernel that stops dispatching `execution.*`; runtime 2.0.32 never dispatches it | ✅ measured |

**Title.** `<prefix> · <session title, truncated to 40 chars>`. The prefix is `✅ 任务完成` unless the last 240 chars of the final text match one of 11 strong "is it asking me?" patterns (trailing `?`/`？`, `是否`, `要不要`, `需要你`, `请你(确认|决定|选择|授权|批准)`, `请确认`, `你(来)?(确认|决定|选择)`, `(可以|好|行|对)吗`, sentence-final `吗`, `(有没有|有)(问题|异议|意见)吗`, `要我(继续|接着)?(做|执行|创建|改|删)`) — then the title becomes `❓ 等你决定`. The list is deliberately narrow: mislabelling an ordinary wrap-up is worse than missing a question.

Text questions do not produce their own event, which is why the heuristic exists at all: a turn that ends in "may I run this?" emits only `execution.succeeded` plus the final text.

**Metrics line** (second block of the card body), measured in one turn:

```
**🤖 deepseek-v4-flash**
输出 1.3k tok · 耗时 1m12s（生成 45s）· ≈29 tok/s（生成期）
```

| Field | Source |
|---|---|
| Model | `ctx.session.get({ sessionID }).model` — id, plus `variant` when set |
| Output tokens | delta of the session-cumulative `tokens.output` across the turn (the value is monotonic; measured 10095 → 10233 → 10692) |
| Elapsed | wall clock from `session.execution.started` |
| Generation time | sum of `session.step.started` → `session.step.ended` windows, so tool waiting is excluded; shown only when it differs from the elapsed time by > 1s |
| TPS | output tokens ÷ generation time. If the turn baseline was restored after a plugin hot-reload, generation time cannot be rebuilt and the line says `（平均，含工具等待）` instead |

The token figure was reconciled three ways — cumulative delta, per-step accumulation, and summing the individual messages — and all three agreed exactly (1270 tokens in the reconciliation run).

**Cross-instance dedupe.** opencode loads the plugin once per client; one `session.execution.succeeded` was measured being delivered **5 times within 5 ms** (08:22:59.614 → .619) to 5 plugin instances. Cards are therefore gated by a file-level atomic claim (`open(…, 'wx')` under `~/.local/share/opencode/feishu-claims`), with an in-memory check only as a cheap first pass — **5 instances, one card**.

| Constant | Value |
|---|---|
| `DONE_DEDUPE_MS` (succeeded / failed / interrupted / idle share one key) | 8000 |
| `PERMISSION_DEDUPE_MS` (permission / form) | 10000 |
| `TITLE_TTL_MS` / `TURN_TTL_MS` | 5 min / 6 h |
| `MSG_MAX_LEN` / `TITLE_MAX` | 2000 / 40 |

## Security

- **No address ships in the code.** `grep` the whole repository for the hook marker and you will find only shape checks and placeholders; the sender's `WEBHOOK_URL` default was deleted, not inlined.
- **https only.** An `http://` webhook is rejected — it would put the secret on the wire in clear text.
- **Masked everywhere.** `resolve`, `channel list --json`, `doctor` and error messages print `https://<host>/…/<REDACTED>`; the plaintext exists only in the `0600` config file and in curl's argument.
- **Secret gate in `npm test`** (`lib/secret-scan.mjs`, `tests/secret-scan.test.mjs`). It fails the suite when a real-looking hook token shows up in
  1. the **whole repository index** — it walks up to the git root, so files outside this package (the monorepo root, the adapter workspaces) are in scope too, plus untracked, non-ignored files, and
  2. everything `npm pack --dry-run --json` would publish from this package,

  where "real-looking" means a `<marker><token>` whose token is not a whitelisted placeholder or sample (`xxx`, `PLACEHOLDER`, `REDACTED`, `your-webhook`, `<…>`, `test-*`, `example-*`, `fake-*`, `dummy-*`, `sample-*`). On top of that, it cross-checks the author's four live files (`~/.local/bin/feishu-notify`, `~/.config/feishu-notify/config.json`, `~/.config/opencode/plugins/feishu-notify.ts`, `~/.claude/settings.json`), extracting their tokens **into memory only** — never printed, never written — and fails if any of them appears in the repository. Because a verifier that cannot fail verifies nothing, the suite also includes a deliberate-injection test: a real-shaped token is planted and the gate must catch it (fails against the pre-fix code by construction).

  Verify it yourself:

  ```sh
  npm run secret-scan                  # human-readable report, non-zero exit on a hit (from packages/cli or the repo root)
  node lib/secret-scan.mjs --json
  node lib/secret-scan.mjs --no-pack   # skip the npm pack half
  node lib/secret-scan.mjs --root <dir>
  ```

## Development

```sh
npm test                 # from packages/cli; the repo root forwards the same suite
npm run fixtures         # re-capture golden payloads and diff against the committed ones
npm run fixtures:update  # overwrite tests/fixtures/* with a fresh capture
```

| Suite | Covers |
|---|---|
| `tests/config-resolution.test.mjs` | Precedence matrix, error branches, `0600`/`0700`/atomic writes, masking, isolation guards |
| `tests/sender-compat.test.mjs` | bash-side precedence and exit-code matrix, resolver discovery order, Node-interpreter choice, payload independence from the webhook source |
| `tests/fixtures.test.mjs` | The golden fixtures are reproducible byte-for-byte, and their note carries the neutral default footer |
| `tests/footer.test.mjs` | `footer` validation/resolution/CLI, `init --footer`, `channel`/`doctor` display, the **self-check card carrying the effective footer**, and the surgical "only the note changes" property |
| `tests/install.test.mjs` | All three install targets end to end in a simulated `HOME`: detection, merging, dedupe, refusals, both opencode forms, `--dry-run` zero-write, byte-hash idempotence, single-target failure isolation, rollback lines, exit codes |
| `tests/init.test.mjs` | `init`, `channel`, `doctor`, `lib/sender.mjs`, isolation guards |
| `tests/wiring.test.mjs` | `classify()` (including **dangling symlinks**), the four `checkWiring()` scenarios, and `doctor`'s wiring output/exit-code contract |
| `tests/timeout.test.mjs` | `FEISHU_NOTIFY_TIMEOUT_MS` defaults/clamping, and the send-timeout branch end to end (a stub curl that sleeps 300ms vs a 50ms timeout) — the one wall-clock dependency, pinned deterministically |
| `tests/secret-scan.test.mjs` | Token detection, whole-repo scan, injection self-test, live-fingerprint cross-check |
| `tests/live.test.mjs` | Real network round trip — skipped unless `FEISHU_NOTIFY_LIVE=1` |

`tests/fixtures/` holds the payloads captured from the **pre-config** sender (stub `curl`, five inputs: `--idle`, `--done`, `--title X --file`, `--text`, bare text). The config refactor had to reproduce them byte-for-byte with the timestamp normalized, which is why they are still in the repo: they are the definition of "the sender did not change". The **only** intended change since is the card footer (R9): the note moved from the author's hardcoded `Smarterlab ·` to the neutral default, and the harness pins `footer` to that neutral value so the capture cannot drift with the developer's own machine. Re-capture with `npm run fixtures:update` only when you intend to change that behaviour.

Environment overrides: `FEISHU_NOTIFY_LIVE=1` (enable the live suite), `FEISHU_NOTIFY_CURL` (path to curl), `FEISHU_NOTIFY_CONFIG` (config path), `FEISHU_NOTIFY_CLI` / `FEISHU_NOTIFY_NODE` (resolver and interpreter for the sender), `FEISHU_NOTIFY_NPM` (npm binary used by `install`'s "is this package resolvable" pre-check; tests point it at a stub), `FEISHU_NOTIFY_TIMEOUT_MS` (timeout for the curl child that sends a test card: default `15000`, clamped to `10`–`600000`, an unparsable value falls back to the default).

`FEISHU_NOTIFY_TIMEOUT_MS` exists mainly so tests can stop depending on the clock (a test that sends a card and then asserts the exit code is otherwise asserting "this machine finishes a curl in 15s"). The default, and every sending behaviour, is unchanged.

### Rollback

The CLI keeps no state beyond the config file.

```sh
rm ~/.config/feishu-notify/config.json      # back to "exit 2 + run init"; notifications stop, loudly
cp -p ~/.local/bin/feishu-notify.pre-config.bak ~/.local/bin/feishu-notify   # restore the pre-config sender
shasum -a 256 ~/.local/bin/feishu-notify    # expect 0b788cf3…c52f1ebde (that copy contains the old hardcoded address)
```

`bin/feishu-notify.orig` in this repo is the **redacted** baseline: use it to diff, never to restore.

`install` prints its own rollback lines for everything it touched — one `cp -p <file>.bak.<timestamp> <file>` per file. Each target only ever appends to the files it names, so restoring the backup also removes anything a later run added.

## Not yet implemented / Roadmap

| Item | State |
|---|---|
| `feishu-notify-cli install` → `claude-code` | ✅ writes (merges two hook groups, dedupe by command, keeps your hooks) |
| `feishu-notify-cli install` → `opencode` | ⛔ refuses while `opencode-feishu-notify` is unresolvable (checked with `npm view` before writing); `--no-verify` overrides |
| `feishu-notify-cli install` → `dsh` | ⛔ refuses by default (the adapter package does not exist yet); `--dsh-dev-dir` enables the `link:<abs>` dev wiring |
| `install` running the package manager for you | Not done on purpose (see "What it does not do"); the exact `dsh plugin … pnpm install` command is printed instead |
| `opencode-feishu-notify` ([`packages/opencode`](../opencode)) | ✅ **implemented**, not published. Plugin behaviour, channel degradation and sender resolution are measured; the registry round trip waits for publication |
| opencode plugin **declaration syntax** | ✅ **measured** on the 2.0.32 binary: `plugins` is `Array<string \| {package, options}>`, both forms normalize to the same target, a bare `"-name"` string means *remove*, and a non-absolute target is installed/resolved by opencode's package manager (a failure only marks the plugin failed — it does not stop opencode). What is **not** measured is the registry round trip, which needs the package published |
| `dsh-feishu-notify` (`packages/dsh`, placeholder only) | Not implemented |
| Windows | Out of scope: the sender is bash. A port needs the golden-fixture treatment the Node CLI got |
| Publishing to npm (all three packages) | Not done — deliberately deferred to the parent task |
| `permission.asked` notification tier | Still never observed arriving |

## License

MIT.
