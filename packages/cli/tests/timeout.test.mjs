/**
 * tests/timeout.test.mjs — 发送超时：唯一一条墙钟依赖的**确定性**测试
 *
 * ## 为什么单独一个文件
 *
 * 2026-10-18 测试抖动事故：连跑 5 遍根目录 `npm test`，第 4 遍 `wiring.test.mjs` 的
 * doctor 用例（悬空符号链接）`duration_ms: 15628`，断言 `strictEqual(result.status, 0)` 实际拿到 1。
 *
 * 根因（已复现，不是猜的）：doctor 会**逐 channel 真实发测试卡片**，而 `sendPayload` 给 curl
 * 子进程设了 15s 的 `spawnSync` 超时。这是整条路径上**唯一**的墙钟依赖 —— 机器一忙
 * （多测试文件并行、每个文件又大量 spawn 子进程），stub curl 从 spawn 到退出就被拖过了 15s
 * → doctor 把该 channel 判成「不通」→ 退出码 1 → 「接线诊断」的断言无理由变红。
 *
 * 复现手法（改动前实测）：让 stub curl 睡 20s、用默认超时跑 doctor →
 * `exit 1` + `✗ default 发送超时（15000ms 内没有响应，已中止）` + wall ≈ 15.25s。
 * 现场报告的 15628ms ≈ 15.25s + 该子测试自身开销，吻合。
 * （附带实测：本机事故当时 load average 12～20，一次 shell 替身的 spawn→退出周转被拖到 1.3～2.4s，
 *  即"轻量子进程也要 1s 量级"，这正是一条 15s 超时会偶发撞上的量级。）
 *
 * 于是修法分两半，**缺一不可**：
 *   1. 超时**可注入**（lib/sender.mjs 的 `FEISHU_NOTIFY_TIMEOUT_MS`，带范围钳制）；
 *      接线诊断类测试（wiring / init / footer）据此把超时调到很大 —— 它们验证的是诊断，
 *      不是超时行为，不该顺带断言「这台机器 15s 内跑得完一次 curl」。
 *   2. 超时**行为本身**由本文件钉死（把超时调大 ≠ 修好抖动，那是把一段覆盖删掉）。
 *
 * ## 本文件的用例为什么不抖
 *
 *   - 单元：`spawn` 注入，直接读 `sendPayload` 传给 spawn 的 `timeout` 选项，零真实等待；
 *   - 端到端：curl 用**绝对路径**钉在替身上（`FEISHU_NOTIFY_CURL`），"跑的是哪个 curl"
 *     不靠 PATH 运气，真实 curl 没有出现的机会；
 *   - 端到端：**同一套接线、同一个替身、同一段 300ms 的慢**，只改超时这一个变量跑两次 ——
 *     放宽就通、收紧就判不通，把"超时是唯一变量"钉死（而不是断言"替身一定能在 50ms 内被调度起来"，
 *     那本身就是新的墙钟依赖）。
 *
 * 不发外网：curl 一律是 PATH 前置/绝对路径指向的替身（tests/helpers/stub-curl.mjs）。
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import { DEFAULT_CURL_TIMEOUT_MS, MAX_CURL_TIMEOUT_MS, MIN_CURL_TIMEOUT_MS, TIMEOUT_ENV, resolveTimeoutMs, sendPayload } from "../lib/sender.mjs";
import { STUB_SLEEP_ENV, installStubCurl, readStubCalls, readStubPayload, resetStubLog } from "./helpers/stub-curl.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPO_ROOT, "bin", "feishu-notify-cli");

const TMP = mkdtempSync(join(tmpdir(), "feishu-notify-timeout-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

const STUB_DIR = join(TMP, "stub-bin");
const STUB_LOG = join(TMP, "stub-log.jsonl");
const HOOK = (token) => `https://open.feishu.cn/open-apis/bot/v2/hook/${token}`;
const WEBHOOK = HOOK("test-timeout");

/** 端到端场景：替身 curl 睡 300ms；对照组把超时压到 50ms（差 6 倍），控制组放宽到 120s */
const SLEEP_SEC = "0.3";
const SLEEP_MS = 300;
const TIMEOUT_50MS = "50";
const TIMEOUT_GENEROUS = "120000";

let STUB_CURL = null;
before(() => {
	STUB_CURL = installStubCurl(STUB_DIR);
	/**
	 * doctor 的接线自检会去 PATH 上找 node 并跑一次它（`node --version`）。那是**另一个**
	 * 子进程，本文件并不需要真实的 node —— 用一个纯 shell 假 node 顶上，省掉一次真 node 启动，
	 * 让"超时用例很快"这件事不被无关开销拖累（版本号只要满足 ≥ NODE_MIN_MAJOR）。
	 */
	const stubNode = join(STUB_DIR, "node");
	writeFileSync(stubNode, "#!/bin/sh\nprintf 'v22.0.0\\n'\n", { mode: 0o755 });
});

