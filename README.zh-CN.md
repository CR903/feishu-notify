# feishu-notify-cli

给本机 AI agent 用的飞书（Lark）机器人通知 —— 一个发送端 + 一层配置解析，**不内置任何地址**。

webhook 在**发送前**按下表解析；一处都取不到就 `exit 2` 并给出引导语。它绝不回落到内置地址：解析不出来是一次报错，而不是把消息发到别人的机器人上。

本包提供两个命令：

| 命令 | 运行时 | 职责 |
|---|---|---|
| `feishu-notify` | bash | 发送端。把卡片或纯文本 POST 到解析出的 webhook。hooks 与 agent 插件调用的就是它。 |
| `feishu-notify-cli` | Node ≥ 18 | 配置与诊断：`resolve` / `init` / `channel` / `doctor`。 |

> **尚未发布到 npm。** 本次提交时 `GET https://registry.npmjs.org/feishu-notify-cli` 返回 404 —— 发布由父任务复审后统一进行。在此之前请从仓库里跑：
>
> ```sh
> node bin/feishu-notify-cli init      # 而不是 npx feishu-notify-cli init
> ```

## 它做什么

| 能力 | 说明 |
|---|---|
| 解析 webhook | `--webhook` → `--channel` → `FEISHU_NOTIFY_WEBHOOK` → 配置 `activeChannel` → 报错 |
| 发送 | 互动卡片（标题 + markdown 正文）或纯文本；正文可来自参数或文件 |
| Hook 模式 | `--hook` / `--idle` / `--done` 读 stdin 上的 hook JSON（`last_assistant_message`、`prompt`），并追加来源与时间戳页脚 |
| 自我配置 | `init` 先发一张测试卡片，**卡片送达了才落盘** |
| 自我诊断 | `doctor` 逐 channel 真实发卡，报告哪条通、哪条不通 |
| 多 channel | 具名 channel（`default` / `opencode` / `claude`…）配一个 `activeChannel`；调用方也可以按目标指定 channel |
| 不泄露密钥 | 所有输出都是掩码；`npm test` 里的密钥闸门会扫描源码与 `npm pack` 产物中的真实 hook token |

## 它不做什么

