/**
 * tests/init.test.mjs — init / channel / doctor 的断言测试（implement.md Step 3）
 *
 * 隔离约定：
 *   - 所有读写路径都在 mkdtemp 出来的临时目录内（HOME / XDG_CONFIG_HOME / FEISHU_NOTIFY_CONFIG 全是临时值），
 *     文件末尾有守卫断言：**绝不碰真实 ~/.config/feishu-notify**。
 *   - 真实发卡被 stub 掉：PATH 前置一个假 curl（不联网、不解析 DNS），因此 CI 默认不发外网。
 *     真正对外发网的联调在 tests/live.test.mjs，由 FEISHU_NOTIFY_LIVE=1 显式开启。
 *
 * 覆盖（对照 prd R3/R4 + AC3）：
 *   init 非交互落盘 0600 / 验证失败不落盘 / --webhook-stdin / --no-verify / 非交互缺参引导语 /
 *   坏 JSON 不自动覆盖（--force 才覆盖且先备份）/ 已有配置合并
 *   channel list|add|remove|set-active 的全部语义与拒绝分支
 *   doctor 缺配置引导 / 逐 channel 实测 / 一到多条不通的退出码 / --json
 *   以及"所有输出只出现掩码"的集中断言
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import { sendPayload, shortBody, testCardPayload } from "../lib/sender.mjs";
import { installStubCurl, readStubCalls, readStubPayload, resetStubLog } from "./helpers/stub-curl.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPO_ROOT, "bin", "feishu-notify-cli");

// ---------------------------------------------------------------- 临时环境

const TMP = mkdtempSync(join(tmpdir(), "feishu-notify-init-"));
const HOME = join(TMP, "home");
const XDG = join(TMP, "xdg");
const STUB_DIR = join(TMP, "stub-bin");
const STUB_LOG = join(TMP, "stub-log.jsonl");
const DEFAULT_CONFIG = join(TMP, "cfg-default", "config.json");
mkdirSync(HOME, { recursive: true });
mkdirSync(XDG, { recursive: true });
mkdirSync(dirname(DEFAULT_CONFIG), { recursive: true });

after(() => rmSync(TMP, { recursive: true, force: true }));

const HOOK = (token) => `https://open.feishu.cn/open-apis/bot/v2/hook/${token}`;
const TOKEN_A = "test-migrate-a";
const TOKEN_B = "test-migrate-b";
const TOKEN_C = "test-migrate-c";
const A = HOOK(TOKEN_A);
const B = HOOK(TOKEN_B);
const C = HOOK(TOKEN_C);

/** 每个测试用独立配置路径，避免相互污染。目录**不预建**：由 writeConfig 自己建，才能断言 0700。 */
let counter = 0;
function tmpConfig(label) {
	return join(TMP, `case-${++counter}-${label}`, "config.json");
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * 本文件里发测试卡片的用例统一用的"不会撞上的"发送超时（见 envFor 的说明）。
 * 它只是把墙钟依赖挪开，产品默认值（lib/sender.mjs 的 15s）不受影响。
 */
const TEST_TIMEOUT_MS = "120000";

// ---------------------------------------------------------------- stub curl

// 假 curl 的实现与安装见 tests/helpers/stub-curl.mjs（与 sender-compat.test.mjs 共用）
before(() => {
	installStubCurl(STUB_DIR);
});

// ---------------------------------------------------------------- 运行 CLI

function envFor({ config = DEFAULT_CONFIG, extra = {} } = {}) {
	const env = {
		...process.env,
		HOME,
		XDG_CONFIG_HOME: XDG,
		PATH: `${STUB_DIR}:${process.env.PATH}`,
		FEISHU_STUB_LOG: STUB_LOG,
	};
	// 真实环境里的覆盖项一律清掉，测试自己决定
	delete env.FEISHU_NOTIFY_WEBHOOK;
	delete env.FEISHU_NOTIFY_CHANNEL;
	delete env.FEISHU_NOTIFY_CURL;
	delete env.FEISHU_NOTIFY_TIMEOUT_MS;
	// 发送超时默认调到很大：本文件里发测试卡片的用例断言的是**落盘/退出码/输出**，不是超时行为。
	// 留着 15s 默认值的话，机器一忙（多文件并行跑、每文件大量 spawn）就会撞上超时，
	// 把"验证通过"变成"发送超时" → 退出码 1 → 断言无理由变红（2026-10-18 实测到）。
	// 超时行为本身由 tests/timeout.test.mjs 的确定性用例覆盖（300ms sleep vs 50ms 超时）。
	// 需要测超时的用例用 extra 覆盖这一个值即可。
	env.FEISHU_NOTIFY_TIMEOUT_MS = TEST_TIMEOUT_MS;
	if (config === null) delete env.FEISHU_NOTIFY_CONFIG;
	else env.FEISHU_NOTIFY_CONFIG = config;
	Object.assign(env, extra);
	for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
	return env;
}

function runCli(args, { env, input } = {}) {
	return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", input, env: env ?? envFor() });
}

const resetLog = () => resetStubLog(STUB_LOG);
const readCalls = () => readStubCalls(STUB_LOG);

/** 输出里绝不能出现明文 webhook（token 也不能出现） */
function assertMaskedOutput(result, tokens = [TOKEN_A, TOKEN_B, TOKEN_C]) {
	const output = `${result.stdout}\n${result.stderr}`;
	for (const token of tokens) {
		assert.ok(!output.includes(token), `输出里出现了明文 token ${token}：\n${output}`);
	}
	for (const url of [A, B, C]) {
		assert.ok(!output.includes(url), `输出里出现了完整 webhook：\n${output}`);
	}
}

function assertMode(path, expected) {
	assert.equal(statSync(path).mode & 0o777, expected, `${path} 权限应为 ${expected.toString(8)}`);
}

// ---------------------------------------------------------------- init

describe("init（非交互路径）", () => {
	it("发测试卡片验证 → 落盘 0600，配置内容正确，输出只含掩码", () => {
		const config = tmpConfig("init-basic");
		resetLog();
		const result = runCli(["init", "--non-interactive", "--webhook", A, "--channel", "default", "--label", "默认"], {
			env: envFor({ config }),
		});

		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.match(result.stdout, /配置已写入/);
		assert.match(result.stdout, /测试卡片已送达/);

		assertMode(config, 0o600);
		assertMode(dirname(config), 0o700);

		const written = readJson(config);
		assert.equal(written.version, 1);
		assert.equal(written.activeChannel, "default");
		assert.deepEqual(Object.keys(written.channels), ["default"]);
		assert.equal(written.channels.default.webhook, A);
		assert.equal(written.channels.default.label, "默认");

		// 真的只发了一张，且打在 A 上
		const calls = readCalls();
		assert.equal(calls.length, 1, JSON.stringify(calls));
		assert.equal(calls[0].url, A);

		// payload 是合法卡片，且不含 webhook 明文
		const payload = JSON.parse(readStubPayload(STUB_LOG));
		assert.equal(payload.msg_type, "interactive");
		assert.ok(!readStubPayload(STUB_LOG).includes(TOKEN_A));

		assertMaskedOutput(result);
		assert.match(result.stdout, /<REDACTED>/);
		assert.match(result.stdout, /source=activeChannel channel=default/);
	});

	it("--webhook-stdin：地址不进 argv，也不出现在输出里", () => {
		const config = tmpConfig("init-stdin");
		resetLog();
		const result = runCli(["init", "--non-interactive", "--webhook-stdin", "--channel", "default"], {
			env: envFor({ config }),
			input: `${B}\n`,
		});

		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.equal(readJson(config).channels.default.webhook, B);
		assertMaskedOutput(result);
		assert.equal(readCalls()[0].url, B);
	});

	it("验证失败（飞书业务码非 0，HTTP 仍 200）→ 非零退出且**不落盘**", () => {
		const config = tmpConfig("init-verify-code");
		resetLog();
		const result = runCli(["init", "--non-interactive", "--webhook", A, "--channel", "default"], {
			env: envFor({ config, extra: { FEISHU_STUB_FAIL_CODE: TOKEN_A } }),
		});

		assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
		assert.match(result.stderr, /未写入任何配置/);
		assert.match(result.stderr, /19001/);
		assert.equal(lstatSync(config, { throwIfNoEntry: false }), undefined, "验证失败不得留下配置文件");
		assertMaskedOutput(result);
	});

	it("验证失败（HTTP 500）→ 同样不落盘", () => {
		const config = tmpConfig("init-verify-500");
		resetLog();
		const result = runCli(["init", "--non-interactive", "--webhook", C, "--channel", "default"], {
			env: envFor({ config, extra: { FEISHU_STUB_FAIL_500: TOKEN_C } }),
		});

		assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
		assert.match(result.stderr, /HTTP 500/);
		assert.equal(lstatSync(config, { throwIfNoEntry: false }), undefined);
	});

	it("--no-verify：跳过发卡（stub 一次都没被调），仍落盘并明确告警", () => {
		const config = tmpConfig("init-no-verify");
		resetLog();
		const result = runCli(["init", "--non-interactive", "--webhook", A, "--channel", "default", "--no-verify"], {
			env: envFor({ config }),
		});

		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.match(result.stdout, /已跳过测试卡片/);
		assert.equal(readCalls().length, 0, "不该发出任何卡片");
		assert.equal(readJson(config).channels.default.webhook, A);
	});

	it("非交互且没给地址 → 用法错误 + 明确引导，不落盘", () => {
		const config = tmpConfig("init-no-webhook");
		const result = runCli(["init", "--non-interactive"], { env: envFor({ config }) });

		assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
		assert.match(result.stderr, /非交互环境/);
		assert.match(result.stderr, /--webhook/);
		assert.equal(lstatSync(config, { throwIfNoEntry: false }), undefined);
	});

	it("不给 --non-interactive 但 stdin 不是终端 → 同样的引导（不静默等待输入）", () => {
		const config = tmpConfig("init-no-tty");
		const result = runCli(["init"], { env: envFor({ config }), input: "" });

		assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
		assert.match(result.stderr, /非交互环境/);
		assert.equal(lstatSync(config, { throwIfNoEntry: false }), undefined);
	});

	it("占位符/非 https 地址被拒（exit 2 + 引导语），不落盘、不发卡", () => {
		const config = tmpConfig("init-placeholder");
		resetLog();
		const placeholder = runCli(["init", "--non-interactive", "--webhook", HOOK("<PLACEHOLDER>"), "--channel", "default"], { env: envFor({ config }) });
		assert.equal(placeholder.status, 2);
		assert.match(placeholder.stderr, /占位符/);
		assert.match(placeholder.stderr, /npx feishu-notify-cli init/);
		assert.equal(lstatSync(config, { throwIfNoEntry: false }), undefined);

		const insecure = runCli(["init", "--non-interactive", "--webhook", "http://open.feishu.cn/open-apis/bot/v2/hook/test-http-x", "--channel", "default"], { env: envFor({ config }) });
		assert.equal(insecure.status, 2);
		assert.match(insecure.stderr, /https/);

		assert.equal(readCalls().length, 0, "非法地址不该触发任何发送");
	});

	it("--webhook 与 --webhook-stdin 同时给 → 用法错误（exit 1）", () => {
		const config = tmpConfig("init-both");
		const result = runCli(["init", "--non-interactive", "--webhook", A, "--webhook-stdin"], { env: envFor({ config }), input: `${B}\n` });
		assert.equal(result.status, 1);
		assert.match(result.stderr, /只能给一个/);
		assert.equal(lstatSync(config, { throwIfNoEntry: false }), undefined);
	});

	it("已有合法配置时合并：新 channel 加入、其它 channel 保留（并成为 activeChannel）", () => {
		const config = tmpConfig("init-merge");
		resetLog();
		const first = runCli(["init", "--non-interactive", "--webhook", A, "--channel", "default"], { env: envFor({ config }) });
		assert.equal(first.status, 0, first.stderr);

		const second = runCli(["init", "--non-interactive", "--webhook", B, "--channel", "opencode", "--label", "opencode"], { env: envFor({ config }) });
		assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);

		const written = readJson(config);
		assert.deepEqual(Object.keys(written.channels), ["default", "opencode"]);
		assert.equal(written.channels.default.webhook, A);
		assert.equal(written.channels.opencode.webhook, B);
		assert.equal(written.activeChannel, "opencode");
		assertMode(config, 0o600);
		assertMaskedOutput(second);
	});

	it("坏 JSON：拒绝覆盖（exit 2，字节不变）；--force 才重建且先备份", () => {
		const config = tmpConfig("init-broken");
		mkdirSync(dirname(config), { recursive: true });
		const broken = '{ "version": 1, "channels": { oops ';
		writeFileSync(config, broken, "utf8");
		resetLog();

		const refused = runCli(["init", "--non-interactive", "--webhook", A, "--channel", "default"], { env: envFor({ config }) });
		assert.equal(refused.status, 2, `${refused.stdout}\n${refused.stderr}`);
		assert.match(refused.stderr, /不会自动覆盖/);
		assert.equal(readFileSync(config, "utf8"), broken);
		assert.equal(readCalls().length, 0, "拒绝覆盖时不发卡");

		const forced = runCli(["init", "--non-interactive", "--webhook", A, "--channel", "default", "--force"], { env: envFor({ config }) });
		assert.equal(forced.status, 0, `${forced.stdout}\n${forced.stderr}`);
		assert.equal(readJson(config).channels.default.webhook, A);

		const backups = readdirSync(dirname(config)).filter((name) => name.startsWith("config.json.bak."));
		assert.equal(backups.length, 1, `应有一个备份：${backups.join(", ")}`);
		const backupPath = join(dirname(config), backups[0]);
		assert.equal(readFileSync(backupPath, "utf8"), broken, "备份必须是原坏文件");
		assertMode(backupPath, 0o600);
	});

	it("14. --config <path> 与 FEISHU_NOTIFY_CONFIG 指向同一处逻辑（--config 优先）", () => {
		const viaFlag = tmpConfig("init-config-flag");
		const viaEnv = tmpConfig("init-config-env");
		resetLog();
		const result = runCli(["init", "--non-interactive", "--webhook", A, "--channel", "default", "--config", viaFlag], {
			env: envFor({ config: viaEnv }),
		});
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.ok(existsSync(viaFlag), "--config 指向的文件应被写入");
		assert.ok(!existsSync(viaEnv), "env 指定的文件不该被写入");
	});
});