/**
 * 与 wiring.test.mjs 的 doctor 场景同构：
 *   runner/feishu-notify-cli → 指向仓库 CLI（doctor 本体从这里跑）
 *   FEISHU_NOTIFY_CURL       → 替身的**绝对路径**（"跑的是哪个 curl"不靠 PATH 运气）
 *   PATH                     → 替身目录 + 系统目录（真实 curl 不在 PATH 上，也不在任何候选里）
 */
function doctorFixture(label, { timeoutEnv = TIMEOUT_50MS, sleepSec = SLEEP_SEC, withConfig = true } = {}) {
	const root = join(TMP, label);
	const home = join(root, "home");
	const xdg = join(root, "xdg");
	const runnerDir = join(root, "runner");
	for (const dir of [home, xdg, runnerDir]) mkdirSync(dir, { recursive: true });
	symlinkSync(CLI, join(runnerDir, "feishu-notify-cli"));

	const config = join(root, "config.json");
	if (withConfig) writeFileSync(config, `${JSON.stringify({ version: 1, activeChannel: "default", channels: { default: { webhook: WEBHOOK } } }, null, 2)}\n`, { mode: 0o600 });

	const env = {
		...process.env,
		HOME: home,
		XDG_CONFIG_HOME: xdg,
		PATH: `${STUB_DIR}:/bin:/usr/bin:/usr/sbin:/sbin`,
		FEISHU_NOTIFY_CONFIG: config,
		FEISHU_NOTIFY_CURL: STUB_CURL,
		FEISHU_STUB_LOG: STUB_LOG,
		[STUB_SLEEP_ENV]: sleepSec,
		[TIMEOUT_ENV]: timeoutEnv,
		FEISHU_NOTIFY_CLI: undefined,
		FEISHU_NOTIFY_NODE: undefined,
		FEISHU_NOTIFY_WEBHOOK: undefined,
	};
	// 与 init / footer 的 envFor 同一约定：真实环境里的覆盖项一律清掉，测试自己决定
	for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];

	return { config, runner: join(runnerDir, "feishu-notify-cli"), env };
}

const runCli = (fixture, args) => spawnSync(process.execPath, [fixture.runner, ...args], { encoding: "utf8", env: fixture.env });
const jsonOf = (result) => JSON.parse(result.stdout);

// ---------------------------------------------------------------- 单元：默认值与钳制

describe("resolveTimeoutMs：默认行为不变，越界钳制（不联网、零等待）", () => {
	it("未设置 / 空串 / 非数字 → 默认 15s（产品行为不变）", () => {
		assert.equal(resolveTimeoutMs({}), DEFAULT_CURL_TIMEOUT_MS);
		assert.equal(resolveTimeoutMs({ [TIMEOUT_ENV]: "" }), DEFAULT_CURL_TIMEOUT_MS);
		assert.equal(resolveTimeoutMs({ [TIMEOUT_ENV]: "   " }), DEFAULT_CURL_TIMEOUT_MS);
		assert.equal(resolveTimeoutMs({ [TIMEOUT_ENV]: undefined }), DEFAULT_CURL_TIMEOUT_MS);
		assert.equal(resolveTimeoutMs({ [TIMEOUT_ENV]: "abc" }), DEFAULT_CURL_TIMEOUT_MS, "坏值不该把卡片拦住，回退默认");
		assert.equal(resolveTimeoutMs({ [TIMEOUT_ENV]: "NaN" }), DEFAULT_CURL_TIMEOUT_MS);
		assert.equal(resolveTimeoutMs({ [TIMEOUT_ENV]: "Infinity" }), DEFAULT_CURL_TIMEOUT_MS);
		assert.equal(resolveTimeoutMs(undefined), DEFAULT_CURL_TIMEOUT_MS, "env 整个没传也要能算");
	});

	it("范围之内原样采用（小数取整、两侧空白容忍）", () => {
		assert.equal(resolveTimeoutMs({ [TIMEOUT_ENV]: "50" }), 50);
		assert.equal(resolveTimeoutMs({ [TIMEOUT_ENV]: " 120000 " }), 120_000);
		assert.equal(resolveTimeoutMs({ [TIMEOUT_ENV]: "5000.7" }), 5000);
		assert.equal(resolveTimeoutMs({ [TIMEOUT_ENV]: String(MIN_CURL_TIMEOUT_MS) }), MIN_CURL_TIMEOUT_MS);
		assert.equal(resolveTimeoutMs({ [TIMEOUT_ENV]: String(MAX_CURL_TIMEOUT_MS) }), MAX_CURL_TIMEOUT_MS);
	});

	it("越界钳到边界：0 与负数 → 下限；荒谬大值 → 上限", () => {
		assert.equal(resolveTimeoutMs({ [TIMEOUT_ENV]: "0" }), MIN_CURL_TIMEOUT_MS);
		assert.equal(resolveTimeoutMs({ [TIMEOUT_ENV]: "-1" }), MIN_CURL_TIMEOUT_MS);
		assert.equal(resolveTimeoutMs({ [TIMEOUT_ENV]: "-999999" }), MIN_CURL_TIMEOUT_MS);
		assert.equal(resolveTimeoutMs({ [TIMEOUT_ENV]: "5" }), MIN_CURL_TIMEOUT_MS);
		assert.equal(resolveTimeoutMs({ [TIMEOUT_ENV]: "999999999" }), MAX_CURL_TIMEOUT_MS);
		assert.ok(MIN_CURL_TIMEOUT_MS > 0, "下限必须 > 0：spawnSync 的 timeout=0 语义是「不超时」");
		assert.ok(MAX_CURL_TIMEOUT_MS >= DEFAULT_CURL_TIMEOUT_MS, "上限不得低于默认值，否则默认值本身就被钳了");
	});
});

