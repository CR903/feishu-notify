# `bin/feishu-notify` 来源与变更记录

本文件只记录**指纹**与**验证方法**，不含任何真实 webhook 值。

> 状态：Step 0（入库）与 Step 2（发送端改为配置解析）**都已执行**。
> 当前仓库副本与 live `~/.local/bin/feishu-notify` 逐字节相同；回滚见 §4.3。

## 1. 来源

| 项 | 值 |
|---|---|
| 迁移来源 | `~/.local/bin/feishu-notify`（Step 0 时未被改动） |
| 原始 sha256（= Step 2 的 live 备份） | `0b788cf3bcaf0ac4d120e0267694032347411e8fe32ef3ebefc8a04c52f1ebde` |
| 原始规模 | 6400 字节 / 212 行 |
| Step 0 仓库副本（已入库的中间态）sha256 | `973e0cae42390fd2dc7cc608c2c455fd9c613a1bf540acaafe7874e34bebbb0f` |
| Step 0 仓库副本规模 | 6592 字节 / 214 行 |
| **当前**仓库副本 / live sha256（Step 2 后） | `1b30197ec6e14f8b5c70e06fff39156747d79f1b0cec9d726964a9cb956b99d9` |
| 当前规模 | 10955 字节 / 313 行 |

## 2. Step 0 入库时的差异（**有意为之，非静默偏离**；Step 2 已彻底移除该地址）

原始脚本第 27 行把**用户个人的**飞书 webhook 硬编码为 `WEBHOOK_URL` 的默认值
（`research/current-state-and-risks.md` 的 R-1 阻塞项）。本任务的硬约束是
“任何文件里都不得出现真实 webhook 值”，而 Step 0 又要求把脚本“原样复制”进仓库 ——
两者不可同时满足。处置：

- 该字面量被替换为 `https://open.feishu.cn/open-apis/bot/v2/hook/<PLACEHOLDER>`
  （占位符，**不是**可用地址，角度括号形式让密钥闸门可识别为占位）；
- 其上方两行注释同时改写，说明“v1 不再内置地址、由配置解析提供”。

差异范围已经逐行核对：**只有** 25–27 行 → 25–29 行这一个 hunk，其余 200+ 行逐字节相同。
复核命令（先脱敏再 diff，因此**不会**把原始 webhook 打到终端），比对对象是**回滚备份**：

```sh
diff <(sed -E 's#(open-apis/bot/v2/hook/)[^" ]+#\1<REDACTED>#g' ~/.local/bin/feishu-notify.pre-config.bak) \
     <(sed -E 's#(open-apis/bot/v2/hook/)[^" ]+#\1<REDACTED>#g' bin/feishu-notify.orig)
```

（`bin/feishu-notify.orig` 就是 §1 里那个“Step 0 中间态”的逐字节副本，留着用于回答
“Step 2 只改了 webhook 来源吗？”：`diff bin/feishu-notify.orig bin/feishu-notify`。）

## 3. 为什么这不影响黄金样例（AC4）

webhook 值从不进入 payload —— payload 只有 `msg_type` / `card.header` / `card.elements`，
URL 只作为 curl 的目标参数。`tests/capture-fixtures.sh` 用 stub curl 记录目标 URL 并
**脱敏后**落盘，因此 5 组 fixtures 的 payload 字节与 webhook 取什么值无关。
（Step 2 之后脚本改为从配置解析地址，harness 显式钉住解析输入，结论不变 —— 见 §4.4。）

## 4. Step 2 已经执行完（2026-10-18）：发送端改为从配置解析 webhook

### 4.1 现状指纹

| 项 | 值 |
|---|---|
| live 改动前（= 备份）`~/.local/bin/feishu-notify` | sha256 `0b788cf3bcaf0ac4d120e0267694032347411e8fe32ef3ebefc8a04c52f1ebde`（6400B / 212 行） |
| live 备份路径 | `~/.local/bin/feishu-notify.pre-config.bak`（`cp -p`，权限 755 原样） |
| live 改动后 `~/.local/bin/feishu-notify` | sha256 `1b30197ec6e14f8b5c70e06fff39156747d79f1b0cec9d726964a9cb956b99d9`（10955B / 313 行） |
| 仓库副本 `bin/feishu-notify` | 与 live 改动后**逐字节相同**（`cmp` 一致） |

### 4.2 Step 2 改了什么（相对 `bin/feishu-notify.orig`，即改造前基线）

1. `WEBHOOK_URL` 的默认值**彻底删除**（不再有任何内置地址）；新增 `--channel <name>` 与 `WEBHOOK_FROM_FLAG`；
2. 发送前调用 `feishu-notify-cli resolve`（解析逻辑只有那一份实现），失败按 design §2 **exit 2 + 引导语**；
3. 解析器是 Node 脚本 → 显式挑一个 **Node >= 18** 的解释器（`$FEISHU_NOTIFY_NODE` > PATH 上的 node >
   `/usr/local/bin/node` > `/opt/homebrew/bin/node` > nvm）。**这台机器的 `/usr/local/bin/node` 是 v14.17.5**，
   而 hook 环境的 PATH 不一定含 nvm 那一份 —— 不做这层检查就会撞上"node 太旧"的难懂报错。
4. 用法提示与配置区注释同步更新。

解析器的发现顺序：`$FEISHU_NOTIFY_CLI` > **本脚本同目录**的 `feishu-notify-cli` > `$HOME/.local/bin/feishu-notify-cli` > `PATH`。
本机为此把仓库 CLI 链进了 `~/.local/bin/`（等价于 `npm i -g` 之后的布局）：

```
~/.local/bin/feishu-notify-cli -> ~/project/opencode-feishu-notify/bin/feishu-notify-cli
```

### 4.3 回滚

```sh
cp -p ~/.local/bin/feishu-notify.pre-config.bak ~/.local/bin/feishu-notify   # 回到硬编码地址
shasum -a 256 ~/.local/bin/feishu-notify   # 期望 0b788cf3…c52f1ebde
```

注意：回滚后 live 脚本又会内置个人地址（回到迁移前状态）；配置文件 `~/.config/feishu-notify/config.json`
可以留着（新脚本才读它）。`bin/feishu-notify.orig` 是**脱敏**基线，只用于看 diff，不能用于回滚。

### 4.4 黄金样例（AC4）与 webhook 无关的证明

payload 只有 `msg_type` / `card.header` / `card.elements`，URL 只作为 curl 的目标参数。
Step 2 之后 `tests/capture-fixtures.sh` 显式钉住解析输入（`FEISHU_NOTIFY_CLI` + 白名单样例地址
`FEISHU_NOTIFY_WEBHOOK=…/hook/test-fixture-0001`），因此捕获结果不随本机配置漂移；
改造前后 16 个既有 fixture 文件**逐字节相同**（payload / url / stdout / exit-codes），
只多出 5 个 `*.stderr.txt`（记录 `source=env` 与实际交给 curl 的地址掩码）。
