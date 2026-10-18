/**
 * tests/wiring.test.mjs — 接线健康自检（prd R11 / AC10）
 *
 * 事故：2026-10-18 仓库改名 → `~/.local/bin/feishu-notify-cli` 悬空 → 发送端 exit 2 → **通知静默失效**。
 *
 * 覆盖：
 *   - `classify()` 的分类矩阵，重点是**悬空符号链接**（用 lstat 判链接、跟随判目标，
 *     只跟随的话悬空链接会被误报成"不存在"，而两者的修法完全不同）
 *   - `checkWiring()` 的四种场景：健康 / 解析器悬空（事故复现）/ 发送端缺失 / Node 太旧
 *   - 端到端：doctor 在悬空链接下打印 ✗ 行 + 可执行修复指引，且**退出码不受接线影响**
 *     （hook 的 PATH/HOME 与 shell 不同，这里给的是指引；这条是刻意选择，测试把它锁住）
 *   - `--json` 带上 `wiring`
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import { NODE_MIN_MAJOR, checkWiring, classify, renderWiring } from "../lib/wiring.mjs";
import { installStubCurl, readStubCalls, resetStubLog } from "./helpers/stub-curl.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPO_ROOT, "bin", "feishu-notify-cli");

const TMP = mkdtempSync(join(tmpdir(), "feishu-notify-wiring-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

const STUB_DIR = join(TMP, "stub-bin");
const STUB_LOG = join(TMP, "stub-log.jsonl");
const HOOK = (token) => `https://open.feishu.cn/open-apis/bot/v2/hook/${token}`;

before(() => {
	installStubCurl(STUB_DIR);
});

/** 造一个 bin 目录：假发送端、假解析器、指向真实 node 的符号链接、假 node（可指定版本） */
function makeBinDir(name, { sender = true, resolver = true, nodeVersion = null } = {}) {
	const dir = join(TMP, name);
	mkdirSync(dir, { recursive: true });
	const exec = (file, body) => {
		writeFileSync(join(dir, file), body, { mode: 0o755 });
		chmodSync(join(dir, file), 0o755);
	};
	if (sender) exec("feishu-notify", "#!/bin/sh\necho fake-sender\n");
	if (resolver) exec("feishu-notify-cli", "#!/bin/sh\necho fake-resolver\n");
	if (nodeVersion === null) symlinkSync(process.execPath, join(dir, "node"));
	else exec("node", `#!/bin/sh\nprintf '%s' "${nodeVersion}"\n`);
	return dir;
}

function makeHome(name) {
	const home = join(TMP, name);
	mkdirSync(join(home, ".local", "bin"), { recursive: true });
	return home;
}

/**
 * PATH 只有"受控目录 + 系统基础目录"：不继承开发机的 PATH。
 * 否则"这台机器上恰好有个全局 feishu-notify-cli / 老 node"会让断时绿时红
 * （implement.md 偏差 L 记录过同款坑）。
 */
const SYSTEM_PATH = "/bin:/usr/bin:/usr/sbin:/sbin";
const envFor = (home, binDir) => ({ ...process.env, HOME: home, PATH: `${binDir}:${SYSTEM_PATH}`, FEISHU_NOTIFY_NODE: undefined, FEISHU_NOTIFY_CLI: undefined });

// ---------------------------------------------------------------- classify