// ---------------------------------------------------------------- 单元：生效值真的交给了 spawn

describe("sendPayload：生效的超时确实传给了 curl 子进程（spawn 注入）", () => {
	/** 捕获 spawn 收到的选项，直接返回成功应答 —— 零真实等待 */
	function capture() {
		const seen = [];
		const spawn = (curl, args, opts) => {
			seen.push({ curl, args, timeout: opts.timeout });
			return { stdout: '{"code":0,"msg":"success"}\n200', stderr: "", status: 0 };
		};
		return { seen, spawn };
	}

	it("缺省 → 取 env（未设置即 15s，设置即该值）；显式 timeoutMs 优先", () => {
		const a = capture();
		sendPayload({ webhook: WEBHOOK, payload: "{}", spawn: a.spawn, env: {} });
		assert.equal(a.seen[0].timeout, DEFAULT_CURL_TIMEOUT_MS);

		const b = capture();
		sendPayload({ webhook: WEBHOOK, payload: "{}", spawn: b.spawn, env: { [TIMEOUT_ENV]: "42000" } });
		assert.equal(b.seen[0].timeout, 42_000, "env 要能从调用方传进来的那份 env 读到（doctor / init 传的是 baseEnv）");

		const c = capture();
		sendPayload({ webhook: WEBHOOK, payload: "{}", spawn: c.spawn, env: { [TIMEOUT_ENV]: "0" }, timeoutMs: 1234 });
		assert.equal(c.seen[0].timeout, 1234, "显式值优先（钳制只作用于 env 那条路）");
	});

	it("超时分支：文案带上**实际生效**的毫秒数；非超时的 spawn 失败不许串台", () => {
		const timedOut = sendPayload({
			webhook: WEBHOOK,
			payload: "{}",
			env: { [TIMEOUT_ENV]: "77" },
			spawn: () => ({ error: { code: "ETIMEDOUT", message: "spawnSync curl ETIMEDOUT" }, signal: "SIGTERM", status: null }),
		});
		assert.equal(timedOut.ok, false);
		assert.equal(timedOut.httpCode, 0);
		assert.match(timedOut.message, /发送超时/);
		assert.match(timedOut.message, /77ms/, `文案要报生效值：${timedOut.message}`);
		assert.match(timedOut.message, /信号 SIGTERM/, `超时文案要带终止信号名：${timedOut.message}`);

		const denied = sendPayload({ webhook: WEBHOOK, payload: "{}", spawn: () => ({ error: { code: "EACCES", message: "spawnSync curl EACCES" } }) });
		assert.equal(denied.ok, false);
		assert.match(denied.message, /调用 curl 失败/);
		assert.doesNotMatch(denied.message, /发送超时/, "别的 spawn 失败不得被算成超时");
	});

	it("G5：只有 signal、**没有 error 字段**（子进程自杀/被 kill）→ 也走超时分支，不是「没有拿到 HTTP 状态码」", () => {
		const killed = sendPayload({
			webhook: WEBHOOK,
			payload: "{}",
			env: { [TIMEOUT_ENV]: "88" },
			// 关键：没有 error，只有 signal —— 旧写法会掉进 httpCode===0 分支
			spawn: () => ({ status: null, signal: "SIGKILL", stdout: "", stderr: "" }),
		});
		assert.equal(killed.ok, false);
		assert.equal(killed.httpCode, 0);
		assert.match(killed.message, /发送超时/, `signal 无 error 时也必须走超时分支：${killed.message}`);
		assert.match(killed.message, /88ms/, `文案要报生效值：${killed.message}`);
		assert.match(killed.message, /信号 SIGKILL/, `文案要带终止信号名：${killed.message}`);
		assert.doesNotMatch(killed.message, /没有拿到 HTTP 状态码/, "不得退化成「没有拿到 HTTP 状态码」");
	});
});

