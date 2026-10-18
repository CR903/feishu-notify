/**
 * tests/footer.test.mjs — 卡片 footer 可配置 + 默认中性（prd R9 / AC7、implement.md 第 6–10 条）
 *
 * 隔离约定与 init.test.mjs 一致：HOME / XDG_CONFIG_HOME / FEISHU_NOTIFY_CONFIG 全在 mkdtemp 内，
 * 真实发卡被 PATH 前置的假 curl 拦住（不联网）。文件末尾有守卫断言：**绝不碰真实 ~/.config/feishu-notify**。
 *
 * 覆盖：
 *   - validateFooter / validateConfigShape：类型、≤40、禁止换行；空串是合法值（= 只显示时间戳）
 *   - resolveFooter：有配置取值 / 未配置回中性默认 / 空串原样 / 配置缺失或坏 → 抛（exit 2）
 *   - `footer` 子命令：stdout 只放字符串（含"空行"这一合法输出），source=… 走 stderr
 *   - `init --footer`：写入、合并时保留、覆盖、显式空串；非法 footer 在**发卡之前**就被拒
 *   - `channel list` / `doctor` 明文展示 footer
 *   - 发送端（bash）卡片 note：配置值 / 中性默认 / 空串 / JSON 转义 / 配置坏时回退中性默认
 *   - **外科手术式**：只换 footer 时，除 note 内容外 payload 逐字节相同（自带归一化比对，不依赖旧 fixture）
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import {
	DEFAULT_FOOTER,
	FOOTER_MAX_LENGTH,
	ConfigError,
	cloneConfig,
	resolveFooter,
	upsertChannel,
	validateConfigShape,
	validateFooter,
	writeConfig,
} from "../lib/config.mjs";
import { installStubCurl, readStubCalls, readStubPayload, resetStubLog } from "./helpers/stub-curl.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPO_ROOT, "bin", "feishu-notify-cli");
const SENDER = join(REPO_ROOT, "bin", "feishu-notify");

const TMP = mkdtempSync(join(tmpdir(), "feishu-notify-footer-"));
const HOME = join(TMP, "home");
const XDG = join(TMP, "xdg");
const STUB_DIR = join(TMP, "stub-bin");
const STUB_LOG = join(TMP, "stub-log.jsonl");
const DEFAULT_CONFIG = join(TMP, "cfg-default", "config.json");

mkdirSync(HOME, { recursive: true });
mkdirSync(XDG, { recursive: true });
mkdirSync(dirname(DEFAULT_CONFIG), { recursive: true });

after(() => rmSync(TMP, { recursive: true, force: true }));

before(() => installStubCurl(STUB_DIR));

const HOOK = (token) => `https://open.feishu.cn/open-apis/bot/v2/hook/${token}`;
const A = HOOK("test-footer-a");
const B = HOOK("test-footer-b");
// 发送端先读 stdin 再读 --file，所以这里必须用**真实文件**（/dev/stdin 已被 cat - 读空）
const BODY = join(TMP, "body.txt");
writeFileSync(BODY, "同一份正文\n");

let counter = 0;
const tmpConfig = (label) => join(TMP, `case-${++counter}-${label}`, "config.json");

/** 发卡片用例统一用的"不会撞上的"发送超时；见 envFor 的说明（产品默认值不受影响） */
const TEST_TIMEOUT_MS = "120000";

/** 写一个只含一个 channel 的配置（writeConfig 会顺手断言 0600 这条路是真的在走） */
function seedConfig(path, { footer, webhook = A, channel = "default" } = {}) {
	const config = { version: 1, activeChannel: channel, channels: { [channel]: { webhook } } };
	if (footer !== undefined) config.footer = footer;
	writeConfig(config, { path });
	return path;
}

function envFor({ config = DEFAULT_CONFIG, extra = {} } = {}) {
	const env = { ...process.env, HOME, XDG_CONFIG_HOME: XDG, PATH: `${STUB_DIR}:${process.env.PATH}`, FEISHU_STUB_LOG: STUB_LOG };
	for (const key of ["FEISHU_NOTIFY_WEBHOOK", "FEISHU_NOTIFY_CHANNEL", "FEISHU_NOTIFY_CURL", "FEISHU_NOTIFY_TIMEOUT_MS"]) delete env[key];
	// 与 init.test.mjs 同一约定：这里发卡片是为了断言**卡片内容/退出码**，不该顺带断言"机器 15s 内跑得完"。
	// 发送超时本身由 tests/timeout.test.mjs 的确定性用例覆盖。
	env.FEISHU_NOTIFY_TIMEOUT_MS = TEST_TIMEOUT_MS;
	if (config === null) delete env.FEISHU_NOTIFY_CONFIG;
	else env.FEISHU_NOTIFY_CONFIG = config;
	Object.assign(env, extra);
	for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
	return env;
}

