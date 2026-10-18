/**
 * tests/config-resolution.test.mjs — lib/config.mjs 的断言测试
 *
 * 隔离约定：所有路径都在 mkdtemp 出来的临时目录里，HOME / XDG_CONFIG_HOME /
 * FEISHU_NOTIFY_CONFIG 全部指向临时目录，**绝不碰真实 ~/.config**（文件末尾有守卫断言）。
 *
 * 表驱动覆盖（implement.md Step 1）：
 *   flag / channel / env / activeChannel / 全缺报错 / 坏 JSON / 非 https / 0600 权限
 */

import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";

import {
	CONFIG_VERSION,
	ConfigError,
	configPath,
	maskWebhook,
	readConfig,
	resolveWebhook,
	validateConfigShape,
	writeConfig,
} from "../lib/config.mjs";

// ---------------------------------------------------------------- 临时环境

const TMP = mkdtempSync(join(tmpdir(), "feishu-notify-config-"));
const HOME = join(TMP, "home");
const XDG = join(TMP, "xdg");
const CONFIG_FILE = join(TMP, "explicit", "config.json");
const MISSING_FILE = join(TMP, "explicit", "does-not-exist.json");
mkdirSync(HOME, { recursive: true });
mkdirSync(XDG, { recursive: true });

after(() => rmSync(TMP, { recursive: true, force: true }));

/** 所有测试用的 env 都从这里出：路径全在 TMP 内 */
function makeEnv(overrides = {}) {
	return {
		HOME,
		XDG_CONFIG_HOME: XDG,
		FEISHU_NOTIFY_CONFIG: CONFIG_FILE,
		...overrides,
	};
}

/** 测试用 hook：token 用 test-* 前缀，密钥闸门把它当样例（真实 token 是 UUID 形状） */
const HOOK = (token) => `https://open.feishu.cn/open-apis/bot/v2/hook/${token}`;

const CONFIG = {
	version: CONFIG_VERSION,
	activeChannel: "default",
	channels: {
		default: { webhook: HOOK("test-default"), label: "默认" },
		opencode: { webhook: HOOK("test-opencode"), label: "opencode" },
	},
};

function writeJson(path, value) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

// ---------------------------------------------------------------- 表驱动：优先级

const PRIORITY_CASES = [
	{
		name: "1. flag 最高优先（同时给了 channel / env / 配置 activeChannel）",
		input: { flagWebhook: HOOK("test-flag"), channel: "opencode" },
		env: { FEISHU_NOTIFY_WEBHOOK: HOOK("test-env") },
		expect: { source: "flag", webhook: HOOK("test-flag") },
	},
	{
		name: "2. --channel 命中配置",
		input: { channel: "opencode" },
		env: { FEISHU_NOTIFY_WEBHOOK: HOOK("test-env") },
		expect: { source: "channel", channelName: "opencode", webhook: HOOK("test-opencode") },
	},
	{
		name: "3. flag 缺省时 env 优先于 activeChannel",
		input: {},
		env: { FEISHU_NOTIFY_WEBHOOK: HOOK("test-env") },
		expect: { source: "env", webhook: HOOK("test-env") },
	},
	{
		name: "4. 无 flag/channel/env 时回落 activeChannel",
		input: {},
		env: {},
		expect: { source: "activeChannel", channelName: "default", webhook: HOOK("test-default") },
	},
	{
		name: "5. env 为空串时视为未设置（不劫持 activeChannel）",
		input: {},
		env: { FEISHU_NOTIFY_WEBHOOK: "   " },
		expect: { source: "activeChannel", channelName: "default", webhook: HOOK("test-default") },
	},
	{
		name: "6. --channel 与配置 activeChannel 不同时，以显式 channel 为准",
		input: { channel: "opencode" },
		env: {},
		expect: { source: "channel", channelName: "opencode", webhook: HOOK("test-opencode") },
	},
];

describe("resolveWebhook 优先级矩阵（design §2）", () => {
	for (const testCase of PRIORITY_CASES) {
		it(testCase.name, () => {
			const result = resolveWebhook({
				...testCase.input,
				env: makeEnv(testCase.env),
				config: CONFIG, // 注入配置，避免依赖磁盘
			});
			assert.equal(result.source, testCase.expect.source);
			assert.equal(result.webhook, testCase.expect.webhook);
			if (testCase.expect.channelName !== undefined) assert.equal(result.channelName, testCase.expect.channelName);
		});
	}

	it("flag 路径完全不读配置文件（配置缺失也能用）", () => {
		const result = resolveWebhook({ flagWebhook: HOOK("test-flag"), env: makeEnv({ FEISHU_NOTIFY_CONFIG: MISSING_FILE }) });
		assert.equal(result.source, "flag");
		assert.equal(result.webhook, HOOK("test-flag"));
	});
});