// ---------------------------------------------------------------- 端到端：超时是唯一变量

describe("端到端：同一套接线 + 同一份会慢 300ms 的替身，唯一的变量是超时", () => {
	it("控制组（超时放宽到 120s）：同一张卡片送达 —— 证明慢是真的、替身真的被调用", () => {
		const fixture = doctorFixture("doctor-timeout-control", { timeoutEnv: TIMEOUT_GENEROUS });
		resetStubLog(STUB_LOG);
		const result = runCli(fixture, ["doctor", "--json"]);

		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		const parsed = jsonOf(result);
		assert.equal(parsed.summary, "1/1 通");
		assert.equal(parsed.channels[0].ok, true);
		assert.ok(parsed.channels[0].elapsedMs >= SLEEP_MS, `替身确实慢过 ${SLEEP_MS}ms：${parsed.channels[0].elapsedMs}ms`);

		const calls = readStubCalls(STUB_LOG);
		assert.equal(calls.length, 1, `应恰好调用一次替身：${JSON.stringify(calls)}`);
		assert.equal(calls[0].url, WEBHOOK);
		assert.match(readStubPayload(STUB_LOG), /配置自检/, "发的是测试卡片，不是别的请求");
		assert.ok(!result.stdout.includes("test-timeout"), "明文 webhook 不许出现在输出里");
	});

	it("对照组（只把超时压到 50ms）：同一条 channel 判不通 → 退出码 1 + 文案点明超时", () => {
		const fixture = doctorFixture("doctor-timeout");
		resetStubLog(STUB_LOG);
		const result = runCli(fixture, ["doctor"]);

		assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
		assert.match(result.stdout, /✗ default\s+发送超时（50ms 内没有响应，已中止，信号 SIGTERM）/, `应走超时分支：${result.stdout}`);
		assert.match(result.stdout, /0\/1 通/);
		assert.ok(!result.stdout.includes("test-timeout"), "明文 webhook 不许出现在输出里");
	});

	it("对照组 --json：结构化给出原因，且 doctor 自己测出的耗时是 50ms 量级（不是 15s）", () => {
		const fixture = doctorFixture("doctor-timeout-json");
		resetStubLog(STUB_LOG);
		const result = runCli(fixture, ["doctor", "--json"]);

		assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
		const parsed = jsonOf(result);
		assert.equal(parsed.ok, false);
		assert.equal(parsed.summary, "0/1 通");
		assert.equal(parsed.channels.length, 1);
		assert.equal(parsed.channels[0].ok, false);
		assert.equal(parsed.channels[0].httpCode, 0, "被超时中止 → 没有 HTTP 状态码");
		assert.equal(parsed.channels[0].bodyCode, null);
		assert.match(parsed.channels[0].detail, /发送超时（50ms/);
		// 上界给 1s 只为容忍调度抖动；要排除的是"等到 15s 默认超时"这种事
		assert.ok(parsed.channels[0].elapsedMs < 1000, `应是 50ms 量级：${parsed.channels[0].elapsedMs}ms`);
	});

	it("init 验证超时 → 视为验证失败、**不落盘**；env 里的 0 被钳成 10ms 才生效", () => {
		const fixture = doctorFixture("init-timeout", { timeoutEnv: "0", withConfig: false });
		resetStubLog(STUB_LOG);
		const result = runCli(fixture, ["init", "--non-interactive", "--webhook", WEBHOOK, "--channel", "default"]);

		assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
		assert.match(result.stderr, /未写入任何配置/);
		assert.match(result.stderr, new RegExp(`发送超时（${MIN_CURL_TIMEOUT_MS}ms 内没有响应，已中止，信号 SIGTERM）`), `0 应被钳到下限 ${MIN_CURL_TIMEOUT_MS}ms：${result.stderr}`);
		assert.equal(lstatSync(fixture.config, { throwIfNoEntry: false }), undefined, "验证失败不得留下配置文件");
	});
});