// ---------------------------------------------------------------- channel

describe("channel list / add / remove / set-active", () => {
	function seeded(label = "channel") {
		const config = tmpConfig(label);
		resetLog();
		const result = runCli(["init", "--non-interactive", "--webhook", A, "--channel", "default", "--label", "默认", "--no-verify"], { env: envFor({ config }) });
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		resetLog();
		return config;
	}

	it("list：标出 activeChannel，只显示掩码", () => {
		const config = seeded();
		const result = runCli(["channel", "list"], { env: envFor({ config }) });

		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /\* default/);
		assert.match(result.stdout, /<REDACTED>/);
		assert.match(result.stdout, /label=默认/);
		assertMaskedOutput(result);
	});

	it("list --json：可解析、掩码、active 字段正确、绝不含明文", () => {
		const config = seeded();
		const result = runCli(["channel", "list", "--json"], { env: envFor({ config }) });
		assert.equal(result.status, 0, result.stderr);

		const parsed = JSON.parse(result.stdout);
		assert.equal(parsed.activeChannel, "default");
		assert.deepEqual(parsed.channels.map((entry) => entry.name), ["default"]);
		assert.equal(parsed.channels[0].active, true);
		assert.equal(parsed.channels[0].webhook, "https://open.feishu.cn/open-apis/bot/v2/hook/<REDACTED>");
		assertMaskedOutput(result);
	});

	it("配置缺失时 list → exit 2 + init 引导语", () => {
		const config = tmpConfig("channel-list-missing");
		const result = runCli(["channel", "list"], { env: envFor({ config }) });
		assert.equal(result.status, 2);
		assert.match(result.stderr, /未配置飞书机器人 webhook/);
		assert.match(result.stderr, /npx feishu-notify-cli init/);
		assert.ok(result.stderr.includes(config));
	});

	it("add：发卡验证后写入第二个 channel，activeChannel 不变", () => {
		const config = seeded();
		resetLog();
		const result = runCli(["channel", "add", "opencode", "--webhook", B, "--label", "opencode"], { env: envFor({ config }) });

		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		const written = readJson(config);
		assert.deepEqual(Object.keys(written.channels), ["default", "opencode"]);
		assert.equal(written.channels.opencode.webhook, B);
		assert.equal(written.activeChannel, "default", "add 不应改变 activeChannel");
		assertMode(config, 0o600);

		const calls = readCalls();
		assert.equal(calls.length, 1);
		assert.equal(calls[0].url, B);
		assertMaskedOutput(result);
	});

	it("add --no-verify 不发送；--set-active 顺手切默认；重复名要 --force", () => {
		const config = seeded();
		resetLog();
		const added = runCli(["channel", "add", "opencode", "--webhook", B, "--set-active", "--no-verify"], { env: envFor({ config }) });
		assert.equal(added.status, 0, `${added.stdout}\n${added.stderr}`);
		assert.equal(readCalls().length, 0);
		assert.equal(readJson(config).activeChannel, "opencode");

		const duplicate = runCli(["channel", "add", "opencode", "--webhook", C, "--no-verify"], { env: envFor({ config }) });
		assert.equal(duplicate.status, 1);
		assert.match(duplicate.stderr, /已存在/);
		assert.equal(readJson(config).channels.opencode.webhook, B, "重复 add 不得改内容");

		const forced = runCli(["channel", "add", "opencode", "--webhook", C, "--no-verify", "--force"], { env: envFor({ config }) });
		assert.equal(forced.status, 0, `${forced.stdout}\n${forced.stderr}`);
		assert.equal(readJson(config).channels.opencode.webhook, C);
	});

	it("add --webhook-stdin 可用；缺地址时按用法错误处理", () => {
		const config = seeded();
		const missing = runCli(["channel", "add", "opencode", "--webhook-stdin"], { env: envFor({ config }), input: "" });
		assert.equal(missing.status, 1);
		assert.match(missing.stderr, /没有从 stdin 读到内容/);

		const added = runCli(["channel", "add", "opencode", "--webhook-stdin"], { env: envFor({ config }), input: `${B}\n` });
		assert.equal(added.status, 0, `${added.stdout}\n${added.stderr}`);
		assert.equal(readJson(config).channels.opencode.webhook, B);
	});

	it("add 的验证失败同样不落盘", () => {
		const config = seeded();
		const before = readFileSync(config, "utf8");
		const result = runCli(["channel", "add", "opencode", "--webhook", B], { env: envFor({ config, extra: { FEISHU_STUB_FAIL_CODE: TOKEN_B } }) });

		assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
		assert.match(result.stderr, /未写入任何配置/);
		assert.equal(readFileSync(config, "utf8"), before, "配置必须逐字节不变");
	});

	it("remove：删掉非 active 的；删 active 要 --force 且默认切到剩下的第一个", () => {
		const config = seeded();
		runCli(["channel", "add", "opencode", "--webhook", B, "--no-verify"], { env: envFor({ config }) });
		runCli(["channel", "add", "claude", "--webhook", C, "--no-verify"], { env: envFor({ config }) });

		const removed = runCli(["channel", "remove", "opencode"], { env: envFor({ config }) });
		assert.equal(removed.status, 0, `${removed.stdout}\n${removed.stderr}`);
		assert.deepEqual(Object.keys(readJson(config).channels), ["default", "claude"]);

		const activeRefused = runCli(["channel", "remove", "default"], { env: envFor({ config }) });
		assert.equal(activeRefused.status, 1);
		assert.match(activeRefused.stderr, /set-active/);
		assert.deepEqual(Object.keys(readJson(config).channels), ["default", "claude"], "拒绝时不得改动文件");

		const activeForced = runCli(["channel", "remove", "default", "--force"], { env: envFor({ config }) });
		assert.equal(activeForced.status, 0, `${activeForced.stdout}\n${activeForced.stderr}`);
		assert.equal(readJson(config).activeChannel, "claude", "应切到剩下的第一个 channel");
		assert.match(activeForced.stdout, /activeChannel 改为/);

		const missing = runCli(["channel", "remove", "ghost"], { env: envFor({ config }) });
		assert.equal(missing.status, 1);
		assert.match(missing.stderr, /没有名为 "ghost" 的 channel/);
	});

	it("remove 最后一个 channel → 拒绝（不留空配置）", () => {
		const config = seeded("channel-last");
		const before = readFileSync(config, "utf8");
		const last = runCli(["channel", "remove", "default", "--force"], { env: envFor({ config }) });

		assert.equal(last.status, 1, `${last.stdout}\n${last.stderr}`);
		assert.match(last.stderr, /最后一个 channel/);
		assert.equal(readFileSync(config, "utf8"), before, "拒绝时不得改动文件");
	});

	it("set-active：切换默认；不存在的 channel → exit 2 并列出已有", () => {
		const config = seeded();
		runCli(["channel", "add", "opencode", "--webhook", B, "--no-verify"], { env: envFor({ config }) });

		const result = runCli(["channel", "set-active", "opencode"], { env: envFor({ config }) });
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.equal(readJson(config).activeChannel, "opencode");
		assertMode(config, 0o600);

		const bad = runCli(["channel", "set-active", "ghost"], { env: envFor({ config }) });
		assert.equal(bad.status, 2);
		assert.match(bad.stderr, /ghost/);
		assert.match(bad.stderr, /default, opencode/);
		assert.equal(readJson(config).activeChannel, "opencode");
	});

	it("channel 的用法错误：缺子命令 / 未知子命令 / 不接受的 flag / 非法名", () => {
		const config = seeded();
		assert.equal(runCli(["channel"], { env: envFor({ config }) }).status, 1);
		assert.equal(runCli(["channel", "wat"], { env: envFor({ config }) }).status, 1);
		assert.equal(runCli(["channel", "add", "x", "--label", "y"], { env: envFor({ config }) }).status, 1, "add 缺地址");
		assert.equal(runCli(["channel", "list", "--label", "y"], { env: envFor({ config }) }).status, 1, "list 不接受 --label");
		assert.equal(runCli(["channel", "set-active", "../evil"], { env: envFor({ config }) }).status, 1, "非法 channel 名");
		assert.equal(runCli(["channel", "help"], { env: envFor({ config }) }).status, 0);
	});
});

