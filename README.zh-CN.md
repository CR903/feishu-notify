# feishu-notify（单仓三包）

给本机 AI agent 用的飞书（Lark）机器人通知 —— 一份配置层、一个发送端、每个 agent 一个适配器。
**仓库里不含任何 webhook**：地址在发送时才从用户自己的配置解析；解析不出来就 `exit 2` 并给引导语，
**绝不**把消息投到别人的机器人上。

本仓库是**单仓三包**（npm workspaces），目前只落了第一个包。

## 包一览

| 包 | 路径 | 状态 | 是什么 |
|---|---|---|---|
| `feishu-notify-cli` | [`packages/cli`](./packages/cli) | ✅ **已实现**（尚未发布到 npm） | 内核：`feishu-notify`（bash 发送端）+ `feishu-notify-cli`（Node 配置/诊断 CLI），两个 bin 同包发布 |
| `opencode-feishu-notify`（拟） | [`packages/opencode`](./packages/opencode) | ✖ **未建** —— 仅 README 占位 | 调发送端的 opencode 插件，固定 `--channel opencode` |
| `dsh-feishu-notify`（拟） | [`packages/dsh`](./packages/dsh) | ✖ **未建** —— 仅 README 占位 | 调发送端的 DSH profile/bundle，固定 `--channel dsh` |

> 两个适配器目录**故意不放 `package.json`** —— 只有 README 的目录不会被误发布。
> 它们由子任务 `10-18-feishu-notify-adapters-oc-cc` 与 `10-18-feishu-notify-dsh` 补齐。

图例：✅ 已实现且实测 · ⚠ 假设 / 未直接观测 · ✖ 未实现。

## 目录结构

```
.
├── package.json                 # 根：private，workspaces ["packages/*"]，测试转发
├── LICENSE                      # MIT（各包持有同一份）
├── README.md / README.zh-CN.md  # 本文件 —— 仓库级总览
└── packages/
    ├── cli/                     # 已实现的包
    │   ├── package.json         #   name: feishu-notify-cli，两个 bin，files 白名单
    │   ├── bin/feishu-notify    #   发送端（bash）
    │   ├── bin/feishu-notify-cli#   配置/init/channel/doctor/resolve/footer（Node）
    │   ├── lib/                 #   解析、命令、发送、密钥闸门
    │   ├── tests/               #   断言测试 + 逐字节黄金样例
    │   └── README.md            #   本包的完整文档
    ├── opencode/README.md       #   占位（无 package.json）
    └── dsh/README.md            #   占位（无 package.json）
```

## 从这里开始

安装、配置格式、命令参考、各 agent 兼容性、安全模型、回滚 —— 完整文档都在包 README 里：

- [`packages/cli/README.zh-CN.md`](./packages/cli/README.zh-CN.md)（中文）
- [`packages/cli/README.md`](./packages/cli/README.md)（English）

速览：

```sh
npx feishu-notify-cli init        # 问你要 webhook，先发一张测试卡片验证
npx feishu-notify-cli doctor      # 逐 channel 实测可达性
```

从克隆的仓库里跑（包发布前也就是这个状态）：

```sh
node packages/cli/bin/feishu-notify-cli init
# 或者进入包目录：
cd packages/cli && node bin/feishu-notify-cli init
```

## 开发

```sh
npm test                       # 仓库根：转发到各 workspace
cd packages/cli && npm test    # 包内：同一套测试
npm run secret-scan            # 发布闸门（全仓库 git 索引 + 本包 tarball）
```

根目录的 `npm test` 会跑各 workspace 的 `test` 脚本（当前只有 `packages/cli` 有）。
密钥闸门刻意扫**整个仓库索引**（而不是当前目录），因此仓库根的文件与其它包都不会漂出它的视野。

## 许可证

MIT —— 见 [`LICENSE`](./LICENSE)。
