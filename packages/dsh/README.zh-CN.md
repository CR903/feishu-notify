# `dsh-feishu-notify` — DSH（Cordis）适配器

一轮结束时、harness 要你拍板时、或者需要你**回答**（含计划待批）时，从 **DSH** 发飞书（Lark）卡片。
发送走共用的 `feishu-notify` CLI —— 地址由它从**你自己的配置**解析：本包**不含任何地址**，
也从不自己发 HTTP。

> **状态：已实现，尚未发布。** 下文所有结论都在本机 DSH **0.2.0-rc.2** 上实测。`packages/dsh`
> 曾被 link 进一个一次性 profile（**现已删除**），回合结束那条路径（卡片到达、`--channel dsh`
> 解析、卸载）已端到端验证；`user-questions/request` waterfall 是按随包发布的 `.d.ts` 实现的、
> 由 stub 测试覆盖，但**尚未在真实 DSH 里观测到它触发**（见文末「实测 vs 未实测」）。

## 它做什么

两个订阅 —— `session/event`（提交后的 fire-and-forget 事件流）与阻塞的
`user-questions/request` waterfall —— 都映射成卡片：

| 钩子 | 卡片 | 说明 |
|---|---|---|
| `session/event` → `turn/end`，`reason.kind === 'completed'` | ✅ 任务完成 | 回合墙钟耗时、模型、按回合折叠的 tokens、会话累计输出 |
| `session/event` → `turn/end`，`kind === 'error'` | ❌ 任务失败 | `LlmFailure` 的消息 / code / HTTP 状态 |
| `session/event` → `turn/end`，`kind === 'aborted'` | ⏸ 任务已中断 | 取消来源（`user` / `parent` / `hook` / `disposed`） |
| `session/event` → `turn/end`，`kind === 'blocked'` | 🚫 任务被拦下 | |
| `session/event` → `turn/end`，`kind === 'max-tokens'` | ⚠️ 已达 token 上限 | |
| `session/event` → `turn/end`，其它任意 `kind` | ❓ 未知状态 | 绝不抛错；原样打印那个 `kind` |
| `session/event` → `approval/asked` | 🔔 需要你决定 | 工具名 + 申请人的说明 |
| `session/event` → `tool/result` 且 `isError` | ❌ 工具失败 | **默认关**（`toolFailures: true` 打开） |
| `user-questions/request` | ❓ 需要你回答 | 问题清单（`header` / `question` / 选项） |
| `user-questions/request` 且 `intent.kind === 'plan-review'` | ❓ 需要你回答 · 计划待批 | 同一张卡，加标记，并换用 `approve` 标签 |

指标**缺了就省略，绝不编造**：没有模型 → 不写模型行，没有 token 用量 → 不写 token 行。
而且**刻意不做 tok/s** —— DSH 只给回合墙钟时间（含工具等待），拿它当除数算出来的是一个
没有意义的数。

## `user-questions/request` 是**阻塞** waterfall（改之前先读）

DSH 里唯一真正表示「harness 需要你给个答案」的钩子，是 Cordis 的 **waterfall**
`user-questions/request`（`@deepseek-ai/dsh-user-questions/lib/types/types.d.ts:145`）：

```ts
'user-questions/request'(this: Scoped<Agent>, request: AskUserQuestionRequestEvent,
                         next: () => Promise<AskUserQuestionAnswer>): Promise<AskUserQuestionAnswer>
```

两条规则保证这个适配器是透明的：

1. **fire-and-forget。** 处理器启动 `spawn` 之后立刻返回，**绝不 `await`** 这次发送。
   在一个阻塞钩子里 await 外部进程，就是把自己的网络往返变成别人的延迟。
2. **永远委派。** 必须调用 `next()` 并返回它的 promise —— 在 Cordis 的 waterfall 里，
   不调 `next()` 的 listener **会否决整条链**
   （`@deepseek-ai/cordis/lib/index.js:317-331`），真正答题的 UI 就永远看不到这个问题，
   `ask()` 会拿到一个假答案。

净效果：处理器是透明的（你拿回来的 promise 就是 `next()` 的那个），我们在委派前只多加了一次
`spawn`。这条性质的可证伪版本在 `tests/user-questions.test.mjs`：一个**挂起**的发送 promise
不能阻止 `next()` 被同步调用。

## 不做什么（以及为什么）

- **不从卡片里答题。** 审批 / 提问 waterfall 属于 DSH 客户端 UI。卡片是单向的（与 opencode
  适配器一样）—— 我们只通知，从不答题。
- **不把 `agent/turn-stopping` 当「回合结束」。** 它在回合关闭**之前**触发，别的 listener
  可以 `agent.steer()` 把它救回来 —— 用它就会发出假的「已完成」。
- **不读 `sessionStats` / TPS / 纯生成耗时。** 那份投影只由 `dsh-web-app` bundle 挂载，
  非 web profile 没有。
- **不注册 `session/event → user-question-reply`。** 原设计稿假定有这个事件；它是错的。
  `user-question-reply` 是 `MessageSourceMap` 的一个成员
  （`@deepseek-ai/dsh-user-questions/lib/types/types.d.ts:104`），也就是
  `user/message.source.kind`，而不是 session 事件 —— 注册这个名字**永远不会触发**。
  真正的钩子是上面那个 waterfall。

## 配置

只有两个键；webhook 与 channel 定义仍在 CLI 自己那份配置里
（`~/.config/feishu-notify/config.json`）：

```yaml
# profile cordis.patch.yml —— patch 配置是**整块替换**，不是合并
- id: feishu-notify
  name: dsh-feishu-notify
  config:
    channel: dsh          # 是 --channel 的名字，不是地址
    toolFailures: false
```