const runCli = (args, options = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: envFor(options), input: options.input });

function runSender(args, { config, extra = {}, input = "" } = {}) {
	return spawnSync("bash", [SENDER, ...args], {
		encoding: "utf8",
		input,
		env: envFor({ config, extra: { FEISHU_NOTIFY_CLI: CLI, FEISHU_NOTIFY_NODE: process.execPath, ...extra } }),
	});
}

const resetLog = () => resetStubLog(STUB_LOG);

/** 从最近一次 stub 收到的 payload 里取卡片 note 文本 */
function lastNote() {
	const payload = JSON.parse(readStubPayload(STUB_LOG));
	const note = payload.card.elements.find((element) => element.tag === "note");
	return note.elements[0].content;
}

/** 归一化 note 内容，用于"除 note 之外逐字节相同"的外科手术式比对 */
const NOTE_RE = /("tag":"note","elements":\[\{"tag":"plain_text","content":")[^"]*(")/;
const normalizeNote = (payload) => {
	assert.match(payload, NOTE_RE, "payload 里应能找到 note 元素");
	return payload.replace(NOTE_RE, "$1<NOTE-CONTENT>$2");
};

// ---------------------------------------------------------------- 取值校验

describe("footer 取值校验", () => {
	it("合法值：普通文本与空串（空串 = 只显示时间戳）", () => {
		assert.equal(validateFooter("Smarterlab"), "Smarterlab");
		assert.equal(validateFooter(""), "");
		assert.equal(validateFooter("x".repeat(FOOTER_MAX_LENGTH)).length, FOOTER_MAX_LENGTH);
	});

	it("非法值：超长 / 含换行 / 非字符串 一律拒绝", () => {
		assert.throws(() => validateFooter("x".repeat(FOOTER_MAX_LENGTH + 1)), /过长/);
		assert.throws(() => validateFooter("a\nb"), /换行/);
		assert.throws(() => validateFooter("a\rb"), /换行/);
		assert.throws(() => validateFooter(123), /必须是字符串/);
		assert.throws(() => validateFooter(null), /必须是字符串/);
	});

	it("配置结构：footer 是可选的字符串；类型不对才判非法（长度/换行留给使用点）", () => {
		const base = { version: 1, channels: { default: { webhook: A } } };
		assert.equal(validateConfigShape({ ...base, footer: "Smarterlab" }).ok, true);
		assert.equal(validateConfigShape({ ...base, footer: "" }).ok, true);
		assert.equal(validateConfigShape(base).ok, true, "footer 可以整个不出现");
		assert.equal(validateConfigShape({ ...base, footer: 123 }).ok, false);
		// 长度超限**不**让整个配置失效 —— 否则一个装饰字段会把 webhook 解析一起弄挂
		assert.equal(validateConfigShape({ ...base, footer: "x".repeat(200) }).ok, true);
	});

	it("cloneConfig 保留 footer（channel 增删改都不会把它弄丢）", () => {
		const config = { version: 1, activeChannel: "default", footer: "Smarterlab", channels: { default: { webhook: A } } };
		assert.equal(cloneConfig(config).footer, "Smarterlab");
		const added = upsertChannel(config, "opencode", { webhook: B }, { force: true });
		assert.equal(added.footer, "Smarterlab");
		assert.equal(config.footer, "Smarterlab", "不得改动入参");
	});
});

describe("resolveFooter", () => {
	const env = { HOME, XDG_CONFIG_HOME: XDG, FEISHU_NOTIFY_CONFIG: "unused" };

	it("配置里有 footer → 原样返回（source=config）；空串也原样返回", () => {
		assert.deepEqual(resolveFooter({ env, config: { version: 1, footer: "Smarterlab", channels: {} } }).footer, "Smarterlab");
		const empty = resolveFooter({ env, config: { version: 1, footer: "", channels: {} } });
		assert.equal(empty.footer, "");
		assert.equal(empty.source, "config");
	});

	it("未配置 footer → 中性默认", () => {
		const result = resolveFooter({ env, config: { version: 1, channels: {} } });
		assert.equal(result.footer, DEFAULT_FOOTER);
		assert.equal(result.footerSource ?? result.source, "default");
	});

	it("配置缺失 / 坏 JSON → 抛 ConfigError（发送端据此回退中性默认）", () => {
		const missing = join(TMP, "nope", "config.json");
		assert.throws(() => resolveFooter({ env, configFilePath: missing }), (error) => error instanceof ConfigError && error.exitCode === 2);

		const broken = tmpConfig("broken-footer");
		mkdirSync(dirname(broken), { recursive: true });
		writeFileSync(broken, "{ not json");
		assert.throws(() => resolveFooter({ env, configFilePath: broken }), ConfigError);
	});
});

// ---------------------------------------------------------------- CLI：footer 子命令

describe("feishu-notify-cli footer", () => {
	it("配置里写了值 → stdout 只有该值，exit 0，source=config 走 stderr", () => {
		const config = seedConfig(tmpConfig("footer-cmd"), { footer: "Smarterlab" });
		const result = runCli(["footer"], { config });
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout, "Smarterlab\n");
		assert.equal(result.stderr.trim(), `source=config config=${config}`);
	});

	it("没写 footer → 中性默认，source=default", () => {
		const config = seedConfig(tmpConfig("footer-default"));
		const result = runCli(["footer"], { config });
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout, `${DEFAULT_FOOTER}\n`);
		assert.match(result.stderr, /source=default/);
	});

	it("显式空串 → stdout 是一行空（含义：只显示时间戳），exit 0", () => {
		const config = seedConfig(tmpConfig("footer-empty"), { footer: "" });
		const result = runCli(["footer"], { config });
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout, "\n");
		assert.match(result.stderr, /source=config/);
	});

	it("配置缺失 → exit 2，stdout 为空（发送端看到非 0 就回退中性默认）", () => {
		const result = runCli(["footer"], { config: join(TMP, "nope", "config.json") });
		assert.equal(result.status, 2);
		assert.equal(result.stdout, "");
		assert.match(result.stderr, /未配置飞书机器人 webhook/);
	});

	it("--json 结构化输出；footer 明文可见（它不是密钥）", () => {
		const config = seedConfig(tmpConfig("footer-json"), { footer: "Smarterlab" });
		const result = runCli(["footer", "--json"], { config });
		const parsed = JSON.parse(result.stdout);
		assert.equal(parsed.footer, "Smarterlab");
		assert.equal(parsed.source, "config");
		assert.equal(parsed.default, DEFAULT_FOOTER);
		assert.equal(parsed.maxLength, FOOTER_MAX_LENGTH);
	});
});