describe("classify：一个路径的真相（lstat 判链接、跟随判目标）", () => {
	it("不存在的路径 → missing", () => {
		assert.equal(classify(join(TMP, "nope", "nothing")).kind, "missing");
	});

	it("可执行文件 → ok；不可执行文件 → not-executable（并报出 mode）", () => {
		const dir = join(TMP, "classify-files");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "x.sh"), "#!/bin/sh\n", { mode: 0o755 });
		writeFileSync(join(dir, "plain"), "nothing\n", { mode: 0o644 });

		assert.equal(classify(join(dir, "x.sh")).kind, "ok");
		const plain = classify(join(dir, "plain"));
		assert.equal(plain.kind, "not-executable");
		assert.match(plain.detail, /644/);
	});

	it("目录 → directory（不当成可执行文件）", () => {
		assert.equal(classify(TMP).kind, "directory");
	});

	it("**悬空符号链接** → dangling-symlink（本用例就是事故形态：仓库改名后留下的链接）", () => {
		const dir = join(TMP, "classify-link");
		mkdirSync(dir, { recursive: true });
		const link = join(dir, "feishu-notify-cli");
		const target = join(TMP, "renamed-away-repo", "bin", "feishu-notify-cli");
		symlinkSync(target, link);

		const result = classify(link);
		assert.equal(result.kind, "dangling-symlink", "悬空链接必须区别于 missing 与 not-executable");
		assert.equal(result.target, target, "要把它指向哪里也报出来（用户才能判断是不是自己挪过）");
		assert.match(result.detail, /悬空符号链接/);
		assert.match(result.detail, /renamed-away-repo/);
	});

	it("指向可执行文件的符号链接 → ok，并带上指向；指向普通文件的链接 → not-executable", () => {
		const dir = join(TMP, "classify-link-ok");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "real.sh"), "#!/bin/sh\n", { mode: 0o755 });
		writeFileSync(join(dir, "real.txt"), "x\n", { mode: 0o644 });
		symlinkSync(join(dir, "real.sh"), join(dir, "link-ok"));
		symlinkSync(join(dir, "real.txt"), join(dir, "link-plain"));

		const ok = classify(join(dir, "link-ok"));
		assert.equal(ok.kind, "ok");
		assert.match(ok.detail, /符号链接 → /);
		assert.equal(classify(join(dir, "link-plain")).kind, "not-executable");
	});
});

// ---------------------------------------------------------------- checkWiring