每一类卡片默认都开（回合结束、审批、需要你回答 / 计划待批）；只有 `toolFailures` 需要显式打开，
因为一轮里可能产生几十次失败的工具调用。

## 卡片去哪个机器人？（`dsh` channel）

`channel: dsh` 是一个**名字**，永远不是地址 —— 由 CLI 从*你的*配置解析。在构建本包的机器上，
今天 `dsh` 与 `default` 指向**同一个机器人**（已核验：两者的 webhook 指纹相同，`opencode` 的
不同 —— 见下面的片段）。这是当前刻意的选择，不是缺陷：一个机器人、每个适配器各有自己的
channel 名字，所以接线已经是通的。

将来要给 DSH 单独一个机器人，只改 CLI 配置就行 —— 这个插件一行都不用动：

```bash
# 1. 在飞书群里建机器人、复制它的 webhook，然后从 stdin 喂进去，让地址永不
#    落进 argv / shell 历史（插件本身依旧不含任何地址）：
printf '%s' 'https://open.feishu.cn/open-apis/bot/v2/hook/…' \
  | feishu-notify-cli channel add dsh --webhook-stdin --force

# 2. 验证可达性 + 看生效接线（同时打印每个 channel 的掩码地址）：
feishu-notify-cli doctor --channel dsh
```

`--force` 是必需的，因为该 channel 已经存在。换完之后插件侧不需要重启什么配置 ——
它永远只传 `--channel dsh`。

> **怎么判断两个 channel 是不是同一个机器人。** `doctor`（以及 `channel list`）打印的是
> **掩码**地址：飞书 webhook 唯一的部分是 *token*（`…/bot/v2/hook/<token>`），而它被涂掉了 ——
> 所以"两个 channel 同一个机器人"和"两个 channel 不同机器人"看起来一模一样，
> 目前也还没有任何同地址提示。想在不打印地址的前提下比对，就在本地算指纹
> （Node 本来就是本项目的依赖；输出是 8 位十六进制 + channel 名）：
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
> 指纹相同 ⇒ 同一个机器人。把这个提示加进 `doctor` 属于改 `packages/cli`，不在本适配器范围内。

## 安装（发布之后）

```bash
dsh plugin --profile <name> pnpm add dsh-feishu-notify
```

本包声明了 `dsh.bundle.patch`，所以插件管理器会自动把它追加进 `dsh.profile.bundles`。
本地开发时，把依赖指到这个目录即可
（`link:` / `feishu-notify-cli install --target dsh --dsh-dev-dir`）。

## 卸载

`dsh plugin --profile <name> remove dsh-feishu-notify` 同时会把它从 `dsh.profile.bundles`
里删掉。如果你往 profile 自己的 `cordis.patch.yml` 里加过 `- id: feishu-notify` 覆盖块，
那行也要一起删 —— 一个匹配不到任何行的 patch 只会产生一条启动告警，但那也仍然是垃圾。

## 排障

失败**无条件**记 **ERROR 级**日志（没有任何 debug 开关能挡住它们）：

- **一张卡都没有。** 在 DSH 日志里找 `dsh-feishu-notify: 找不到发送端 feishu-notify`。
  发送端每次发送都重新解析：`FEISHU_NOTIFY_BIN` → `~/.local/bin/feishu-notify` → `PATH` → 放弃。
  如果 `FEISHU_NOTIFY_BIN` 设了但不可执行，它**不会**被静默忽略 —— 那条报错说的就是字面意思。
- **卡片发到了别的机器人。** `--channel` 的名字必须存在于 CLI 配置里；注意这个适配器与 opencode
  那个不同，**不会**去掉 `--channel` 重试。
- **收不到「需要你回答」卡片。** 那个钩子是**按 scope 过滤**的 waterfall：带 agent scope 的
  listener 只能看到那个 agent 的问题，而未打标记者（本插件注册在 root context 上）是全局放行的
  （`@deepseek-ai/dsh-scope/lib/index.js:329-337`）。如果你把它重注册到某个 agent scope 下，
  等于你主动收窄了范围。注意我们只是*listener*，不是答题方 —— 一个请求如果没有任何 UI 认领，
  DSH 依旧报 `NO_PROVIDER`，跟没有我们的时候一模一样。
- **版本漂移。** 是按 DSH 0.2.0-rc.2 构建的。刻意不声明任何 `@deepseek-ai/dsh-*` peer
  （rc 版本进 peer 范围是地雷）；所有服务都走 duck-type。

## 开发

```bash
npm test -w packages/dsh
```

不需要 DSH 运行时：纯映射函数 + 一套假 `ctx` 夹具覆盖事件映射，再加一次针对替身可执行文件的
真实 `spawn`，用来证明 argv 契约。

## 实测 vs 未实测

| 范围 | 状态 |
|---|---|
| `turn/end` → 卡片、真实 profile、`--channel dsh` 解析、卸载 | ✅ 在一次性 profile 里端到端观测到 |
| `user-questions/request` 映射 + fire-and-forget / `next()` 契约 | ⚠ 仅 stub 测试 —— **从未在真实 DSH 里观测到触发**（没有把真实的 `ask_user_question` 跑过 live profile） |
| root context 的 listener 被 scope 过滤的 waterfall 放行 | ⚠ 读的是 `dsh-scope` 源码（未打标 ⇒ 全局），未在运行时观测 |
| `approval/asked`、`tool/result`、另外四种 `turn/end` 原因 | ⚠ 仅 stub 测试 |
| 从 npm 注册表安装（`dsh plugin … add dsh-feishu-notify`） | ⚠ 包尚未发布 |
| 0.2.0-rc.2 以外的 DSH 版本 | ⚠ 未测试 |
