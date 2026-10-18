/**
 * tests/sender-compat.test.mjs — 发送端（bash）接上配置解析后的行为与退出码（implement.md Step 2）
 *
 * 被测对象是本仓库的 bin/feishu-notify（与 ~/.local/bin/feishu-notify 字节一致），
 * 用 tests/helpers/stub-curl.mjs 的假 curl 拦掉一切网络请求。
 *
 * 锁住三件事：
 *   1. 解析优先级在 bash 侧的表现（--webhook > --channel > env > activeChannel > exit 2）
 *   2. 退出码矩阵：无参数=1、无内容的 --done=静默 0（**不因缺配置变成报错**）、
 *      缺配置=2、解析器缺失=2、发送失败=1
 *   3. 解析器位置的发现顺序（$FEISHU_NOTIFY_CLI > 同目录 > ~/.local/bin > PATH）
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import { installStubCurl, readStubCalls, resetStubLog } from "./helpers/stub-curl.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SENDER = join(REPO_ROOT, "bin", "feishu-notify");
const CLI = join(REPO_ROOT, "bin", "feishu-notify-cli");

const TMP = mkdtempSync(join(tmpdir(), "feishu-notify-compat-"));
const HOME = join(TMP, "home");
const STUB_DIR = join(TMP, "stub-bin");
const STUB_LOG = join(TMP, "stub-log.jsonl");
const CONFIG = join(TMP, "cfg", "config.json");
const MISSING_CONFIG = join(TMP, "nope", "config.json");
mkdirSync(HOME, { recursive: true });

after(() => rmSync(TMP, { recursive: true, force: true }));

const HOOK = (token) => `https://open.feishu.cn/open-apis/bot/v2/hook/${token}`;
const TOKEN_A = "test-active-channel";
const TOKEN_B = "test-other-channel";
const TOKEN_C = "test-env-override";
const A = HOOK(TOKEN_A);
const B = HOOK(TOKEN_B);
const C = HOOK(TOKEN_C);

before(() => {
	installStubCurl(STUB_DIR);
	mkdirSync(dirname(CONFIG), { recursive: true });
	writeFileSync(
		CONFIG,
		`${JSON.stringify({ version: 1, activeChannel: "default", channels: { default: { webhook: A }, opencode: { webhook: B, label: "opencode" } } }, null, 2)}\n`,
	);
	chmodSync(CONFIG, 0o600);
});

function envFor({ config = CONFIG, extra = {}, cli = CLI } = {}) {
	const env = {
		...process.env,
		HOME,
		PATH: `${STUB_DIR}:${process.env.PATH}`,
		FEISHU_STUB_LOG: STUB_LOG,
	};
	for (const key of ["TERM_PROGRAM", "VSCODE_PID", "ELECTRON_RUN_AS_NODE", "CLAUDE_CODE_DESKTOP", "FEISHU_NOTIFY_WEBHOOK", "FEISHU_NOTIFY_CHANNEL", "FEISHU_NOTIFY_CLI"]) {
		delete env[key];
	}
	if (config === null) delete env.FEISHU_NOTIFY_CONFIG;
	else env.FEISHU_NOTIFY_CONFIG = config;
	if (cli !== null) env.FEISHU_NOTIFY_CLI = cli;
	Object.assign(env, extra);
	for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
	return env;
}

function runSender(args, { env, input = "", bin = SENDER } = {}) {
	return spawnSync("bash", [bin, ...args], { encoding: "utf8", input, env: env ?? envFor() });
}

const urlsCalled = () => readStubCalls(STUB_LOG).map((call) => call.url);

describe("发送端：解析优先级（Step 2）", () => {
	it("无 --webhook/--channel → 用配置 activeChannel", () => {
		resetStubLog(STUB_LOG);
		const result = runSender(["--text", "hi"]);
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(urlsCalled(), [A]);
	});

	it("--channel 指定另一个 channel → 打到它", () => {
		resetStubLog(STUB_LOG);
		const result = runSender(["--channel", "opencode", "--text", "hi"]);
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(urlsCalled(), [B]);
	});

	it("--webhook 仍然最高优先（同时给了 --channel）", () => {
		resetStubLog(STUB_LOG);
		const result = runSender(["--webhook", C, "--channel", "opencode", "--text", "hi"]);
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(urlsCalled(), [C]);
	});

	it("FEISHU_NOTIFY_WEBHOOK 覆盖 activeChannel（source=env），且 stderr 只有掩码", () => {
		resetStubLog(STUB_LOG);
		const result = runSender(["--text", "hi"], { env: envFor({ extra: { FEISHU_NOTIFY_WEBHOOK: C } }) });
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(urlsCalled(), [C]);
		assert.match(result.stderr, /source=env/);
		assert.ok(!result.stderr.includes(TOKEN_C), `stderr 不得出现明文：${result.stderr}`);
		assert.match(result.stderr, /<REDACTED>/);
	});

	it("--channel 指向不存在的 channel → exit 2（引导语来自解析器）+ 机器可读标记", () => {
		resetStubLog(STUB_LOG);
		const result = runSender(["--channel", "ghost", "--text", "hi"]);
		assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
		assert.match(result.stderr, /没有名为 "ghost" 的 channel/);
		assert.match(result.stderr, /default, opencode/);
		// F/G3：CLI 追加的机器可读标记（发送端 stderr 透传）—— 插件优先靠它判"channel 不存在"
		assert.match(result.stderr, /^reason=channel-not-found channel=ghost$/m, `缺机器可读标记：\n${result.stderr}`);
		assert.deepEqual(urlsCalled(), []);
	});

	it("--webhook 非 https → exit 2（design §2 校验，flag 也走同一份校验）", () => {
		resetStubLog(STUB_LOG);
		const result = runSender(["--webhook", "http://open.feishu.cn/open-apis/bot/v2/hook/test-insecure", "--text", "hi"]);
		assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
		assert.match(result.stderr, /协议必须是 https/);
		assert.deepEqual(urlsCalled(), []);
	});
});

describe("发送端：退出码矩阵未被破坏", () => {
	it("无参数 → exit 1 + 用法（含新增的 --channel 与 init 引导）", () => {
		resetStubLog(STUB_LOG);
		const result = runSender([], { input: "" });
		assert.equal(result.status, 1);
		assert.match(result.stdout, /--channel name/);
		assert.match(result.stdout, /feishu-notify-cli init/);
		assert.deepEqual(urlsCalled(), []);
	});

	it("--done 没有 stdin 内容 → 静默 exit 0（**缺配置也不报错**，因为发送前才解析）", () => {
		resetStubLog(STUB_LOG);
		const result = runSender(["--done"], { input: "", env: envFor({ config: MISSING_CONFIG }) });
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.equal(result.stdout, "");
		assert.equal(result.stderr, "");
		assert.deepEqual(urlsCalled(), [], "没有消息就不该发卡");
	});

	it("缺配置 + 有消息 → exit 2 + init 引导语，且不回退到任何内置地址", () => {
		resetStubLog(STUB_LOG);
		const result = runSender(["--text", "hi"], { env: envFor({ config: MISSING_CONFIG }) });
		assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
		assert.match(result.stderr, /未配置飞书机器人 webhook/);
		assert.match(result.stderr, /npx feishu-notify-cli init/);
		assert.ok(result.stderr.includes(MISSING_CONFIG), "必须指出配置文件路径");
		assert.deepEqual(urlsCalled(), []);
	});

	it("curl 拿不到 200 → exit 1 + 原有失败文案", () => {
		resetStubLog(STUB_LOG);
		const result = runSender(["--text", "hi"], { env: envFor({ extra: { FEISHU_STUB_FAIL_500: TOKEN_A } }) });
		assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
		assert.match(result.stdout, /发送失败 \(HTTP 500\)/);
		assert.deepEqual(urlsCalled(), [A]);
	});

	it("文件不存在仍然 exit 1（原有行为）", () => {
		resetStubLog(STUB_LOG);
		const result = runSender(["--file", join(TMP, "no-such-file.txt")]);
		assert.equal(result.status, 1);
		assert.match(result.stdout, /文件不存在/);
		assert.deepEqual(urlsCalled(), []);
	});
});

describe("发送端：解析器位置发现顺序", () => {
	it("$FEISHU_NOTIFY_CLI 指向非可执行文件 → exit 2 + 明确指出", () => {
		resetStubLog(STUB_LOG);
		const result = runSender(["--text", "hi"], { env: envFor({ cli: join(TMP, "not-a-file") }) });
		assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
		assert.match(result.stderr, /FEISHU_NOTIFY_CLI 指向的不是可执行文件/);
		assert.deepEqual(urlsCalled(), []);
	});

	it("不给 $FEISHU_NOTIFY_CLI 时用同目录的 feishu-notify-cli（npm 安装后的布局）", () => {
		resetStubLog(STUB_LOG);
		const result = runSender(["--text", "hi"], { env: envFor({ cli: null }) });
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.deepEqual(urlsCalled(), [A], "应通过仓库同目录的解析器解析成功");
	});

	it("解析器彻底找不到（脚本被搬到无同目录解析器的位置、PATH 上也没有）→ exit 2 + 安装引导", () => {
		const lonely = join(TMP, "lonely");
		mkdirSync(lonely, { recursive: true });
		const lonelyBin = join(lonely, "feishu-notify");
		copyFileSync(SENDER, lonelyBin);
		chmodSync(lonelyBin, 0o755);
		resetStubLog(STUB_LOG);

		// 注意：必须把 PATH 收干净。真实开发机的 PATH 里有 ~/.local/bin，而我们刚刚
		// 把 feishu-notify-cli 链进了那里（等价 npm i -g），于是"到处都找不到"这个前提
		// 在真实 PATH 下不成立 —— 这正是发现顺序的第 3/4 条在工作，不是 bug。
		const sanitizedPath = `${STUB_DIR}:/usr/bin:/bin`;
		const result = runSender(["--text", "hi"], { env: envFor({ cli: null, extra: { PATH: sanitizedPath } }), bin: lonelyBin });
		assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
		assert.match(result.stderr, /找不到 feishu-notify-cli/);
		assert.match(result.stderr, /npx feishu-notify-cli init/);
		assert.deepEqual(urlsCalled(), []);
	});

	it("HOME 的 ~/.local/bin 里有解析器时，用它（第 3 条发现规则）", () => {		const altHome = join(TMP, "alt-home");
		const altCli = join(altHome, ".local", "bin", "feishu-notify-cli");
		mkdirSync(dirname(altCli), { recursive: true });
		writeFileSync(altCli, ["#!/bin/sh", "# 测试替身：只把固定地址打到 stdout（模拟 feishu-notify-cli resolve）", `printf '%s' "${A}"`, ""].join("\n"), { mode: 0o755 });
		chmodSync(altCli, 0o755);

		const lonely = join(TMP, "lonely-2");
		mkdirSync(lonely, { recursive: true });
		const lonelyBin = join(lonely, "feishu-notify");
		copyFileSync(SENDER, lonelyBin);
		chmodSync(lonelyBin, 0o755);
		resetStubLog(STUB_LOG);

		const result = runSender(["--text", "hi"], {
			env: envFor({ cli: null, config: MISSING_CONFIG, extra: { HOME: altHome, PATH: `${STUB_DIR}:/usr/bin:/bin` } }),
			bin: lonelyBin,
		});
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.deepEqual(urlsCalled(), [A], "应使用 $HOME/.local/bin 下的解析器");
	});
});

describe("发送端：Node 解释器选择（hook 环境的 PATH 不一定是登录 shell 那套）", () => {
	it("PATH 上只有旧版 node 时，用 $FEISHU_NOTIFY_NODE 指定的 node（版本检查 + 显式解释器）", () => {
		const oldNodeDir = join(TMP, "old-node-bin");
		mkdirSync(oldNodeDir, { recursive: true });
		const fakeOldNode = join(oldNodeDir, "node");
		writeFileSync(
			fakeOldNode,
			["#!/bin/sh", "# 假 node：报告一个太旧的版本号（本机 /usr/local/bin/node 就是 v14）", 'if [ "$1" = "-e" ]; then printf "14"; exit 0; fi', 'echo "fake-old-node: unsupported" >&2', "exit 1", ""].join("\n"),
			{ mode: 0o755 },
		);
		chmodSync(fakeOldNode, 0o755);
		resetStubLog(STUB_LOG);

		const result = runSender(["--text", "hi"], {
			env: envFor({ extra: { PATH: `${oldNodeDir}:${STUB_DIR}:/usr/bin:/bin`, FEISHU_NOTIFY_NODE: process.execPath } }),
		});
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.deepEqual(urlsCalled(), [A], "应通过真实 node 解析成功，而不是撞上那个旧 node");
		assert.ok(!result.stderr.includes("fake-old-node"), "不得走到旧 node 上");
	});
});

describe("发送端：payload 与非 hook 输入无关（AC4 的旁证）", () => {
	it("同一输入在 env/channel/activeChannel 三种来源下产出完全相同的 payload", () => {
		const payloads = [];
		for (const [label, invoke] of [
			["activeChannel", () => runSender(["--text", "payload-一致性检查"])],
			["channel", () => runSender(["--channel", "opencode", "--text", "payload-一致性检查"])],
			["env", () => runSender(["--text", "payload-一致性检查"], { env: envFor({ extra: { FEISHU_NOTIFY_WEBHOOK: C } }) })],
		]) {
			resetStubLog(STUB_LOG);
			const result = invoke();
			assert.equal(result.status, 0, `${label}: ${result.stderr}`);
			payloads.push(readFileSync(`${STUB_LOG}.payload`, "utf8"));
		}
		assert.equal(new Set(payloads).size, 1, "webhook 来源不同不得影响 payload 字节");
		assert.ok(!payloads[0].includes("open-apis"), "payload 里不该出现任何 URL");
	});
});