// ---------------------------------------------------------------- 全缺 → 报错 + 引导语（AC2）

describe("全缺 → ConfigError exit 2 + 引导语，且不回退内置地址（AC2）", () => {
	const resolveEmpty = () => resolveWebhook({ env: makeEnv({ FEISHU_NOTIFY_CONFIG: MISSING_FILE }) });

	it("抛 ConfigError，exitCode 2", () => {
		assert.throws(resolveEmpty, (error) => {
			assert.ok(error instanceof ConfigError, `期望 ConfigError，实际 ${error?.name}`);
			assert.equal(error.exitCode, 2);
			assert.equal(error.reason, "missing-config");
			return true;
		});
	});

	it("stderr 文本含引导语（init），并指出配置路径", () => {
		const message = captureError(resolveEmpty);
		assert.match(message, /未配置飞书机器人 webhook/);
		assert.match(message, /npx feishu-notify-cli init/);
		assert.ok(message.includes(MISSING_FILE), "错误信息必须指出配置文件路径");
	});

	it("错误信息里没有任何内置地址（不回退）", () => {
		const message = captureError(resolveEmpty);
		assert.doesNotMatch(message, /https?:\/\//, "错误信息不得出现任何 URL（否则说明存在内置回退）");
	});

	it("配置存在但没有 activeChannel → 也是非零退出 + 引导语", () => {
		const config = { version: CONFIG_VERSION, channels: { default: { webhook: HOOK("test-default") } } };
		const error = captureErrorObject(() => resolveWebhook({ env: makeEnv({}), config }));
		assert.equal(error.exitCode, 2);
		assert.equal(error.reason, "no-active-channel");
		assert.match(error.message, /channel set-active/);
	});
});

// ---------------------------------------------------------------- 错误分支

describe("解析失败分支", () => {
	it("--channel 指向不存在的 channel → 报错并列出已有 channel", () => {
		const error = captureErrorObject(() => resolveWebhook({ channel: "nope", env: makeEnv({}), config: CONFIG }));
		assert.equal(error.exitCode, 2);
		assert.equal(error.reason, "channel-not-found");
		assert.match(error.message, /"nope"/);
		assert.match(error.message, /default, opencode/);
	});

	it("activeChannel 指向不存在的 channel → 报错", () => {
		const config = { ...CONFIG, activeChannel: "ghost" };
		const error = captureErrorObject(() => resolveWebhook({ env: makeEnv({}), config }));
		assert.equal(error.exitCode, 2);
		assert.match(error.message, /"ghost"/);
	});

	it("坏 JSON：报错、指出路径、**不自动覆盖**（字节不变）", () => {
		const file = join(TMP, "broken", "config.json");
		mkdirSync(dirname(file), { recursive: true });
		const brokenBytes = '{ "version": 1, "channels": { oops ';
		writeFileSync(file, brokenBytes, "utf8");

		const loaded = readConfig({ env: makeEnv({ FEISHU_NOTIFY_CONFIG: file }) });
		assert.equal(loaded.ok, false);
		assert.equal(loaded.reason, "invalid-json");
		assert.ok(loaded.message.includes("JSON"));

		const error = captureErrorObject(() => resolveWebhook({ env: makeEnv({ FEISHU_NOTIFY_CONFIG: file }) }));
		assert.equal(error.exitCode, 2);
		assert.ok(error.message.includes(file), "必须指出路径");
		assert.match(error.message, /未自动覆盖/);
		assert.equal(readFileSync(file, "utf8"), brokenBytes, "读取/解析不得改动文件内容");
	});

	it("结构非法（version 不支持 / channels 空 / webhook 非字符串）逐项报错", () => {
		const cases = [
			[{ channels: { a: { webhook: HOOK("test-a") } } }, /缺少 version/],
			[{ version: 99, channels: { a: { webhook: HOOK("test-a") } } }, /不支持的配置版本/],
			[{ version: CONFIG_VERSION, channels: {} }, /至少要有一个 channel/],
			[{ version: CONFIG_VERSION, channels: { a: {} } }, /webhook 必须是字符串/],
			[{ version: CONFIG_VERSION, channels: { a: { webhook: HOOK("test-a"), label: 7 } } }, /label 必须是字符串/],
			[{ version: CONFIG_VERSION, channels: { a: { webhook: HOOK("test-a") } }, activeChannel: "" }, /activeChannel/],
		];
		for (const [raw, pattern] of cases) {
			const shape = validateConfigShape(raw);
			assert.equal(shape.ok, false, `${JSON.stringify(raw)} 应被判为非法`);
			assert.match(shape.message, pattern);
		}
	});

	it("非 https 一律拒绝（flag / env / channel 三条来源）", () => {
		const httpHook = "http://open.feishu.cn/open-apis/bot/v2/hook/test-http";

		const fromFlag = captureErrorObject(() => resolveWebhook({ flagWebhook: httpHook, env: makeEnv({}) }));
		assert.equal(fromFlag.exitCode, 2);
		assert.match(fromFlag.message, /https/);

		const fromEnv = captureErrorObject(() => resolveWebhook({ env: makeEnv({ FEISHU_NOTIFY_WEBHOOK: httpHook }) }));
		assert.match(fromEnv.message, /https/);

		const config = { version: CONFIG_VERSION, activeChannel: "t", channels: { t: { webhook: httpHook } } };
		const fromChannel = captureErrorObject(() => resolveWebhook({ channel: "t", env: makeEnv({}), config }));
		assert.match(fromChannel.message, /https/);
	});

	it("非 https 错误信息里只出现掩码，不出现 token", () => {
		const error = captureErrorObject(() =>
			resolveWebhook({ flagWebhook: "http://open.feishu.cn/open-apis/bot/v2/hook/test-should-not-be-printed", env: makeEnv({}) }),
		);
		assert.doesNotMatch(error.message, /test-should-not-be-printed/);
		assert.match(error.message, /<REDACTED>/);
	});

	it("占位符 token 被拒绝（避免仓库里的占位符静默通过）", () => {
		for (const value of [HOOK("xxx"), HOOK("<PLACEHOLDER>"), HOOK("PLACEHOLDER"), HOOK("test")]) {
			assert.throws(
				() => resolveWebhook({ flagWebhook: value, env: makeEnv({}) }),
				(error) => error instanceof ConfigError,
				`${value} 应被拒绝`,
			);
		}
	});

	it("形状不对的 feishu 地址被拒绝；非 feishu 的 https 地址被接受", () => {
		assert.throws(() => resolveWebhook({ flagWebhook: "https://open.feishu.cn/hook/test-a", env: makeEnv({}) }), /形状/);
		const custom = resolveWebhook({ flagWebhook: "https://example.com/notify", env: makeEnv({}) });
		assert.equal(custom.webhook, "https://example.com/notify");
	});

	it("URL 形状非法（非 URL / 非 https 协议）被拒绝", () => {
		assert.throws(() => resolveWebhook({ flagWebhook: "not-a-url", env: makeEnv({}) }), /不是合法 URL/);
		assert.throws(() => resolveWebhook({ flagWebhook: "file:///etc/passwd", env: makeEnv({}) }), /协议必须是 https/);
		assert.throws(() => resolveWebhook({ flagWebhook: "   ", env: makeEnv({}) }), /值为空/);
	});
});

// ---------------------------------------------------------------- 配置路径

describe("配置路径解析", () => {
	it("FEISHU_NOTIFY_CONFIG 覆盖 > XDG_CONFIG_HOME > HOME/.config", () => {
		assert.equal(configPath({ env: makeEnv() }), CONFIG_FILE);
		assert.equal(
			configPath({ env: { HOME, XDG_CONFIG_HOME: XDG } }),
			join(XDG, "feishu-notify", "config.json"),
		);
		assert.equal(configPath({ env: { HOME } }), join(HOME, ".config", "feishu-notify", "config.json"));
	});

	it("FEISHU_NOTIFY_CONFIG 为相对路径时按 cwd 解析", () => {
		assert.equal(configPath({ env: { HOME, FEISHU_NOTIFY_CONFIG: "rel/config.json" } }), resolve(process.cwd(), "rel/config.json"));
	});

	it("空字符串覆盖视为未设置（回落默认路径）", () => {
		assert.equal(configPath({ env: { HOME, XDG_CONFIG_HOME: XDG, FEISHU_NOTIFY_CONFIG: "" } }), join(XDG, "feishu-notify", "config.json"));
	});

	it("readConfig 区分 missing / unreadable / invalid-json / invalid-shape", () => {
		assert.equal(readConfig({ env: makeEnv({ FEISHU_NOTIFY_CONFIG: MISSING_FILE }) }).reason, "missing");

		const dirAsFile = join(TMP, "a-directory");
		mkdirSync(dirAsFile, { recursive: true });
		const unreadable = readConfig({ env: makeEnv({ FEISHU_NOTIFY_CONFIG: dirAsFile }) });
		assert.equal(unreadable.reason, "unreadable");
		assert.match(unreadable.message, /目录/);

		const badShape = join(TMP, "bad-shape.json");
		writeJson(badShape, { version: 3, channels: {} });
		const shape = readConfig({ env: makeEnv({ FEISHU_NOTIFY_CONFIG: badShape }) });
		assert.equal(shape.reason, "invalid-shape");
		assert.match(shape.message, /不支持的配置版本/);
	});

	it("读合法配置：ok + 路径 + 内容", () => {
		const file = join(TMP, "good.json");
		writeJson(file, CONFIG);
		const loaded = readConfig({ env: makeEnv({ FEISHU_NOTIFY_CONFIG: file }) });
		assert.equal(loaded.ok, true);
		assert.equal(loaded.path, file);
		assert.deepEqual(loaded.config, CONFIG);
	});
});

// ---------------------------------------------------------------- 0600 权限（AC3 的前置）

describe("writeConfig：0600 / 0700 / 原子 / 不覆盖坏文件", () => {
	it("落盘权限 0600，目录 0700，无残留 temp 文件", () => {
		const file = join(TMP, "perm", "config.json");
		writeConfig(CONFIG, { path: file });

		assert.equal(statSync(file).mode & 0o777, 0o600);
		assert.equal(statSync(dirname(file)).mode & 0o777, 0o700);
		assert.deepEqual(readdirSync(dirname(file)), ["config.json"], "不得残留 .tmp- 文件");
		assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), CONFIG);
	});

	it("已存在且权限被放宽时，重写会把权限收回 0600", () => {
		const file = join(TMP, "perm2", "config.json");
		writeConfig(CONFIG, { path: file });
		chmodSync(file, 0o644);
		assert.equal(statSync(file).mode & 0o777, 0o644);
		writeConfig(CONFIG, { path: file });
		assert.equal(statSync(file).mode & 0o777, 0o600);
	});

	it("坏 JSON 已存在 → 拒绝覆盖（抛错 + 字节不变）；force 才允许", () => {
		const file = join(TMP, "perm3", "config.json");
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, "{ broken");

		const error = captureErrorObject(() => writeConfig(CONFIG, { path: file }));
		assert.equal(error.reason, "refuse-overwrite-invalid-json");
		assert.ok(error.message.includes(file));
		assert.equal(readFileSync(file, "utf8"), "{ broken");

		writeConfig(CONFIG, { path: file, force: true });
		assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), CONFIG);
	});

	it("拒绝覆盖符号链接与目录（filesystem-truth 契约）", () => {
		const target = join(TMP, "link-target.json");
		writeJson(target, CONFIG);
		const link = join(TMP, "link.json");
		symlinkSync(target, link);
		assert.ok(lstatSync(link).isSymbolicLink());
		assert.throws(() => writeConfig(CONFIG, { path: link }), /符号链接/);

		const dir = join(TMP, "dir-as-config");
		mkdirSync(dir, { recursive: true });
		assert.throws(() => writeConfig(CONFIG, { path: dir }), /目录/);
	});

	it("拒绝写入结构非法的配置（不会写出坏文件）", () => {
		const file = join(TMP, "perm4", "config.json");
		assert.throws(() => writeConfig({ version: CONFIG_VERSION, channels: {} }, { path: file }), /结构非法/);
		assert.equal(lstatSync(file, { throwIfNoEntry: false }), undefined);
	});
});