describe("checkWiring：发送端 → 解析器 → Node 三环", () => {
	it("三环齐全 → ok，且不产生任何修复项之外的输出", () => {
		const home = makeHome("wiring-ok-home");
		const binDir = makeBinDir("wiring-ok-bin");
		const wiring = checkWiring({ env: envFor(home, binDir), selfPath: join(binDir, "feishu-notify-cli") });

		assert.equal(wiring.ok, true, JSON.stringify(wiring, null, 2));
		assert.equal(wiring.sender.ok, true);
		assert.equal(wiring.resolver.ok, true);
		assert.equal(wiring.node.ok, true);
		assert.ok(Number(wiring.node.version.split(".")[0]) >= NODE_MIN_MAJOR);
		assert.deepEqual(wiring.fixes, ["接线健康：发送端、解析器、Node 三环齐全。"]);
	});

	it("解析器悬空（事故复现）→ ok=false，指向哪里 + 怎么修都写出来", () => {
		const home = makeHome("wiring-dangling-home");
		const binDir = makeBinDir("wiring-dangling-bin", { resolver: false });
		const gone = join(TMP, "renamed-repo", "packages", "cli", "bin", "feishu-notify-cli");
		symlinkSync(gone, join(home, ".local", "bin", "feishu-notify-cli"));

		const wiring = checkWiring({ env: envFor(home, binDir), selfPath: join(binDir, "feishu-notify-cli") });

		assert.equal(wiring.resolver.ok, false);
		const broken = wiring.resolver.candidates.find((candidate) => candidate.kind === "dangling-symlink");
		assert.ok(broken, `应认出悬空链接：${JSON.stringify(wiring.resolver.candidates, null, 2)}`);
		assert.equal(broken.path, join(home, ".local", "bin", "feishu-notify-cli"));
		assert.equal(broken.target, gone);

		const text = wiring.fixes.join("\n");
		assert.match(text, /悬空符号链接/);
		assert.match(text, /rm /, "修法必须可执行（先是删除那条坏链接）");
		assert.match(text, /npm i -g feishu-notify-cli/, "再是重装/全局安装");
		assert.equal(wiring.ok, false);
	});

	it("发送端本身缺失 → ok=false，并提示全局安装（hook 里写绝对路径的要同步改）", () => {
		const home = makeHome("wiring-nosender-home");
		const binDir = makeBinDir("wiring-nosender-bin", { sender: false });
		const wiring = checkWiring({ env: envFor(home, binDir), selfPath: join(TMP, "nowhere", "feishu-notify-cli") });

		assert.equal(wiring.sender.ok, false);
		assert.equal(wiring.ok, false);
		const text = wiring.fixes.join("\n");
		assert.match(text, /找不到发送端 feishu-notify/);
		assert.match(text, /npm i -g feishu-notify-cli/);
		assert.match(text, /hook 命令里写的若是绝对路径/);
	});

	it("PATH 上的 node 太旧 → ok=false，并把「查到哪些旧版本」报出来", () => {
		const home = makeHome("wiring-oldnode-home");
		const binDir = makeBinDir("wiring-oldnode-bin", { nodeVersion: "14.17.5" });
		const wiring = checkWiring({ env: envFor(home, binDir), selfPath: join(binDir, "feishu-notify-cli") });

		assert.equal(wiring.node.ok, false);
		assert.equal(wiring.ok, false);
		const old = wiring.node.candidates.find((candidate) => candidate.major === 14);
		assert.ok(old, "应记录到旧版本候选");
		assert.match(wiring.fixes.join("\n"), new RegExp(`Node ≥ ${NODE_MIN_MAJOR}`));
		assert.match(wiring.fixes.join("\n"), /FEISHU_NOTIFY_NODE/);
	});

	it("renderWiring：坏候选即使被后面的好候选兜住，也要打印出来（今天是隐患，明天是故障）", () => {
		const home = makeHome("wiring-render-home");
		const binDir = makeBinDir("wiring-render-bin", { resolver: false });
		symlinkSync(join(TMP, "gone-away"), join(home, ".local", "bin", "feishu-notify-cli"));
		// 后面还有一个可用的解析器（PATH 上）→ 链本身是通的，但坏的那条仍然要报
		writeFileSync(join(binDir, "feishu-notify-cli"), "#!/bin/sh\necho fake\n", { mode: 0o755 });

		const wiring = checkWiring({ env: envFor(home, binDir), selfPath: join(binDir, "feishu-notify-cli") });
		assert.equal(wiring.resolver.ok, true, "PATH 上那份兜住了");
		const lines = renderWiring(wiring).join("\n");
		assert.match(lines, /✗ .*feishu-notify-cli：悬空符号链接/);
		assert.match(lines, /rm /);
	});
});

// ---------------------------------------------------------------- doctor 端到端

