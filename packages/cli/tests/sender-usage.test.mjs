/**
 * tests/sender-usage.test.mjs — 发送端参数解析：help / 未知参数 / `--` 转义口（G7）
 *
 * 背景（G7）：`feishu-notify --help` 以前落进 `*) MSG=` 分支，被当成正文**真的发到群里**
 * （2026-10-18 实测误发过一条正文为 "--help" 的消息）。未知 flag 同理。
 *
 * 本文件锁住修好之后的契约：
 *   - `-h` / `--help` → 用法打到 stdout，exit 0，**一个请求都不发**
 *   - 未知 `-flag`    → "未知参数 + 用法" 打到 stderr，exit 2，**一个请求都不发**
 *   - `--`            → 其后全部是正文（发送以 - 开头的文本的转义口）
 *   - 无参数          → 用法 + exit 1（与改前一致，只是文案收敛进 usage()）
 *   - 5 组黄金样例 payload 逐字节不变
 *
 * 用 tests/helpers/stub-curl.mjs 的假 curl 拦网络。"没有发出去"用 stub 调用次数 == 0 断言，
 * 这是本文件最重要的一类断言：只断言退出码会漏掉"报错之外还偷偷发了一条"这种情况。
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import { installStubCurl, readStubCalls, resetStubLog } from "./helpers/stub-curl.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SENDER = join(REPO_ROOT, "bin", "feishu-notify");
const CLI = join(REPO_ROOT, "bin", "feishu-notify-cli");
const FIXTURES = join(REPO_ROOT, "tests", "fixtures");

// 与 tests/capture-fixtures.sh 用同一个白名单样例地址（test-* 前缀，不是真实 token）
const FIXTURE_WEBHOOK = "https://open.feishu.cn/open-apis/bot/v2/hook/test-fixture-0001";

const TMP = mkdtempSync(join(tmpdir(), "feishu-notify-usage-"));
const HOME = join(TMP, "home");
const STUB_DIR = join(TMP, "stub-bin");
const STUB_LOG = join(TMP, "stub-log.jsonl");
const CONFIG = join(TMP, "cfg", "config.json");
const MISSING_CONFIG = join(TMP, "nope", "config.json");
const TITLE_FILE_INPUT = join(TMP, "title-file-input.txt");
mkdirSync(HOME, { recursive: true });

after(() => rmSync(TMP, { recursive: true, force: true }));

/** 挑一个本机存在的 UTF-8 locale（与 capture-fixtures.sh 同思路），避免 python3 解析 hook JSON 时按 ASCII 编码而丢内容 */
function pickUtf8Locale() {
	let available = "";
	try {
		available = execFileSync("locale", ["-a"], { encoding: "utf8" });
	} catch {
		/* locale 不可用就退回 C.UTF-8 */
	}
	const names = available.split("\n").map((line) => line.trim());
	for (const candidate of ["C.UTF-8", "en_US.UTF-8", "UTF-8", "en_US.utf8", "zh_CN.UTF-8"]) {
		if (names.includes(candidate)) return candidate;
	}
	return "C.UTF-8";
}

const UTF8_LOCALE = pickUtf8Locale();

before(() => {
	installStubCurl(STUB_DIR);
	mkdirSync(dirname(CONFIG), { recursive: true });
	writeFileSync(
		CONFIG,
		`${JSON.stringify(
			{ version: 1, activeChannel: "default", footer: "feishu-notify", channels: { default: { webhook: FIXTURE_WEBHOOK } } },
			null,
			2,
		)}\n`,
	);
	chmodSync(CONFIG, 0o600);
});

function envFor({ config = CONFIG, extra = {} } = {}) {
	const env = {
		...process.env,
		HOME,
		PATH: `${STUB_DIR}:${process.env.PATH}`,
		FEISHU_STUB_LOG: STUB_LOG,
	};
	for (const key of [
		"TERM_PROGRAM",
		"VSCODE_PID",
		"ELECTRON_RUN_AS_NODE",
		"CLAUDE_CODE_DESKTOP",
		"FEISHU_NOTIFY_WEBHOOK",
		"FEISHU_NOTIFY_CHANNEL",
		"FEISHU_NOTIFY_CLI",
	]) {
		delete env[key];
	}
	if (config === null) delete env.FEISHU_NOTIFY_CONFIG;
	else env.FEISHU_NOTIFY_CONFIG = config;
	env.FEISHU_NOTIFY_CLI = CLI;
	Object.assign(env, extra);
	for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
	return env;
}

function runSender(args, { env, input = "" } = {}) {
	return spawnSync("bash", [SENDER, ...args], { encoding: "utf8", input, env: env ?? envFor() });
}

const stubCallCount = () => readStubCalls(STUB_LOG).length;

describe("发送端：-h / --help 只打印用法，绝不外发（G7）", () => {
	for (const flag of ["--help", "-h"]) {
		it(`${flag} → exit 0 + stdout 含用法 + stub 一次都没被调用`, () => {
			resetStubLog(STUB_LOG);
			const result = runSender([flag]);
			assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
			assert.match(result.stdout, /用法:/, "用法必须打到 stdout");
			assert.match(result.stdout, /-h, --help/, "用法里要有新开关说明");
			assert.equal(result.stderr, "", "帮助不该往 stderr 写东西");
			assert.equal(stubCallCount(), 0, "帮助不得触发任何发送请求");
		});
	}

	it("--help 与其它 flag 同现也先退出（--text --help）", () => {
		resetStubLog(STUB_LOG);
		const result = runSender(["--text", "--help"]);
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.match(result.stdout, /用法:/);
		assert.equal(stubCallCount(), 0);
	});
});