- **不创建你的飞书机器人。** 机器人在飞书侧自行创建，本工具只负责保存与使用它的 webhook。
- **不做卡片交互。** 按钮、回调、审批不在范围内；卡片是单向的。
- **不做聚合、静音、定时。** 一个事件进，一张卡片出。
- **不静默降级。** 缺配置就是报错（`exit 2`），这是刻意的 —— 见[安全](#安全)。代价是配置坏了会停通知，而不是悄悄发歪。
- **还没有一键 `install`。** `feishu-notify-cli install` 只是个命令名，执行后 `exit 1` 报"未实现"。当前接线靠手工（[手动接线](#3-手动接线)）。
- **不支持 Windows。** 发送端是 bash + `curl` + `python3`；CLI 侧是 Node、可移植，发送端不是。
- **没有 DSH 适配器。** 任何形式都还没有。

## 环境要求

| 要求 | 为什么 |
|---|---|
| **Node ≥ 18** | CLI 是 Node 写的，而 bash 发送端要调它解析 webhook。作者本机 `/usr/local/bin/node` 是 **v14.17.5**，连解析器都读不了 —— 所以才有下面这套解释器搜索。 |
| `bash`、`curl`、`python3` | 都继承自原发送端：bash 跑脚本、`curl` 发 payload、`python3` 解析 stdin 上的 hook JSON。 |
| macOS / Linux | 发送端是 bash。Windows 不在本轮范围。 |

**发送端怎么挑 Node**（`bin/feishu-notify`），按下序，主版本 `< 18` 的候选一律跳过：

1. `$FEISHU_NOTIFY_NODE`
2. `PATH` 上的 `node`
3. `/usr/local/bin/node`
4. `/opt/homebrew/bin/node`
5. `$HOME/.nvm/versions/node/*/bin/node`

一个都不合格时，发送端仍会直接执行 CLI；失败了才打印指向 Node ≥ 18 与 `FEISHU_NOTIFY_NODE` 的提示。解析器的发现顺序同理：`$FEISHU_NOTIFY_CLI` → 脚本同目录下的 `feishu-notify-cli`（也就是 `npm i -g` 之后的布局）→ `$HOME/.local/bin/feishu-notify-cli` → `PATH`。

## 快速开始

### 1. 配置

```sh
npx feishu-notify-cli init
# 或者从仓库里跑：
node bin/feishu-notify-cli init
```

交互式 `init` 会问 webhook，**先发一张测试卡片验证**，卡片被接受了才写配置。自动化用法：

```sh
feishu-notify-cli init --non-interactive --webhook "https://open.feishu.cn/open-apis/bot/v2/hook/<PLACEHOLDER>" --channel default
feishu-notify-cli init --non-interactive --webhook-stdin < secret.txt   # 地址不进 argv/ps
feishu-notify-cli init --non-interactive --webhook "$URL" --no-verify   # 跳过发卡（不推荐）
```

### 2. 自检

```sh
feishu-notify-cli doctor
```

`doctor` 读配置 → 逐 channel 真发一张卡 → 打印 `结论：N/M 通`；只要有一条不通就 `exit 1`。`doctor --json` 输出同样内容的 JSON。

### 3. 手动接线

安装器还没实现，所以现在靠手工。下面两条路径调的都是**发送端**，webhook 由它自己解析。

**Claude Code** —— `~/.claude/settings.json`，把两条 hooks 合并进去。下面是作者本机上已装的那两条，逐字抄来：

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

说明：hook handler 走 shell 形式（`sh -c`），所以 `~` 会被展开、`--idle` / `--done` 能拿到 stdin 上的 hook JSON。想把这条目标固定到某个机器人就加 `--channel <name>`（例如 `--channel claude`）；不加则用 `activeChannel`。`timeout` 的数值是从本机可用配置里原样抄来的 —— Claude Code 现行文档把这个字段描述为**秒**，请按你的版本再核对一次。

**opencode** —— opencode 会自动加载 `~/.config/opencode/plugins/*.{ts,js}`（本机 runtime 2.0.32 实测）。发通知的那个插件属于独立包 `opencode-feishu-notify`，**尚未发布**；适配器要做的事就是调用发送端、让 CLI 去解析 channel：

```sh
feishu-notify --channel opencode --source opencode --title "…" --file /tmp/msg.txt
```

在那个包发布之前，第三方没有 opencode 的安装路径。**不要**拷贝作者本机的 `feishu-notify.ts`：那个文件里还带着个人 webhook。见[未实现 / Roadmap](#未实现--roadmap)。

## 配置参考

| 项 | 值 |
|---|---|
| 路径 | `${XDG_CONFIG_HOME:-$HOME/.config}/feishu-notify/config.json` |
| 路径覆盖 | `FEISHU_NOTIFY_CONFIG`（绝对路径，或相对于 `cwd`） |
| 文件权限 | `0600`；目录按 `0700` 创建 |
| 写入方式 | 临时文件 + `rename`（原子）；拒绝覆盖符号链接、目录，以及自己解析不了的配置 |
| 格式 | `version: 1` |

```json
{
  "version": 1,
  "activeChannel": "default",
  "channels": {
    "default": { "webhook": "https://open.feishu.cn/open-apis/bot/v2/hook/<PLACEHOLDER>", "label": "默认" },
    "opencode": { "webhook": "https://open.feishu.cn/open-apis/bot/v2/hook/<PLACEHOLDER>", "label": "opencode" },
    "claude": { "webhook": "https://open.feishu.cn/open-apis/bot/v2/hook/<PLACEHOLDER>", "label": "Claude Code" }
  }
}
```

channel 名必须匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`。`channel remove` 不加 `--force` 时拒绝删除最后一个 channel，也拒绝删除当前 active 的那条。

### 解析优先级

| 顺序 | 来源 | 说明 |
|---|---|---|
| 1 | `--webhook <url>` | 最高；不读任何文件 |
| 2 | `--channel <name>` | 查 `channels[name]`；名字不存在 → `exit 2` 并列出有哪些 |
| 3 | `FEISHU_NOTIFY_WEBHOOK` | 环境变量；优先于配置文件 |
| 4 | 配置里的 `activeChannel` | 常规路径 |
| 5 | 以上全无 | `exit 2`，stderr 含 `请运行：npx feishu-notify-cli init` |

所有来源走同一套校验：只允许 `https`；`*.feishu.cn` / `*.larksuite.com` 域还要求路径形状为 `/open-apis/bot/v2/hook/<token>`，token 至少 8 字符且不能是占位符。`--webhook` 同样被校验，所以打错字会当场失败，而不是"发到某处"。

### 失败行为

| 情形 | 结果 |
|---|---|
| 配置文件不存在 | `exit 2` + "去跑 init" 的引导语 |
| 配置不是合法 JSON | `exit 2`，指出路径，**绝不自动覆盖** |
| `channels` 缺失 / 为空 / 结构不对 | `exit 2` 并给出具体的结构错误 |
| 缺 `activeChannel` | `exit 2` + 怎么设置它 |
| channel 不存在 | `exit 2` + 可用的 channel 列表 |
| 非 https 或形状不对 | `exit 2` + 原因 |

**"绝不回落内置地址"是一条安全属性，不是缺陷。** 一旦回落，用户打错 channel 名就会把自己的通知 —— 连同源路径和消息正文 —— 发到陌生人的机器人上。这里选择的代价是"响亮地报错"。

## 命令参考

### `feishu-notify-cli`

| 命令 | 用途 |
|---|---|
| `resolve [--channel <n>] [--webhook <u>] [--config <p>] [--json]` | 把解析结果打印到 stdout；`source=… channel=… webhook=<掩码>` 走 stderr，因此发送端可以安全地捕获 stdout |
| `init [--non-interactive] (--webhook <u> \| --webhook-stdin) [--channel <n>] [--label <t>] [--config <p>] [--no-verify] [--force]` | 写配置；先发卡验证，卡片失败就**什么都不写** |
| `channel list [--json]` / `add <n> …` / `remove <n> [--force]` / `set-active <n>` | 管理 channel |
| `doctor [--channel <n>] [--json]` | 逐 channel 实测可达性 |
| `help`、`version` | — |
| `install` | **未实现** → `exit 1` |

退出码：`0` 成功 · `1` 用法错误或运行期失败（卡片没发出去、channel 已存在…）· `2` 配置问题。`--webhook-stdin` 的存在是为了让从文件读来的地址不出现在 `ps` 输出里；它与 `--webhook` 互斥。

### `feishu-notify`（发送端）

| 参数 | 作用 |
|---|---|
| `"文本"`（位置参数） | 消息正文 |
| `--title <t>` | 卡片标题（默认 `<来源>通知`） |
| `--file <path>` | 正文从文件读（文件不存在 → `exit 1`） |
| `--text` | 发纯文本而不是卡片 |
| `--hook` / `--idle` / `--done` | hook 模式，从 stdin 读 JSON。`--done` 在没有消息内容时**静默** `exit 0`，且发生在解析配置之前 |
| `--source <s>` | 覆盖自动检测的来源（`终端` / `VS Code 插件端` / `桌面端`） |
| `--webhook <url>` / `--channel <n>` | 转交给解析器（见优先级） |

退出码：`0` 已发送 · `1` 无消息 / 文件缺失 / 飞书返回非 200 · `2` webhook 解析不出来或地址非法。

卡片 payload（取自逐字节黄金样例）：

```json
{
  "msg_type": "interactive",
  "card": {
    "header": { "title": { "tag": "plain_text", "content": "终端通知" }, "template": "blue" },
    "elements": [
      { "tag": "markdown", "content": "…\n—\n**来源**: 终端\n🕐 <TIMESTAMP>" },
      { "tag": "hr" },
      { "tag": "note", "elements": [{ "tag": "plain_text", "content": "Smarterlab · <TIMESTAMP>" }] }
    ]
  }
}
```

`Smarterlab ·` 那一行是原私有脚本里硬编码的遗留字面量；webhook **不**在 payload 里（它只是 curl 的目标参数）。

## 各 agent 兼容性

| agent | 接入点 | 实测状态 |
|---|---|---|
| 终端 / 任意脚本 | 直接调用 | ✅ 发送端已实测：5 组逐字节黄金样例、退出码矩阵、解析优先级 |
| Claude Code | `~/.claude/settings.json` 的 hooks（`Notification`/`idle_prompt` → `--idle`，`Stop` → `--done`） | ✅ hooks 条目已装上、配置形状已核对。⚠ **hook 进程自身的 `PATH` 未直接观测** —— 发送端的解析器/解释器发现顺序是靠在测试里清洗 `PATH`（含一个假的 v14 `node`，用于证明它会被跳过）来等价验证的，见 `tests/sender-compat.test.mjs` |
| opencode（v2，runtime 2.0.32） | `~/.config/opencode/plugins/` 下的插件 | ✅ 插件侧端到端实测：通知时机、标题判定、指标行、跨实例去重（细节见下）。✖ 打包产物 `opencode-feishu-notify` 尚未发布，第三方暂无安装路径 |
| DSH（DeepSeek Harness） | profile bundle | ✖ 未实现 |

图例：✅ 已实测 · ⚠ 推断 / 未直接观测 · ✖ 未实现。

## 通知语义（opencode 侧）

这些来自 opencode 适配器**今天的样子**（`~/.config/opencode/plugins/feishu-notify.ts`），不是本 CLI 的行为。写在这里是因为它们决定了用户最终收到什么 —— CLI 只负责渲染别人给它的标题与正文。

| 事件 | 卡片 | 状态 |
|---|---|---|
| `permission.asked` | 🔔 需要你决定（+ 动作、最多 8 项资源、说明） | ⚠ **从未观测到它到达** —— 结构上应当可达（与 `form.*` 同类 ephemeral 事件），但至今没收到过这张卡 |
| `form.created` | ❓ 需要你回答（+ 表单标题、最多 6 个字段及选项） | ✅ 已实测 |
| `session.execution.succeeded` | ✅ 任务完成；正文读起来像提问时改为 ❓ 等你决定 | ✅ 已实测 |
| `session.execution.failed` | ❌ 任务失败（+ 错误类型/信息） | ✅ 已实测 |
| `session.execution.interrupted` | ⏸ 任务已中断（+ 原因） | ✅ 已实测 |
| `session.text.ended` | — 只累积 AI 最终文本 | ✅ 已实测 |
| `session.idle` | 静默兜底：万一某版本不再派发 `execution.*` 才接手；runtime 2.0.32 从不派发 | ✅ 已实测 |

**标题。**`<前缀> · <会话标题，截断到 40 字符>`。前缀默认 `✅ 任务完成`；当最终文本最后 240 字符命中 11 条强信号提问模式（末尾 `?`/`？`、`是否`、`要不要`、`需要你`、`请你(确认|决定|选择|授权|批准)`、`请确认`、`你(来)?(确认|决定|选择)`、`(可以|好|行|对)吗`、句末 `吗`、`(有没有|有)(问题|异议|意见)吗`、`要我(继续|接着)?(做|执行|创建|改|删)`）时，前缀改为 `❓ 等你决定`。这份清单刻意收窄：把正常的收尾总结误标成"等你决定"，比漏判更让人困惑。

之所以需要这条启发式：**文字提问不产生任何事件**。一轮以"是否可以执行 X？"结尾的回合，只会派发 `execution.succeeded` 加最终文本。

**指标行**（卡片正文里第二块），某一轮实测：

```
**🤖 deepseek-v4-flash**
输出 1.3k tok · 耗时 1m12s（生成 45s）· ≈29 tok/s（生成期）
```

| 字段 | 口径来源 |
|---|---|
| 模型 | `ctx.session.get({ sessionID }).model` —— id，带 `variant` 时一并显示 |
| 输出 tokens | 会话累计 `tokens.output` 在本轮内的**差值**（该值单调递增；实测 10095 → 10233 → 10692） |
| 耗时 | 从 `session.execution.started` 起的墙钟时间 |
| 生成耗时 | 各 `session.step.started` → `session.step.ended` 窗口累加，因此排除了工具等待；只在它比总耗时小 1s 以上时才显示 |
| TPS | 输出 tokens ÷ 生成耗时。若回合基线是插件热重载后接回来的，生成耗时可重建不了，该行会改标 `（平均，含工具等待）` |

token 数字做过**三方对账** —— 累计差值 / 每步累加 / 逐条消息求和 —— 三者精确一致（那次对账是 1270 tokens）。

**跨实例去重。**opencode 会给每个客户端加载一次插件；实测同一条 `session.execution.succeeded` 在 **5 毫秒内被投递了 5 次**（08:22:59.614 → .619），对应 5 个插件实例。因此发卡前要走**文件级原子抢占**（`~/.local/share/opencode/feishu-claims` 下 `open(…, 'wx')`），内存判断只当廉价的短路 —— **5 个实例，只出一条**。

| 常量 | 值 |
|---|---|
| `DONE_DEDUPE_MS`（succeeded / failed / interrupted / idle 共用一把键） | 8000 |
| `PERMISSION_DEDUPE_MS`（permission / form） | 10000 |
| `TITLE_TTL_MS` / `TURN_TTL_MS` | 5 分钟 / 6 小时 |
| `MSG_MAX_LEN` / `TITLE_MAX` | 2000 / 40 |

## 安全

- **代码里不带地址。** 在整个仓库里搜 hook 标记，只能搜到形状校验和占位符；发送端 `WEBHOOK_URL` 的默认值是被**删除**的，不是内联的。
- **只允许 https。** `http://` 会被拒绝 —— 那等于把密钥明文放到链路上。
- **处处掩码。** `resolve`、`channel list --json`、`doctor` 以及错误信息打印的都是 `https://<host>/…/<REDACTED>`；明文只存在于 `0600` 的配置文件和 curl 的参数里。
- **`npm test` 里的密钥闸门**（`lib/secret-scan.mjs`、`tests/secret-scan.test.mjs`）。以下两处出现"像真 token"的 hook 地址就让测试失败：
  1. `git ls-files` 的全部条目，加上未被忽略的新文件；
  2. `npm pack --dry-run --json` 会发布的全部内容。

  判定标准是"`<标记><token>` 且 token 不在占位符/样例白名单内"（白名单：`xxx`、`PLACEHOLDER`、`REDACTED`、`your-webhook`、`<…>`、`test-*`、`example-*`、`fake-*`、`dummy-*`、`sample-*`）。此外还会与作者本机四个 live 文件（`~/.local/bin/feishu-notify`、`~/.config/feishu-notify/config.json`、`~/.config/opencode/plugins/feishu-notify.ts`、`~/.claude/settings.json`）做**指纹交叉比对**：提取出的 token **只留在内存**，不打印、不落盘，一旦出现在仓库里即失败。又因为"永远不会失败的校验器等于没校验"，套件里还有一条**故意注入**的自证测试：塞进一个真实形状的 token，闸门必须拦住它。

  自己复核：

  ```sh
  npm run secret-scan                  # 可读报告，命中则非零退出
  node lib/secret-scan.mjs --json
  node lib/secret-scan.mjs --no-pack   # 跳过 npm pack 那一半
  node lib/secret-scan.mjs --root <dir>
  ```

## 开发

```sh
npm test                 # 104 tests / 24 suites：102 pass，2 skipped，0 fail
npm run fixtures         # 重新捕获黄金样例并与已提交的逐字节比对
npm run fixtures:update  # 用新捕获覆盖 tests/fixtures/*
```

| 套件 | 覆盖 |
|---|---|
| `tests/config-resolution.test.mjs` | 优先级矩阵、各失败分支、`0600`/`0700`/原子写、掩码、隔离守卫 |
| `tests/sender-compat.test.mjs` | bash 侧的优先级与退出码矩阵、解析器发现顺序、Node 解释器选择、payload 与 webhook 来源无关 |
| `tests/fixtures.test.mjs` | 黄金样例可逐字节重现 |
| `tests/init.test.mjs` | `init`、`channel`、`doctor`、`lib/sender.mjs`、隔离守卫 |
| `tests/secret-scan.test.mjs` | token 识别、真实仓库扫描、注入自证、live 指纹交叉 |
| `tests/live.test.mjs` | 真实网络往返 —— 未设 `FEISHU_NOTIFY_LIVE=1` 时跳过 |

`tests/fixtures/` 存的是**改造前**发送端的 payload 基线（stub `curl`，五组输入：`--idle`、`--done`、`--title X --file`、`--text`、裸文本）。改配置解析时它们必须逐字节一致（时间戳归一化后），这也是它们留在仓库里的原因：它们是"发送端没变"的定义。只有确实要改这个行为时才用 `npm run fixtures:update` 重新捕获。

环境变量：`FEISHU_NOTIFY_LIVE=1`（开启 live 套件）、`FEISHU_NOTIFY_CURL`（curl 路径）、`FEISHU_NOTIFY_CONFIG`（配置路径）、`FEISHU_NOTIFY_CLI` / `FEISHU_NOTIFY_NODE`（发送端用的解析器与解释器）。

### 回滚

CLI 除了配置文件之外不留状态。

```sh
rm ~/.config/feishu-notify/config.json      # 回到"exit 2 + 去跑 init"；通知会停，但停得响亮
cp -p ~/.local/bin/feishu-notify.pre-config.bak ~/.local/bin/feishu-notify   # 恢复改造前的发送端
shasum -a 256 ~/.local/bin/feishu-notify    # 期望 0b788cf3…c52f1ebde（那份里还是旧的内置地址）
```

仓库里的 `bin/feishu-notify.orig` 是**脱敏**基线：只能用来 diff，不能用来回滚。安装器就位后各 agent 的配置会各自留 `*.bak.<时间戳>`；在那之前，请自己备份你要改的文件。

## 未实现 / Roadmap

| 项 | 状态 |
|---|---|
| `feishu-notify-cli install`（opencode / Claude Code / DSH 三目标，幂等、`--dry-run`、写前备份） | 命令存在，执行即 `exit 1` 报"未实现" |
| `opencode-feishu-notify` | 包未发布；适配器的 channel 接线与安装路径都随它一起落地 |
| opencode "配置里声明包名即自动安装" | **未验证**。`config.d.ts` 把 `plugins` 类型写成 `Array<string \| { package, options }>`，但裸字符串究竟按 npm 包名还是本地路径解析尚不可知 —— 只有包进了 registry 才能实测 |
| `dsh-feishu-notify`（Cordis bundle） | 未实现 |
| Windows | 不在范围：发送端是 bash。移植需要照 Node CLI 的做法补一套黄金样例 |
| 发布到 npm（三个包） | 未做 —— 刻意留给父任务 |
| `permission.asked` 这条通知时机 | 至今仍未观测到它到达 |

## 许可证

MIT。