// ---------------------------------------------------------------- init --footer

describe("init --footer", () => {
	it("写入 footer 并落盘 0600", () => {
		const config = tmpConfig("init-footer");
		resetLog();
		const result = runCli(["init", "--non-interactive", "--webhook", A, "--channel", "default", "--footer", "Smarterlab"], { config });
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.equal(JSON.parse(readFileSync(config, "utf8")).footer, "Smarterlab");
		assert.equal(statSync(config).mode & 0o777, 0o600);
		assert.match(result.stdout, /footer：Smarterlab/);
		assert.equal(readStubCalls(STUB_LOG).length, 1);
	});

	it("再次 init 不带 --footer 时保留原值；带了就覆盖", () => {
		const config = tmpConfig("init-footer-merge");
		runCli(["init", "--non-interactive", "--webhook", A, "--channel", "default", "--footer", "Smarterlab", "--no-verify"], { config });
		runCli(["init", "--non-interactive", "--webhook", B, "--channel", "opencode", "--no-verify"], { config });
		assert.equal(JSON.parse(readFileSync(config, "utf8")).footer, "Smarterlab", "合并时必须保留既有 footer");

		runCli(["init", "--non-interactive", "--webhook", B, "--channel", "opencode", "--footer", "Team", "--no-verify"], { config });
		assert.equal(JSON.parse(readFileSync(config, "utf8")).footer, "Team");
	});

	it("--footer '' 写入空串（只显示时间戳）", () => {
		const config = tmpConfig("init-footer-empty");
		const result = runCli(["init", "--non-interactive", "--webhook", A, "--channel", "default", "--footer", "", "--no-verify"], { config });
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.equal(JSON.parse(readFileSync(config, "utf8")).footer, "");
		assert.match(result.stdout, /footer：<空>/);
	});

	it("非法 --footer（超长）在**发卡之前**就被拒：不发卡、不落盘", () => {
		const config = tmpConfig("init-footer-bad");
		resetLog();
		const result = runCli(["init", "--non-interactive", "--webhook", A, "--channel", "default", "--footer", "x".repeat(FOOTER_MAX_LENGTH + 1)], { config });
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /过长/);
		assert.equal(readStubCalls(STUB_LOG).length, 0, "非法 footer 不该先浪费一张测试卡片");
		assert.equal(lstatSync(config, { throwIfNoEntry: false }), undefined, "不得落盘");
	});
});