describe("doctor：接线自检的输出与退出码", () => {
	/**
	 * 模拟"全局装出来的布局 + 仓库改名后的事故"：
	 *   runner/feishu-notify-cli      → 指向仓库 CLI 的符号链接（doctor 本体从这里跑，目录里没有发送端）
	 *   ~/.local/bin/feishu-notify    → 发送端（真实文件；hook 直接调它）
	 *   ~/.local/bin/feishu-notify-cli→ 解析器；danglingResolver 时指向已改名的仓库（**事故形态**）
	 *   PATH                          → 只有 node 与 stub curl（hook 环境的 PATH 不保证有别的）
	 */
	function scenario(label, { danglingResolver = false } = {}) {
		const root = join(TMP, `doctor-${label}`);
		const home = join(root, "home");
		const localBin = join(home, ".local", "bin");
		const xdg = join(root, "xdg");
		const binDir = join(root, "bin");
		const runnerDir = join(root, "runner");
		for (const dir of [localBin, xdg, binDir, runnerDir]) mkdirSync(dir, { recursive: true });

		writeFileSync(join(localBin, "feishu-notify"), "#!/bin/sh\necho fake-sender\n", { mode: 0o755 });
		if (danglingResolver) symlinkSync(join(TMP, "renamed-away-repo", "bin", "feishu-notify-cli"), join(localBin, "feishu-notify-cli"));
		else writeFileSync(join(localBin, "feishu-notify-cli"), "#!/bin/sh\necho fake-resolver\n", { mode: 0o755 });

		symlinkSync(process.execPath, join(binDir, "node"));
		installStubCurl(binDir);
		symlinkSync(CLI, join(runnerDir, "feishu-notify-cli"));

		const config = join(root, "config.json");
		writeFileSync(config, `${JSON.stringify({ version: 1, activeChannel: "default", channels: { default: { webhook: HOOK("test-wiring") } } }, null, 2)}\n`, { mode: 0o600 });

		return {
			config,
			runner: join(runnerDir, "feishu-notify-cli"),
			env: {
				...process.env,
				HOME: home,
				XDG_CONFIG_HOME: xdg,
				PATH: `${binDir}:/bin:/usr/bin:/usr/sbin:/sbin`,
				FEISHU_NOTIFY_CONFIG: config,
				FEISHU_STUB_LOG: STUB_LOG,
				FEISHU_NOTIFY_CLI: undefined,
				FEISHU_NOTIFY_NODE: undefined,
			},
		};
	}

	const runDoctor = (fixture, args = []) => spawnSync(process.execPath, [fixture.runner, "doctor", ...args], { encoding: "utf8", env: fixture.env });

	it("健康接线：✓ 三行都在，卡片照发，退出码 0", () => {
		const fixture = scenario("ok");
		resetStubLog(STUB_LOG);
		const result = runDoctor(fixture);

		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.match(result.stdout, /▸ 接线自检/);
		assert.match(result.stdout, /✓ 发送端/);
		assert.match(result.stdout, /✓ 解析器/);
		assert.match(result.stdout, new RegExp(`✓ Node ≥ ${NODE_MIN_MAJOR}`));
		assert.match(result.stdout, /1\/1 通/);
	});

	it("悬空符号链接（事故复现）：✗ 解析器 + 指向 + 可执行的修复指引；卡片仍发出；退出码不变（0）", () => {
		const fixture = scenario("dangling", { danglingResolver: true });
		resetStubLog(STUB_LOG);
		const result = runDoctor(fixture);

		assert.equal(result.status, 0, "接线自检刻意不改变退出码（hook 的 PATH/HOME 与 shell 不同，这里给的是指引）");
		assert.match(result.stdout, /✗ 解析器\s+<找不到>/);
		assert.match(result.stdout, /feishu-notify-cli：悬空符号链接/);
		assert.match(result.stdout, /renamed-away-repo/);
		assert.match(result.stdout, /修复：/);
		assert.match(result.stdout, /rm .*feishu-notify-cli/);
		assert.match(result.stdout, /npm i -g feishu-notify-cli/);
		assert.match(result.stdout, /静默失效/, "结论段要明确「这里通了不代表 hook 能发出去」");
		assert.match(result.stdout, /1\/1 通/, "接线坏了不代表 channel 不可达 —— 两件事分开报");
	});

	it("--json 带上 wiring（机器可判），且不影响 channels/ok 字段", () => {
		const fixture = scenario("json", { danglingResolver: true });
		resetStubLog(STUB_LOG);
		const result = runDoctor(fixture, ["--json"]);

		const parsed = JSON.parse(result.stdout);
		assert.equal(parsed.ok, true);
		assert.equal(parsed.wiring.ok, false);
		assert.equal(parsed.wiring.resolver.ok, false);
		assert.equal(parsed.wiring.sender.ok, true);
		assert.ok(parsed.wiring.resolver.candidates.some((candidate) => candidate.kind === "dangling-symlink"));
		assert.deepEqual(parsed.channels.map((entry) => entry.name), ["default"]);
	});

	it("接线自检不联网、不发卡：只 stat/spawn，不产生额外 curl 调用", () => {
		const fixture = scenario("nocurl");
		resetStubLog(STUB_LOG);
		runDoctor(fixture);
		assert.equal(readStubCalls(STUB_LOG).length, 1, "只该有 doctor 自己那一张测试卡片");
	});
});
