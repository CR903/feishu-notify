# feishu-notify（单仓三包）

给本机 AI agent 用的飞书（Lark）机器人通知 —— 一份配置层、一个发送端、每个 agent 一个适配器。
**仓库里不含任何 webhook**：地址在发送时才从用户自己的配置解析；解析不出来就 `exit 2` 并给引导语，
**绝不**把消息投到别人的机器人上。

本仓库是**单仓三包**（npm workspaces）：CLI 已实现，opencode 适配器已实现、等发布，DSH 仍是占位。

## 包一览

| 包 | 路径 | 状态 | 是什么 |
|---|---|---|---|
| `feishu-notify-cli` | [`packages/cli`](./packages/cli) | ✅ **已实现**（尚未发布到 npm） | 内核：`feishu-notify`（bash 发送端）+ `feishu-notify-cli`（Node 配置/诊断/`install` CLI），两个 bin 同包发布 |
| `opencode-feishu-notify` | [`packages/opencode`](./packages/opencode) | ✅ **已实现**（尚未发布到 npm） | opencode v2 插件：回合结束/授权/表单时出卡片，用 `--channel opencode` 路由。**不持有 webhook** —— 调发送端，地址由你的配置解析 |
| `dsh-feishu-notify`（拟） | [`packages/dsh`](./packages/dsh) | ✖ **未建** —— 仅 README 占位 | 调发送端的 DSH profile/bundle，固定 `--channel dsh` |

> `packages/dsh` **故意不放 `package.json`** —— 只有 README 的目录不会被误发布，由子任务
> `10-18-feishu-notify-dsh` 补齐。`packages/opencode` 已是真实 workspace；插件要等父任务发布后才对外可见。

图例：✅ 已实现且实测 · ⚠ 假设 / 未直接观测 · ✖ 未实现。

## 目录结构

```
.
├── package.json                 # 根：private，workspaces ["packages/*"]，测试转发
├── LICENSE                      # MIT（各包持有同一份）
├── README.md / README.zh-CN.md  # 本文件 —— 仓库级总览
└── packages/
    ├── cli/                     # 已实现的内核包
    │   ├── package.json         #   name: feishu-notify-cli，两个 bin，files 白名单
    │   ├── bin/feishu-notify    #   发送端（bash）
    │   ├── bin/feishu-notify-cli#   配置/init/channel/doctor/resolve/footer/install（Node）
    │   ├── lib/                 #   解析、命令、发送、接线自检、安装目标、密钥闸门
    │   ├── tests/               #   断言测试 + 逐字节黄金样例
    │   └── README.md            #   本包的完整文档
    ├── opencode/                # 已实现的适配器（尚未发布）
    │   ├── package.json         #   name: opencode-feishu-notify，main → src/feishu-notify.ts
    │   ├── src/feishu-notify.ts #   插件本体（无 webhook：只传 --channel，由 CLI 解析地址）
    │   ├── scripts/deploy.mjs   #   复制到 live 目录；--check 是漂移闸门
    │   ├── tests/               #   模块 / channel / 发送端解析 / 路由 / live 哈希
    │   └── README.md            #   安装、事件时机、channel 语义、排障
    └── dsh/README.md            #   占位（无 package.json）
```

## 从这里开始

安装、配置格式、命令参考、各 agent 兼容性、安全模型、回滚 —— 完整文档都在各包 README 里：

- [`packages/cli/README.zh-CN.md`](./packages/cli/README.zh-CN.md)（中文）· [`README.md`](./packages/cli/README.md)（English）
- [`packages/opencode/README.zh-CN.md`](./packages/opencode/README.zh-CN.md)（中文）· [`README.md`](./packages/opencode/README.md)（English）

速览（**推荐全局安装**：产出真实的 bin，别让接线指向开发仓库路径 —— 2026-10-18 的仓库改名事故就是这么来的）：

```sh
npm i -g feishu-notify-cli            # 两个命令进同一个 bin 目录
feishu-notify-cli init                # 问你要 webhook，先发一张测试卡片验证
feishu-notify-cli doctor              # 接线自检（发送端/解析器/Node，含悬空符号链接）+ 逐 channel 实测
feishu-notify-cli install --dry-run   # 看将要写进 agent 配置的改动（零写入）
feishu-notify-cli install             # 确认后接线：claude-code 可写；opencode 待其包发布后可声明；dsh 有前置条件
```

想让某个目标固定用某台机器人就加 `--channel <name>`：Claude Code 会附加到 hook 命令上，
opencode 会写进 `options.channel`。不加则各调用方走你配置里的 `activeChannel`。

从克隆的仓库里跑（包发布前也就是这个状态）：

```sh
node packages/cli/bin/feishu-notify-cli init
# 或者进入包目录：
cd packages/cli && node bin/feishu-notify-cli init
```

## 开发

```sh
npm test                       # 仓库根：转发到各 workspace
cd packages/cli && npm test    # CLI 套件
cd packages/opencode && npm test   # 插件套件（含 live 漂移闸门）
npm run secret-scan            # 发布闸门（全仓库 git 索引 + CLI 的 tarball）
```

根目录的 `npm test` 会跑各 workspace 的 `test` 脚本（当前是 `packages/cli` 与
`packages/opencode`）。插件套件里的 live 哈希闸门在**从未部署过**的机器上会跳过
（`deploy --check` 退出码 `2`），只有真漂移才失败。密钥闸门刻意扫**整个仓库索引**
（而不是当前目录），因此仓库根的文件与其它包都不会漂出它的视野。

## 许可证

MIT —— 见 [`LICENSE`](./LICENSE)。