describe("发送端：未知参数被拒绝，绝不落进正文（G7）", () => {
	it("--bogus → exit 2 + stderr 含“未知参数”与用法 + stub 一次都没被调用", () => {
		resetStubLog(STUB_LOG);
		const result = runSender(["--bogus"]);
		assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
		assert.match(result.stderr, /未知参数：--bogus/, "必须点名是哪个参数");
		assert.match(result.stderr, /用法:/, "必须给出用法");
		assert.equal(result.stdout, "", "错误信息不该混进 stdout");
		assert.equal(stubCallCount(), 0, "未知参数不得触发任何发送请求");
	});

	it("未知短参 -x 后面还跟着正常文本 → 依然 exit 2，绝不当成消息发出去", () => {
		resetStubLog(STUB_LOG);
		const result = runSender(["-x", "这是一条不该被发出去的消息"]);
		assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
		assert.match(result.stderr, /未知参数：-x/);
		assert.equal(stubCallCount(), 0);
	});

	it("未知参数先于 webhook 解析失败：缺配置也报“未知参数”而不是配置错误", () => {
		resetStubLog(STUB_LOG);
		const result = runSender(["--bogus"], { env: envFor({ config: MISSING_CONFIG }) });
		assert.equal(result.status, 2);
		assert.match(result.stderr, /未知参数：--bogus/);
		assert.equal(stubCallCount(), 0);
	});
});

describe("发送端：`--` 转义口（发送以 - 开头的文本）", () => {
	it("`-- --help` → 正文就是 --help，且真的发出去", () => {
		resetStubLog(STUB_LOG);
		const result = runSender(["--", "--help"]);
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.equal(stubCallCount(), 1, "转义口之后应当正常发送");
		const payload = JSON.parse(readFileSync(`${STUB_LOG}.payload`, "utf8"));
		assert.equal(payload.card.elements[0].content, "--help", "正文必须逐字是 --help");
	});

	it("`-- --text` → --text 是正文（卡片），不是纯文本模式", () => {
		resetStubLog(STUB_LOG);
		const result = runSender(["--", "--text"]);
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		const payload = JSON.parse(readFileSync(`${STUB_LOG}.payload`, "utf8"));
		assert.equal(payload.msg_type, "interactive", "-- 之后的 --text 必须被当作正文，而不是 flag");
		assert.equal(payload.card.elements[0].content, "--text");
	});
});

describe("发送端：无参数行为与改前一致（只是文案收敛进 usage()）", () => {
	it("无参数 → exit 1 + 用法打到 stdout + stub 一次都没被调用", () => {
		resetStubLog(STUB_LOG);
		const result = runSender([]);
		assert.equal(result.status, 1);
		assert.match(result.stdout, /用法:/);
		assert.match(result.stdout, /--channel name/);
		assert.match(result.stdout, /npx feishu-notify-cli init/);
		assert.equal(stubCallCount(), 0);
	});
});

describe("发送端：5 组黄金样例 payload 逐字节不变（G7 改动不得触碰发送路径）", () => {
	const normalizeTimestamp = (text) => text.replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/g, "<TIMESTAMP>");

	// 输入与 tests/capture-fixtures.sh 完全对齐（含引号/反斜杠/制表符/emoji 这类易漂移字节）
	writeFileSync(TITLE_FILE_INPUT, '第一行：含"双引号"、反斜杠 \\、制表\t符\n第二行：多行内容\n第三行：emoji ✅\n');

	const goldenEnv = envFor({
		extra: {
			FEISHU_NOTIFY_WEBHOOK: FIXTURE_WEBHOOK,
			PYTHONIOENCODING: "utf-8",
			LC_ALL: UTF8_LOCALE,
			LANG: UTF8_LOCALE,
		},
	});

	const CASES = [
		{ name: "idle", args: ["--idle"], input: '{"prompt":"等我决定"}' },
		{ name: "done", args: ["--done"], input: '{"last_assistant_message":"多行\\n内容"}' },
		{ name: "title-file", args: ["--title", "T", "--file", TITLE_FILE_INPUT], input: "" },
		{ name: "text", args: ["--text", "纯文本"], input: "" },
		{ name: "bare", args: ["裸文本消息"], input: "" },
	];

	for (const { name, args, input } of CASES) {
		it(`${name}: 重新捕获的 payload 与提交的 fixture 逐字节一致`, () => {
			resetStubLog(STUB_LOG);
			const result = runSender(args, { input, env: goldenEnv });
			assert.equal(result.status, 0, `${name}: ${result.stdout}\n${result.stderr}`);
			assert.equal(stubCallCount(), 1, `${name}: 应恰好发送一次`);
			const captured = normalizeTimestamp(readFileSync(`${STUB_LOG}.payload`, "utf8"));
			const committed = readFileSync(join(FIXTURES, `${name}.payload.json`), "utf8");
			assert.equal(captured, committed, `${name}: payload 发生漂移`);
		});
	}
});
