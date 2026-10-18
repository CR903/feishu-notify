# `bin/feishu-notify` 来源与变更记录

本文件只记录**指纹**与**验证方法**，不含任何真实 webhook 值。

> 状态：Step 0（入库）、Step 2（发送端改为配置解析）与 R9（footer 可配置）**都已执行**；
> R10（单仓三包）也已执行，本文件现在位于 `packages/cli/bin/`。
> 当前仓库副本与 live `~/.local/bin/feishu-notify` 逐字节相同；回滚见 §4.3，footer 改造见 §5，目录迁移见 §6。

## 1. 来源

| 项 | 值 |
|---|---|
| 迁移来源 | `~/.local/bin/feishu-notify`（Step 0 时未被改动） |
| 原始 sha256（= Step 2 的 live 备份） | `0b788cf3bcaf0ac4d120e0267694032347411e8fe32ef3ebefc8a04c52f1ebde` |
| 原始规模 | 6400 字节 / 212 行 |
| Step 0 仓库副本（已入库的中间态）sha256 | `973e0cae42390fd2dc7cc608c2c455fd9c613a1bf540acaafe7874e34bebbb0f` |
| Step 0 仓库副本规模 | 6592 字节 / 214 行 |
| Step 2 后仓库副本 / live sha256（配置解析） | `1b30197ec6e14f8b5c70e06fff39156747d79f1b0cec9d726964a9cb956b99d9` |
| Step 2 后规模 | 10955 字节 / 313 行 |
| **当前**仓库副本 / live sha256（footer 改造后，= `packages/cli/bin/feishu-notify`） | `a21bc053f784bae5817041ffefd6cb560bf0a2fb94bff5432624ad87cbe81449` |
| 当前规模 | 12671 字节 / 349 行 |

> 路径注意：R10 把仓库改成单仓三包后，本文件、脚本与它引用的所有 `bin/...` 都位于
> **`packages/cli/bin/...`**（见 §6）。

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
~/.local/bin/feishu-notify-cli -> ~/project/feishu-notify/packages/cli/bin/feishu-notify-cli
```

（R10 迁移前的目标是 `~/project/opencode-feishu-notify/bin/feishu-notify-cli`；仓库改名 + 单仓化后
这条链接一度**是断的**，迁移时已重新指向。见 §6。）

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

## 5. footer 可配置（R9，2026-10-18）

### 5.1 改了什么

`build_payload` 里 note 元素的硬编码 `Smarterlab · %s` 换成配置项 `footer`：

| 配置 | note 内容 |
|---|---|
| 不配置（新装用户） | `feishu-notify · <时间戳>`（中性默认） |
| `"footer": "Smarterlab"` | `Smarterlab · <时间戳>`（作者本机外观与改造前一致） |
| `"footer": ""` | 只有 `<时间戳>` |

取值走新子命令 `feishu-notify-cli footer`（stdout 只放字符串）。footer 是**装饰性**字段：
解析失败一律回退中性默认，绝不因此不发卡 —— 这一点与 webhook 的铁律刻意相反。

### 5.2 黄金样例的有意更新（AC7 要求"记录前后哈希与原因"）

原因：note 内容从硬编码标识改为中性默认。**只有 note 变**，其余部分逐字节不变。

| 用例 | 改前 payload sha256 | 改后 payload sha256 | 归一化 note 后 sha256（前后**相同**） |
|---|---|---|---|
| idle | `39f525fbd7a6b31050af9b03fc19f523c8e930a682c45535b7ad362a44dd889f` | `de89adbcc47b2153572c3c1a8f767a6accf722f1748e92dc4415c05eb0452697` | `42161921a105a79c6fce20a15084cff6583988dadd2e9cee3bcea687395f4fd0` |
| done | `216fae8c1c1027aaa520d7e2a7b5bae9bca6d8585328e4a996be3fbb44def1fe` | `f87b8cf2e39d59d6d9580825ac04329510c3cf2e001c945697755087d5dba3c1` | `e8b85cea5b6b73b89748589408dd785d466215a260d6b08301a8529510ee6e36` |
| title-file | `08a0c5e5626c2140f23bb1b0785c59b5065557767cdb2e79b3a5f30d08debab6` | `6d308008eef44c01b6ea010c578096d893a9f759a45f17dedc2401abcdcd92a1` | `4e2eedf25692574386b07930387041b0678ea277b9d2aa35efbb74c2703c3f43` |
| bare | `368f07b2db609d9ec1709649a26eafc33742ad3aed147b349b226c712efbe609` | `5886a1de93fa032c4c3dcb26493437a60e979ab75954387e6d479d79120db4e7` | `5970005612d5a56211955ecb42bead0c0d4adcc4f8c86a5d870a5f0840b9b6a8` |
| text | `7afe1cfd9251744d11d1999892ca554ef8434a649d49502469e33aed9743f932` | **同左（逐字节未变）** | — text 模式没有 note |

"归一化 note"的归一化方法：把 note 元素的内容替换成固定占位符，其余字节原样。

### 5.3 外科手术式的证明（可复现）

```sh
# 归一化 note 后逐字节比对（无输出 = 完全相同）
norm() { sed -E 's#("tag":"note","elements":\[\{"tag":"plain_text","content":")[^"]*(")#\1<NOTE-CONTENT>\2#'; }
for c in idle done title-file bare; do
  diff <(git show <footer-改造前提交>:packages/cli/tests/fixtures/$c.payload.json | norm) \
       <(norm < packages/cli/tests/fixtures/$c.payload.json) && echo "$c: OK"