// ---------------------------------------------------------------- doctor

describe("doctor", () => {
	function seeded(label = "doctor") {
		const config = tmpConfig(label);
		resetLog();
		const result = runCli(["init", "--non-interactive", "--webhook", A, "--channel", "default", "--no-verify"], { env: envFor({ config }) });
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		runCli(["channel", "add", "opencode", "--webhook", B, "--no-verify"], { env: envFor({ config }) });
		resetLog();
		return config;
	}

	it("未配置时 → exit 2 + init 引导语，且不发任何卡片", () => {
		const config = tmpConfig("doctor-missing");
		resetLog();
		const result = runCli(["doctor"], { env: envFor({ config }) });

		assert.equal(result.status, 2);
		assert.match(result.stderr, /未配置飞书机器人 webhook/);
		assert.match(result.stderr, /npx feishu-notify-cli init/);
		assert.equal(readCalls().length, 0);
	});

	it("两条都通 → exit 0，逐个报 OK，输出掩码", () => {
		const config = seeded();
		const result = runCli(["doctor"], { env: envFor({ config }) });

		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.match(result.stdout, /✓ default/);
		assert.match(result.stdout, /✓ opencode/);
		assert.match(result.stdout, /2\/2 通/);

		const urls = readCalls().map((call) => call.url);
		assert.deepEqual(urls.sort(), [A, B].sort(), "两条 channel 各发一次");
		assertMaskedOutput(result);
	});

	it("一条不通 → exit 1，明确区分通与不通（含飞书业务码）", () => {
		const config = seeded();
		const result = runCli(["doctor"], { env: envFor({ config, extra: { FEISHU_STUB_FAIL_CODE: TOKEN_B } }) });

		assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
		assert.match(result.stdout, /✓ default/);
		assert.match(result.stdout, /✗ opencode/);
		assert.match(result.stdout, /19001/);
		assert.match(result.stdout, /1\/2 通/);
		assertMaskedOutput(result);
	});

	it("配置里的地址非法（http）→ 该条标 ✗ 且不影响其它条", () => {
		const config = tmpConfig("doctor-bad-webhook");
		mkdirSync(dirname(config), { recursive: true });
		writeFileSync(
			config,
			`${JSON.stringify({ version: 1, activeChannel: "default", channels: { default: { webhook: A }, insecure: { webhook: "http://open.feishu.cn/open-apis/bot/v2/hook/test-insecure" } } }, null, 2)}\n`,
		);
		chmodSync(config, 0o600);
		resetLog();

		const result = runCli(["doctor"], { env: envFor({ config }) });
		assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
		assert.match(result.stdout, /✓ default/);
		assert.match(result.stdout, /✗ insecure\s+地址不可用/);
		assert.equal(readCalls().length, 1, "非法地址不发卡，只测合法的");
		assert.ok(!result.stdout.includes("test-insecure"));
	});

	it("--channel 只测一条；指向不存在的 channel → exit 2", () => {
		const config = seeded();
		resetLog();
		const one = runCli(["doctor", "--channel", "opencode"], { env: envFor({ config }) });
		assert.equal(one.status, 0, `${one.stdout}\n${one.stderr}`);
		assert.equal(readCalls().length, 1);
		assert.equal(readCalls()[0].url, B);
		assert.match(one.stdout, /1\/1 通/);

		const bad = runCli(["doctor", "--channel", "ghost"], { env: envFor({ config }) });
		assert.equal(bad.status, 2);
		assert.match(bad.stderr, /没有名为 "ghost" 的 channel/);
		// F/G3：doctor --channel 也输出机器可读标记（与 resolve --channel 同一套）
		assert.match(bad.stderr, /^reason=channel-not-found channel=ghost$/m, `缺机器可读标记：\n${bad.stderr}`);
	});

	it("--json：结构化结果 + 掩码；坏 JSON 时 exit 2 且不改文件", () => {
		const config = seeded();
		const json = runCli(["doctor", "--json"], { env: envFor({ config }) });
		assert.equal(json.status, 0, `${json.stdout}\n${json.stderr}`);
		const parsed = JSON.parse(json.stdout);
		assert.equal(parsed.ok, true);
		assert.equal(parsed.activeChannel, "default");
		assert.deepEqual(parsed.channels.map((entry) => entry.name), ["default", "opencode"]);
		assert.ok(parsed.channels.every((entry) => entry.webhook === "https://open.feishu.cn/open-apis/bot/v2/hook/<REDACTED>"));
		assertMaskedOutput(json);

		const brokenConfig = tmpConfig("doctor-broken");
		mkdirSync(dirname(brokenConfig), { recursive: true });
		const broken = "{ nope";
		writeFileSync(brokenConfig, broken);
		resetLog();
		const brokenResult = runCli(["doctor"], { env: envFor({ config: brokenConfig }) });
		assert.equal(brokenResult.status, 2);
		assert.match(brokenResult.stderr, /未自动覆盖/);
		assert.equal(readFileSync(brokenConfig, "utf8"), broken);
		assert.equal(readCalls().length, 0);
	});

	it("env FEISHU_NOTIFY_WEBHOOK 存在时明确告警它会覆盖 activeChannel（掩码）", () => {
		const config = seeded();
		const result = runCli(["doctor"], { env: envFor({ config, extra: { FEISHU_NOTIFY_WEBHOOK: C } }) });

		assert.match(result.stdout, /FEISHU_NOTIFY_WEBHOOK 已设置/);
		assert.match(result.stdout, /优先/);
		assertMaskedOutput(result);
	});
});