// ---------------------------------------------------------------- 展示

describe("channel list / doctor 明文展示 footer", () => {
	it("channel list 与 --json 都带上 footer", () => {
		const config = seedConfig(tmpConfig("list-footer"), { footer: "Smarterlab" });
		const human = runCli(["channel", "list"], { config });
		assert.equal(human.status, 0, human.stderr);
		assert.match(human.stdout, /footer：Smarterlab（source=config）/);

		const json = JSON.parse(runCli(["channel", "list", "--json"], { config }).stdout);
		assert.equal(json.footer, "Smarterlab");
		assert.equal(json.footerSource, "config");
	});

	it("doctor 与 --json 都带上 footer（未配置时显示中性默认）", () => {
		const config = seedConfig(tmpConfig("doctor-footer"));
		resetLog();
		const human = runCli(["doctor"], { config });
		assert.equal(human.status, 0, `${human.stdout}\n${human.stderr}`);
		assert.match(human.stdout, new RegExp(`footer：${DEFAULT_FOOTER}（source=default）`));
		assert.equal(readStubCalls(STUB_LOG).length, 1);

		const json = JSON.parse(runCli(["doctor", "--json"], { config }).stdout);
		assert.equal(json.footer, DEFAULT_FOOTER);
		assert.equal(json.footerSource, "default");
	});
});

// ---------------------------------------------------------------- 发送端