done
# 未归一化时的原始差异应当**只有一行**（note）
diff <(git show <footer-改造前提交>:packages/cli/tests/fixtures/idle.payload.json) \
     packages/cli/tests/fixtures/idle.payload.json
```

除了这次一次性取证，**`tests/footer.test.mjs` 里有一条常驻断言**把同一性质钉住：
同一输入、只换 footer 跑两次，原始 payload 必须不同、归一化 note 之后必须逐字节相同。
所以"footer 只影响 note"不是一次性的观察，而是每次 `npm test` 都会重验的性质。

另外：`*.stderr.txt` 里的"stub-curl: got payload (N bytes)"也会变 —— 那是**派生的字节数**
（note 从 10 字符变成 13 字符，payload 长 3 字节），不是独立的行为改动。

### 5.4 本机 live 迁移

- `~/.config/feishu-notify/config.json` **只多了一个键** `"footer": "Smarterlab"`：
  `channels`（含两个 channel 的地址与 label）与 `activeChannel` 逐字节不变（哈希比对过），
  权限仍是 `0600`；迁移前的副本留在 `config.json.bak.pre-footer`。
- 迁移用 CLI 自己完成（dogfood）：`init --webhook-stdin --channel default --footer Smarterlab --no-verify`
  —— 地址从 stdin 读入，不进 argv、不进输出。
- 验证：用 stub curl 跑 **live** 的 `~/.local/bin/feishu-notify`（真实配置、真实解析器发现链、
  不联网），payload 的 note 为 `Smarterlab · <时间戳>` —— 外观与改造前一致，但来源已是配置。

## 6. 单仓三包迁移（R10，2026-10-18）

仓库由 `~/project/opencode-feishu-notify` 改名为 `~/project/feishu-notify`，并整理为
npm workspaces（根 `package.json` 为 `private`）：

| 迁移前 | 迁移后 |
|---|---|
| `bin/`, `lib/`, `tests/`, `README*.md`, `package.json` | `packages/cli/` 下同名（`git mv`，历史可辨） |
| — | 根 `package.json`（`workspaces: ["packages/*"]`）、根 `README*.md`、根 `LICENSE` |
| — | `packages/cli/LICENSE`（与根同一份许可） |
| — | `packages/opencode/README.md`、`packages/dsh/README.md`（**只有 README，不放 package.json**，避免误发布空包） |

与本机相关的两处：

1. `~/.local/bin/feishu-notify-cli` 符号链接原先指向旧仓库路径，仓库改名后它**是断的**
   （发送端会退到"找不到解析器 → exit 2"）。已重新指向
   `~/project/feishu-notify/packages/cli/bin/feishu-notify-cli`。
2. `~/.local/bin/feishu-notify` 随之刷新为当前仓库副本（sha256 `a21bc053…`）；
   迁移前的版本另存为 `~/.local/bin/feishu-notify.pre-footer.bak`（sha256 `1b30197e…`）。

密钥闸门（`lib/secret-scan.mjs`）同步修正：索引扫描锚点改为 `git rev-parse --show-toplevel`，
因此从 `packages/cli` 跑也只扫"整个仓库索引 + 本包 pack 产物"，根目录与另两个包不再是盲区
（此前从子目录跑 `git ls-files` 只看得到本包）。

## 7. `install` 三目标 + 接线自检（Step 4 / R11，2026-10-18）

新增（都在 `packages/cli/lib/` 下，未改动发送端的任何行为）：

| 文件 | 职责 |
|---|---|
| `install-targets/common.mjs` | 计划与执行分离、`*.bak.<时间戳>`、temp+rename 原子写、符号链接拒绝写 |
| `install-targets/claude-code.mjs` | 合并两条 hook（按 command 去重 + "同事件同工具"的等价判重） |
| `install-targets/opencode.mjs` | `plugins` 数组声明（两种形态）、写前 `npm view` 可解析性预检 |
| `install-targets/dsh.mjs` | profile 的 `dependencies` + `dsh.profile.bundles`；默认**拒绝写**，`--dsh-dev-dir` 联调 |
| `install.mjs` | 探测 → 计划 → 确认 → 逐目标执行 → 结果表 + 回滚指令 |
| `wiring.mjs` | 接线自检（发送端 → 解析器 → Node ≥ 18），用 `lstat` 区分"悬空符号链接"与"不存在" |
| `errors.mjs` / `io.mjs` | `CommandError` 与 I/O 小工具从 `commands.mjs` 抽出，供 `install.mjs` 复用（打断循环依赖） |

**与 §4.2 里那条 live 符号链接的关系（这是 R11 的由来）**：
`~/.local/bin/feishu-notify-cli -> <仓库>/packages/cli/bin/feishu-notify-cli` 在仓库改名时曾经悬空，
导致发送端 `exit 2`、通知静默失效。§6 已经把它重新指好，但**这类布局本身就是隐患**：
它把生产接线绑在开发仓库的位置上。因此

- `install` 写进 hook 的是**裸命令名** `feishu-notify`（走 `PATH`），不写任何绝对路径；
- `doctor` 会把这条链逐环查一遍，悬空链接会被点名并给出 `rm` + `npm i -g` 的修法；
- README 的安装章节明确**推荐全局安装**（产出真实 bin）。