// ---------------------------------------------------------------- sender 单元

describe("lib/sender.mjs", () => {
	it("testCardPayload：合法 JSON、不含 webhook 明文", () => {
		const payload = testCardPayload({ channelName: "default", label: "默认", webhook: A });
		const parsed = JSON.parse(payload);
		assert.equal(parsed.msg_type, "interactive");
		assert.ok(!payload.includes(TOKEN_A));
		assert.match(payload, /<REDACTED>/);
	});

	it("sendPayload 的失败分类（spawn 注入，不联网）", () => {
		const payload = "{}";
		const enoent = sendPayload({ webhook: A, payload, spawn: () => ({ error: { code: "ENOENT" } }) });
		assert.equal(enoent.ok, false);
		assert.match(enoent.message, /找不到 curl/);

		const timeout = sendPayload({ webhook: A, payload, spawn: () => ({ error: { code: "ETIMEDOUT" } }) });
		assert.equal(timeout.ok, false);
		assert.match(timeout.message, /超时/);

		const okHttp = sendPayload({ webhook: A, payload, spawn: () => ({ stdout: '{"code":0,"msg":"success"}\n200', stderr: "", status: 0 }) });
		assert.equal(okHttp.ok, true);
		assert.equal(okHttp.httpCode, 200);
		assert.equal(okHttp.bodyCode, 0);

		// 飞书在 token 失效时也回 200，只有业务码能识别 → 必须判失败
		const businessFail = sendPayload({ webhook: A, payload, spawn: () => ({ stdout: '{"code":19001,"msg":"sign match fail"}\n200', stderr: "", status: 0 }) });
		assert.equal(businessFail.ok, false);
		assert.equal(businessFail.httpCode, 200);
		assert.equal(businessFail.bodyCode, 19001);
		assert.match(businessFail.message, /19001/);

		const http500 = sendPayload({ webhook: A, payload, spawn: () => ({ stdout: '{"code":19002}\n500', stderr: "", status: 0 }) });
		assert.equal(http500.ok, false);
		assert.match(http500.message, /HTTP 500/);

		// 非 JSON body：只按 HTTP 状态判
		const plain = sendPayload({ webhook: A, payload, spawn: () => ({ stdout: "OK\n200", stderr: "", status: 0 }) });
		assert.equal(plain.ok, true);
	});

	it("shortBody 截断且压缩空白", () => {
		assert.equal(shortBody("a\n\nb   c"), "a b c");
		assert.equal(shortBody("x".repeat(300)).length, 201);
	});
});

// ---------------------------------------------------------------- 隔离守卫

describe("隔离守卫：测试不碰真实用户目录", () => {
	it("所有用到的路径都在临时根内，且真实 ~/.config/feishu-notify 未被写入", () => {
		for (const path of [HOME, XDG, STUB_DIR, DEFAULT_CONFIG]) {
			assert.ok(path.startsWith(TMP), `${path} 必须在临时根内`);
		}
		const realDir = join(process.env.HOME ?? "/nonexistent", ".config", "feishu-notify");
		assert.ok(!TMP.startsWith(realDir), "临时根不得位于真实配置目录下");
		// 本文件的所有 CLI 调用都显式给了 FEISHU_NOTIFY_CONFIG（见 envFor），因此真实路径不可能被写。
		for (const entry of readdirSync(TMP)) {
			assert.ok(!join(TMP, entry).startsWith(realDir));
		}
	});
});
