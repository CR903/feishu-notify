# `opencode-feishu-notify`

把 opencode agent 事件变成飞书（Lark）卡片的 v2 插件 —— **通过调用 `feishu-notify` 发送端**，
插件自己**不持有任何 webhook**。

**状态：已实现，尚未发布到 npm。** 代码完整，且与它所替代的本机 live 插件逐项对平；缺的只是
注册表那一环（见[仍未实测](#仍未实测)）。

| | |
|---|---|
| 包名 | `opencode-feishu-notify`（workspace `packages/opencode`） |
| 插件 id | `feishu.notify` |
| 运行时 | opencode v2（在 `2.0.32` 上实测）；从 `opencode.json` 的 `plugins` 或 `~/.config/opencode/plugins/` 加载 |
| 通过谁发送 | `feishu-notify`（`feishu-notify-cli` 里的 bash 发送端） |
| 是否持有地址 | **否**。只传 channel *名字*，地址由 CLI 从**你自己的配置**解析 |
| 硬依赖 | [`feishu-notify-cli`](../cli) —— **必须先装它** |

## 依赖关系：先装 CLI

插件只是一层事件适配器。所有碰网络的事都在 CLI 里：

```text
opencode 事件
  → opencode-feishu-notify      （本包：决定说什么、去重、标题、指标）
  → feishu-notify               （bash 发送端：拼卡片、POST）
  → feishu-notify-cli resolve   （Node：读**你的**配置，把地址交给发送端）
```

所以接线之前先做：

```sh
npm i -g feishu-notify-cli     # 把 feishu-notify 与 feishu-notify-cli 两个 bin 都放进 PATH
feishu-notify-cli init         # 存 webhook，先发一张测试卡片验证
feishu-notify-cli doctor       # 接线自检 + 逐 channel 真发一张
```

**插件怎么找发送端**（每次发送时解析，**不写死 bin 目录**）：

| 顺序 | 候选 | 说明 |
|---|---|---|
| 1 | `$FEISHU_NOTIFY_BIN` | 显式指定。设了但不可执行 → **直接失败并记 ERROR**，不会悄悄忽略 |
| 2 | `~/.local/bin/feishu-notify` | 必须是**可执行文件**才算 |
| 3 | `PATH` 里的 `feishu-notify` | 覆盖 nvm / Homebrew / pnpm 各自的全局 prefix |
| 4 | 都没有 | **不发送**，往日志写一条 `ERROR`（见[排障](#排障)） |

一个都没找到时，日志会列出找过的每个位置，并指向"去装 CLI"。这是刻意的：旧版把
`~/.local/bin/feishu-notify` 写死，npm prefix 不在那里的机器上通知**根本发不出去**，
而且只在 debug 日志里可见。

## 安装

### 包发布之前

`feishu-notify-cli install --target opencode` 会把本包声明进 `opencode.json`，但在包名**还解析
不出来**时它会**拒绝写入**（先跑 `npm view` 确认，免得给你留一份指向空气的配置）。发布前请手动接线：

```sh
# 在本仓库的克隆里
cd packages/opencode
node scripts/deploy.mjs            # 把 src/feishu-notify.ts 复制到 ~/.config/opencode/plugins/
node scripts/deploy.mjs --check    # 哈希闸门：live == 包内（只读，不写）
```

opencode 会自动加载 `~/.config/opencode/plugins/*.ts`，这种模式下不需要改 `opencode.json`。
部署脚本只把上一版备份成 `feishu-notify.ts.pre-package.bak` **一次**，之后绝不覆盖它 ——
它得一直是一个真实可用的回滚点。

### 发布之后

```sh
feishu-notify-cli install --target opencode --channel opencode --dry-run   # 先看确切改动
feishu-notify-cli install --target opencode --channel opencode
```

写入的内容：

```json
{
  "plugins": [
    { "package": "opencode-feishu-notify", "options": { "channel": "opencode" } }
  ]
}
```

关于这条声明：

- **`options.channel` 就是路由决定。** 你有专用机器人（`"opencode"`、`"team-a"`……）就写上；
  不写则插件先要 `opencode`，再走降级 —— 见 [channel 语义](#channel-语义)。
- 裸字符串（`"opencode-feishu-notify"`）与上面的对象形式在 opencode 2.0.32 上归一化成**同一个
  target**（已实测）。裸字符串放不下 `options`，只适合单机器人场景；所以
  `install --channel …` 写的是对象形式。
- 非绝对路径的 target 会被当作**包名**，由 opencode 的包管理器安装/解析。解析失败只会把该插件
  标成 failed，**不会**让 opencode 起不来。

## 什么时候发卡片

| 事件 | 卡片 | 状态 |
|---|---|---|
| `permission.asked` | 🔔 需要你决定 —— 动作、最多 8 项资源、可选说明 | ⚠ **从未观测到到达**；结构上可达（与 `form.*` 同属 ephemeral） |
| `form.created` | ❓ 需要你回答 —— 表单标题、最多 6 个字段及其选项 | ✅ 已实测 |
| `session.execution.succeeded` | ✅ 任务完成 —— 收尾文本像在提问时改为 ❓ 等你决定 | ✅ 已实测 |
| `session.execution.failed` | ❌ 任务失败 —— 错误类型/信息 | ✅ 已实测 |
| `session.execution.interrupted` | ⏸ 任务已中断 —— 原因 | ✅ 已实测 |
| `session.text.ended` | —— 只累积 AI 的最终文本，不发卡 | ✅ 已实测 |
| `session.idle` | 内核不再派发 `execution.*` 时的静默兜底；2.0.32 从不派发 | ✅ 已实测 |

**为什么"文字提问"没有独立事件。** 一轮以"要我执行吗？"收尾的对话，只会产生
`session.execution.succeeded` 加上最终文本。插件因此只看这段文本的**最后 240 字符**，用一份
刻意收窄的启发式（末尾 `?`/`？` 且允许尾随引号、`是否`、`要不要`、`需要你`、
`请你(确认|决定|选择|授权|批准)`、`请确认`、`你(来)?(确认|决定|选择)`、`(可以|好|行|对)吗`、
句末 `吗`、`(有没有|有)(问题|异议|意见)吗`、`要我(继续|接着)?(做|执行|创建|改|删)`）。
句末引号包含全角 `”`/`’`（所以 `……吗”` 也认）。把普通收尾总结误标成"等你决定"比漏判更糟，
所以这张表一直很窄。

**标题格式。** `<前缀> · <会话标题，截断到 40 字符>`。

**指标行**（卡片正文第二段，已实测）：

```text
**🤖 deepseek-v4-flash**
输出 1.3k tok · 耗时 1m12s（生成 45s）· ≈29 tok/s（生成期）
```

模型来自 `ctx.session.get()`；输出 tokens 是会话累计 `tokens.output` 在本轮内的差值；耗时是从
`session.execution.started` 起的墙钟；生成耗时累加 `session.step.started` → `session.step.ended`
（排除工具等待）。插件热重载后，生成窗口无法重建，此时 TPS 会明确标成
`（平均，含工具等待）`，而不是冒充实测速率。

**跨实例去重。** opencode 每个 client 各加载一次插件；实测同一条
`session.execution.succeeded` 在 **5 毫秒内到达 5 次**。因此卡片由文件级原子抢占把关
（`~/.local/share/opencode/feishu-claims` 下的 `open(…, 'wx')`），内存判断只当廉价的一级短路：
五个实例，一张卡片。

## channel 语义

插件从不接触地址。它传 `--channel <名字>`，由 CLI 解析：

| 你的配置 | 会发生什么 |
|---|---|
| 有这个 channel（`opencode`） | 一次发送、不重试 —— 就是你配的那个机器人 |
| 只有 `default`（最常见的单机器人） | 第一次 exit `2`（"没有这个 channel"）→ 插件**去掉** `--channel` 重试，即你的 `activeChannel`，并把这次降级写成一条 `ERROR` |
| 什么都没配 | 不发送；CLI 的 `init` 引导语进日志 |

两条性质是关键：

1. **降级是显式且被记录的。** 绝不静默 —— "通知跑到另一个机器人去了"是用户最难排查的故障。
2. **没有内置地址可以回退**，插件也不会换一个 channel 名重试。地址解析不出来就是错误，
   而不是"投给别人的机器人"。

永远会带 `--source opencode`，卡片来源/页脚能看出调用方是谁。

## 排障

**日志文件**（两级共用一个文件）：

```text
~/.local/share/opencode/feishu-notify.log
```

| 级别 | 何时写 | 内容 |
|---|---|---|
| `ERROR` | **无条件** —— 发送失败、channel 降级、找不到发送端、正文文件写入失败、事件流中断（此后不再有通知） | `notify FAILED (…)`、`notify DEGRADED: …`、`找不到发送端 …`、`event stream error …` |
| debug | 只有 `FEISHU_NOTIFY_DEBUG=1` | 事件载荷、指标对账、解析出的发送端路径与 argv |

卡片没到时，先看这里：

```sh
grep ' ERROR ' ~/.local/share/opencode/feishu-notify.log
```

`ERROR` 行是无条件的：不需要你**事先**打开 debug。`FEISHU_NOTIFY_DEBUG` 是进程级的 ——
opencode **server** 常驻，改它要重启 server，光重跑客户端命令不算。

**日志文件根本不存在？** 说明还没失败过（debug 细节默认不写），或者插件没被加载。确认一下：

```sh
node scripts/deploy.mjs --check   # 在 packages/opencode 里：exit 0 = live 与包内一致
```

`--check` 的退出码：`2` = live 不存在（从未部署，不算漂移）、`1` = 漂移或 live 是符号链接
（链接会静默悬空，这正是部署用复制而不是链接的原因）。

**没发出去，日志写着 `找不到发送端`。** 全局装一次 CLI（`npm i -g feishu-notify-cli`），或用
`FEISHU_NOTIFY_BIN` 指向发送端。把 `FEISHU_NOTIFY_BIN` 指到不可执行的文件会**报错**，
这是故意的：静默落到另一个二进，会让人以为覆盖生效了，实际跑的是别的东西。

**卡片到了，但来自别的机器人。** `options.channel` 没写（插件先要 `opencode`，然后降级了），
或者写了一个不存在的 channel 名。先 `feishu-notify-cli channel list` 确认，再把
`options.channel` 设成真实存在的名字。

**一轮收到两张卡。** 加载了不止一个插件实例，或者同时存在两套接线
（`~/.config/opencode/plugins/feishu-notify.ts` **和** `opencode.json` 里的 `plugins` 条目）。
留一套。文件级抢占能合并并发实例的重复事件，合并不了"你自己接了两遍"。

## 仍未实测

如实标为未验证，而不是写成"应该没问题"：

| 项 | 原因 |
|---|---|
| `permission.asked` 真的到达 | 在 2.0.32 上从未观测到该事件。处理器已实现、结构上说得通，但**时机未实测** |
| "声明这个包就会自动安装"的端到端 | 需要包已发布。语法与归一化已实测，注册表那一环没有 |
| Windows | 发送端是 bash + `curl` + `python3`，不在范围内 |

## 测试

```sh
npm test               # 在 packages/opencode 里（仓库根也转发到所有 workspace）
```

| 套件 | 覆盖 |
|---|---|
| `tests/plugin-module.test.mjs` | 模块冒烟（`id`、`setup`）、`looksLikeQuestion` 用例表、G4 全角引号回归、`bun build` |
| `tests/channel-fallback.test.mjs` | `channelFromOptions`、argv 组装、"没有这个 channel"的窄判据、三态降级决策、日志级别 |
| `tests/notify-bin.test.mjs` | 发送端解析顺序（env / `~/.local/bin` / PATH / 都没有）、"解析不出来就不 spawn"、无条件 `ERROR` 日志 |
| `tests/routing.test.mjs` | 真实发送端 + 假 `curl`：三种配置状态下卡片打到哪个机器人（不真发卡） |
| `tests/live-gate.test.mjs` | 部署出去的文件与包内逐字节相同，且不含任何地址 |
| `tests/deploy.test.mjs` | 部署脚本的文件系统契约（只备份一次、原子替换、`--check` 退出码） |

## 许可证

MIT —— 见 [`LICENSE`](./LICENSE)。