describe("发送端卡片 footer（bash）", () => {
	it("配置了 footer → note 为 `<footer> · <时间戳>`", () => {
		const config = seedConfig(tmpConfig("sender-footer"), { footer: "Smarterlab" });
		resetLog();
		const result = runSender(["--title", "T", "--file", BODY], { config });
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.match(lastNote(), /^Smarterlab · \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
	});

	it("未配置 footer → note 为中性默认 `feishu-notify · <时间戳>`", () => {
		const config = seedConfig(tmpConfig("sender-default"));
		resetLog();
		assert.equal(runSender(["--title", "T", "正文"], { config }).status, 0);
		assert.match(lastNote(), /^feishu-notify · \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
	});

	it("footer 为空串 → note 只剩时间戳", () => {
		const config = seedConfig(tmpConfig("sender-empty"), { footer: "" });
		resetLog();
		assert.equal(runSender(["--title", "T", "正文"], { config }).status, 0);
		assert.match(lastNote(), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
	});

	it("footer 里的引号被正确转义（payload 仍是合法 JSON）", () => {
		const config = seedConfig(tmpConfig("sender-escape"), { footer: 'He said "hi"' });
		resetLog();
		assert.equal(runSender(["--title", "T", "正文"], { config }).status, 0);
		assert.match(lastNote(), /^He said "hi" · /);
	});

	it("配置坏但用 --webhook 指定地址时：回退中性默认继续发，退出码不变", () => {
		const broken = tmpConfig("sender-broken-config");
		mkdirSync(dirname(broken), { recursive: true });
		writeFileSync(broken, "{ not json", { mode: 0o600 });
		resetLog();
		const result = runSender(["--webhook", A, "--text", "hi"], { config: broken });
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`); // 退出码矩阵不受 footer 影响

		// text 模式没有 note 元素，这里换成卡片模式再验一次回退
		resetLog();
		const card = runSender(["--webhook", A, "--title", "T", "正文"], { config: broken });
		assert.equal(card.status, 0, `${card.stdout}\n${card.stderr}`);
		assert.match(lastNote(), /^feishu-notify · /, "footer 解析失败必须回退到中性默认");
		assert.ok(!card.stderr.includes("配置不可用"), "footer 的报错应被发送端吞掉（尽力而为，不污染 stderr）");
	});

	it("外科手术式：只换 footer 时，除 note 内容外 payload 逐字节相同", () => {
		const withA = seedConfig(tmpConfig("surgical-a"), { footer: "Smarterlab" });
		const withB = seedConfig(tmpConfig("surgical-b"), { footer: "feishu-notify" });

		resetLog();
		assert.equal(runSender(["--title", "T", "--file", BODY], { config: withA }).status, 0);
		const payloadA = readStubPayload(STUB_LOG);
		resetLog();
		assert.equal(runSender(["--title", "T", "--file", BODY], { config: withB }).status, 0);
		const payloadB = readStubPayload(STUB_LOG);

		assert.notEqual(payloadA, payloadB, "footer 不同，原始 payload 本就该不同");
		assert.equal(normalizeNote(payloadA), normalizeNote(payloadB), "归一化 note 之后必须逐字节相同 —— 改动只能是那一处");
	});
});

// ---------------------------------------------------------------- 自检卡片预览真实 footer

describe("自检卡片带上当前生效的 footer（init / doctor）", () => {
	it("doctor：测试卡片的 note 就是配置里的 footer —— 用户能一眼看出自己配的生效了没", () => {
		const config = seedConfig(tmpConfig("card-doctor-footer"), { footer: "Smarterlab" });
		resetLog();
		const result = runCli(["doctor"], { config });

		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.match(lastNote(), /^Smarterlab · \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, "自检卡片必须长得和真实通知一样");
		assert.match(result.stdout, /footer：Smarterlab/);
	});

	it("doctor：未配置 footer → 卡片是中性的（与真实通知一致）", () => {
		const config = seedConfig(tmpConfig("card-doctor-default"));
		resetLog();
		assert.equal(runCli(["doctor"], { config }).status, 0);
		assert.match(lastNote(), new RegExp(`^${DEFAULT_FOOTER} · `));
	});

	it("doctor：footer 是空串 → 卡片 note 只剩时间戳", () => {
		const config = seedConfig(tmpConfig("card-doctor-empty"), { footer: "" });
		resetLog();
		assert.equal(runCli(["doctor"], { config }).status, 0);
		assert.match(lastNote(), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
	});

	it("doctor：手改成长度违规的 footer → 卡片回退中性默认，doctor 本身照常成功", () => {
		const config = seedConfig(tmpConfig("card-doctor-broken"), { footer: "x".repeat(FOOTER_MAX_LENGTH + 1) });
		resetLog();
		const result = runCli(["doctor"], { config });

		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.match(lastNote(), new RegExp(`^${DEFAULT_FOOTER} · `), "装饰字段坏了不该让自检卡发不出去");
	});

	it("init：验证卡片带上 --footer 的值（发卡与落盘用的是同一份 footer）", () => {
		const config = tmpConfig("card-init-footer");
		resetLog();
		const result = runCli(["init", "--non-interactive", "--webhook", A, "--channel", "default", "--footer", "Acme"], { config });

		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.match(lastNote(), /^Acme · /);
		assert.equal(JSON.parse(readFileSync(config, "utf8")).footer, "Acme");
	});

	it("init：再次 init 不带 --footer → 沿用原值，卡片也用原值（不静默漂移回中性默认）", () => {
		const config = seedConfig(tmpConfig("card-init-keep"), { footer: "Kept" });
		resetLog();
		const result = runCli(["init", "--non-interactive", "--webhook", B, "--channel", "default"], { config });

		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.match(lastNote(), /^Kept · /);
		assert.equal(JSON.parse(readFileSync(config, "utf8")).footer, "Kept");
	});

	it("init --footer \"\" → 卡片只剩时间戳（与发送端同一语义）", () => {
		const config = tmpConfig("card-init-empty");
		resetLog();
		const result = runCli(["init", "--non-interactive", "--webhook", A, "--channel", "default", "--footer", ""], { config });

		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.match(lastNote(), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
	});
});

// ---------------------------------------------------------------- 隔离守卫

describe("隔离守卫", () => {
	it("所有路径都在临时根内，真实 ~/.config/feishu-notify 未被触碰", () => {
		for (const path of [HOME, XDG, STUB_DIR, DEFAULT_CONFIG]) assert.ok(path.startsWith(TMP));
		const realDir = join(process.env.HOME ?? "/nonexistent", ".config", "feishu-notify");
		assert.ok(!TMP.startsWith(realDir));
	});
});