// ---------------------------------------------------------------- 掩码

describe("maskWebhook", () => {
	it("保留 scheme+host+父路径，token 部分打掉", () => {
		assert.equal(maskWebhook(HOOK("test-secret-token")), "https://open.feishu.cn/open-apis/bot/v2/hook/<REDACTED>");
		assert.equal(maskWebhook("https://example.com/notify"), "https://example.com/<REDACTED>");
		assert.equal(maskWebhook("https://example.com"), "https://example.com/<REDACTED>");
		assert.equal(maskWebhook("nonsense"), "<非 URL 值>");
		assert.equal(maskWebhook(""), "<空>");
	});
});

// ---------------------------------------------------------------- 隔离守卫（最后跑）

describe("隔离守卫：测试绝不碰真实配置目录", () => {
	it("所有读/写路径都落在临时根内，绝不指向真实 ~/.config", () => {
		for (const candidate of [TMP, HOME, XDG, CONFIG_FILE, MISSING_FILE]) {
			assert.ok(candidate.startsWith(TMP), `${candidate} 必须落在临时根内`);
		}
		const realConfigDir = join(process.env.HOME ?? "/nonexistent-home", ".config");
		assert.ok(!XDG.startsWith(realConfigDir), "XDG_CONFIG_HOME 不得指向真实 ~/.config");
		assert.ok(!dirname(CONFIG_FILE).startsWith(realConfigDir), "FEISHU_NOTIFY_CONFIG 不得指向真实 ~/.config");
	});
});

// ---------------------------------------------------------------- helpers

function captureErrorObject(fn) {
	try {
		fn();
	} catch (error) {
		return error;
	}
	throw new Error("期望抛错，但没有抛");
}

function captureError(fn) {
	return captureErrorObject(fn).message;
}
