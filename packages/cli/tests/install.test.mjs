/**
 * tests/install.test.mjs — `install` 三目标 + 编排（implement.md Step 4 / prd R6、AC5、AC9）
 *
 * 隔离约定（与 init.test.mjs 一致，只是把"模拟 HOME"做得更完整）：
 *   每个用例 mkdtemp 出一个**临时 HOME**，把三个目标的配置文件都放进去
 *   （`~/.claude/settings.json`、`~/.config/opencode/opencode.json`、`~/.dsh/profiles/web/package.json`），
 *   并且只通过 `env.HOME` / `env.PATH` 让 CLI 看到它们。文件末尾有守卫断言：真实 HOME 一个字节都没动。
 *
 * 覆盖：
 *   - 探测：三个目标各自的探测条件（含"目录在但没有配置文件"）
 *   - claude-code：合并两条 hook、按 command 去重（含"等价但不同文"）、保留用户既有 hook、
 *     只在显式 `--channel` 时才附加、坏 JSON/符号链接/hooks 形状不对 → 拒绝且不写
 *   - opencode：两种书写形态、去重、**包不可解析时拒绝写入**（--no-verify 可跳过）、坏 JSON 不覆盖
 *   - dsh：默认**只探测与计划、明确拒绝写入**；`--dsh-dev-dir` 联调可写；已接线 → 无需改动
 *   - 通用：`--dry-run` 零写入、写前 `.bak.<时间戳>`、**幂等**（第二次跑树哈希不变）、
 *     单目标失败不影响其它目标、回滚指令、退出码矩阵
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import { commandFor as claudeCommandFor } from "../lib/install-targets/claude-code.mjs";
import { PACKAGE_NAME as ocPackage, checkPublished, entryTarget } from "../lib/install-targets/opencode.mjs";
import { listProfiles } from "../lib/install-targets/dsh.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPO_ROOT, "bin", "feishu-notify-cli");

const TMP = mkdtempSync(join(tmpdir(), "feishu-notify-install-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

const USER_STOP_HOOK = "/Users/someone/.claude/hooks/mnemon/stop.sh";
const ADOPTED_IDLE_HOOK = "~/.local/bin/feishu-notify --idle";

// ---------------------------------------------------------------- 模拟 HOME

let counter = 0;

/** 造一个完整的"已装三个 agent"的模拟 HOME（各目标内容可用参数覆盖） */
function makeHome({ claude = undefined, opencode = undefined, dsh = undefined, profiles = ["web"], files = {} } = {}) {
	const root = join(TMP, `case-${++counter}`);
	const home = join(root, "home");
	mkdirSync(home, { recursive: true });

	if (claude !== null) {
		mkdirSync(join(home, ".claude"), { recursive: true });
		writeFileSync(join(home, ".claude", "settings.json"), typeof claude === "string" ? claude : `${JSON.stringify(claude ?? defaultClaudeSettings(), null, 2)}\n`);
	}
	if (opencode !== null) {
		mkdirSync(join(home, ".config", "opencode"), { recursive: true });
		writeFileSync(join(home, ".config", "opencode", "opencode.json"), typeof opencode === "string" ? opencode : `${JSON.stringify(opencode ?? { $schema: "https://opencode.ai/config.json", plugins: [] }, null, 2)}\n`);
	}
	for (const profile of profiles) {
		const dir = join(home, ".dsh", "profiles", profile);
		mkdirSync(dir, { recursive: true });
		const raw = typeof dsh === "function" ? dsh(profile) : dsh;
		const value = raw ?? { name: `dsh-profile-${profile}`, private: true, dependencies: {}, dsh: { profile: { bundles: ["dsh-mnemon"] } } };
		writeFileSync(join(dir, "package.json"), typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
	}
	for (const [rel, content] of Object.entries(files)) {
		const target = join(home, rel);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, content);
	}
	return { root, home, claude: join(home, ".claude", "settings.json"), opencodeFile: join(home, ".config", "opencode", "opencode.json"), profile: (name = "web") => join(home, ".dsh", "profiles", name, "package.json") };
}

/** 作者本机那份的等价物：两条 feishu hook 里"Notification 已经装过（但是旧路径写法）"，Stop 还没装 */
function defaultClaudeSettings() {
	return {
		hooks: {
			Notification: [{ hooks: [{ command: ADOPTED_IDLE_HOOK, timeout: 10000, type: "command" }], matcher: "idle_prompt" }],
			Stop: [{ hooks: [{ command: USER_STOP_HOOK, type: "command" }] }],
		},
	};
}

// ---------------------------------------------------------------- stub npm / 运行

const STUB_DIR = join(TMP, "stub-bin");
const OK_NPM = join(STUB_DIR, "npm-ok");
const FAIL_NPM = join(STUB_DIR, "npm-fail");

before(() => {
	mkdirSync(STUB_DIR, { recursive: true });
	writeFileSync(OK_NPM, '#!/bin/sh\n[ "$1" = "view" ] && { printf \'"0.1.0"\'; exit 0; }\necho "stub-npm-ok: unsupported $*" >&2\nexit 1\n', { mode: 0o755 });
	writeFileSync(FAIL_NPM, '#!/bin/sh\necho "npm error code E404" >&2\necho "npm error 404 Not Found - GET https://registry.npmjs.org/$3 - Not found" >&2\nexit 1\n', { mode: 0o755 });
});

function envFor(home, { npm = OK_NPM, extra = {} } = {}) {
	const env = { ...process.env, HOME: home };
	delete env.FEISHU_NOTIFY_CONFIG;
	delete env.FEISHU_NOTIFY_WEBHOOK;
	delete env.XDG_CONFIG_HOME;
	if (npm) env.FEISHU_NOTIFY_NPM = npm;
	else delete env.FEISHU_NOTIFY_NPM;
	Object.assign(env, extra);
	for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
	return env;
}

function runInstall(args, { home, npm, extra, input } = {}) {
	return spawnSync(process.execPath, [CLI, "install", ...args], { encoding: "utf8", env: envFor(home, { npm, extra }), input });
}

// ---------------------------------------------------------------- 断言工具

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** 整棵临时 HOME 的"文件 → 内容哈希"快照：幂等与零写入都用它断言（比逐个文件断言更不容易漏） */
function treeState(root) {
	const entries = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true }).sort((left, right) => (left.name < right.name ? -1 : 1))) {
			const target = join(dir, entry.name);
			if (entry.isDirectory()) walk(target);
			else if (entry.isSymbolicLink()) entries.push([relative(root, target), `-> ${readFileSync(target, "utf8").length}`]);
			else entries.push([relative(root, target), sha256(readFileSync(target, "utf8"))]);
		}
	};
	walk(root);
	return JSON.stringify(entries);
}

/** 某个 commit 里的 hook command 列表（claude-code 的记录用） */
function hookCommands(file, event) {
	const doc = readJson(file);
	return (doc.hooks?.[event] ?? []).flatMap((group) => (group.hooks ?? []).map((handler) => handler.command));
}

// ---------------------------------------------------------------- 探测

describe("install：探测", () => {
	it("三个目标都在 → 探测表逐条列出，且 dry-run 零写入", () => {
		const fixture = makeHome();
		const before = treeState(fixture.home);
		const result = runInstall(["--dry-run"], { home: fixture.home });

		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.match(result.stdout, /✓ Claude Code\s+~\/\.claude\/settings\.json/);
		assert.match(result.stdout, /✓ opencode\s+~\/\.config\/opencode\/opencode\.json/);
		assert.match(result.stdout, /✓ DSH \(Cordis\)\s+~\/\.dsh\/profiles：web/);
		assert.equal(treeState(fixture.home), before, "--dry-run 必须零写入");
		assert.ok(!/\.bak\./.test(result.stdout), "--dry-run 不该提到备份");
	});

	it("一个目标都没有 → 给出每个目标需要的文件与下一步；不假装成功也不报错", () => {
		const fixture = makeHome({ claude: null, opencode: null, profiles: [] });
		const result = runInstall(["--yes"], { home: fixture.home });

		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.match(result.stdout, /没有任何可接入的 agent|没有探测到任何可接入的 agent/);
		assert.match(result.stdout, /\.claude\/settings\.json/);
		assert.match(result.stdout, /opencode\.json/);
		assert.match(result.stdout, /\.dsh\/profiles/);
		assert.match(result.stdout, /doctor/);
	});

	it("~/.config/opencode 在但 opencode.json 不在 → 提示先让 opencode 自己写一次配置", () => {
		const fixture = makeHome({ opencode: null });
		mkdirSync(join(fixture.home, ".config", "opencode"), { recursive: true });
		const result = runInstall(["--dry-run", "--target", "opencode"], { home: fixture.home });

		assert.match(result.stdout, /opencode\.json/);
		assert.match(result.stdout, /– 跳过：/);
		assert.match(result.stdout, /没有 opencode\.json/);
	});
});

// ---------------------------------------------------------------- claude-code

describe("install：claude-code", () => {
	it("合并两条 hook：Stop 追加、保留用户既有 hook、Notification 已等价 → 提示但不重复写", () => {
		const fixture = makeHome();
		const result = runInstall(["--yes"], { home: fixture.home });
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

		const stop = hookCommands(fixture.claude, "Stop");
		assert.deepEqual(stop, [USER_STOP_HOOK, "feishu-notify --done"], "用户既有的 Stop hook 必须原样保留，新 hook 追加在后面");
		assert.deepEqual(hookCommands(fixture.claude, "Notification"), [ADOPTED_IDLE_HOOK], "已存在的等价 hook 不该被再加一条");
		assert.match(result.stdout, /已有等价 hook/);
		assert.match(result.stdout, /保持不变/);

		// 备份存在且内容 = 改动前那份
		const backups = readdirSync(join(fixture.home, ".claude")).filter((name) => name.startsWith("settings.json.bak."));
		assert.equal(backups.length, 1);
		assert.ok(!readFileSync(join(fixture.home, ".claude", backups[0]), "utf8").includes("feishu-notify --done"));
		assert.match(result.stdout, /回滚（每个被改的文件都留了备份）：/);
		assert.match(result.stdout, new RegExp(`cp -p ~/\\.claude/settings\\.json\\.bak\\.`));
	});

	it("空 settings.json（什么都没有）→ 两条 hook 与两个事件分组都建起来", () => {
		const fixture = makeHome({ claude: {} });
		const result = runInstall(["--yes"], { home: fixture.home });
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

		const doc = readJson(fixture.claude);
		assert.equal(doc.hooks.Notification[0].matcher, "idle_prompt");
		assert.deepEqual(hookCommands(fixture.claude, "Notification"), ["feishu-notify --idle"]);
		assert.deepEqual(hookCommands(fixture.claude, "Stop"), ["feishu-notify --done"]);
		assert.equal(readJson(fixture.claude).hooks.Stop[0].matcher, undefined, "Stop 分组不该有 matcher");
	});

	it("命令是裸名（走 PATH），不写死仓库路径 —— R11 的直接落实", () => {
		const fixture = makeHome({ claude: {} });
		runInstall(["--yes"], { home: fixture.home });
		for (const command of [...hookCommands(fixture.claude, "Stop"), ...hookCommands(fixture.claude, "Notification")]) {
			assert.match(command, /^feishu-notify /);
			assert.ok(!command.includes(REPO_ROOT), `hook 命令里不该出现仓库路径：${command}`);
			assert.ok(!command.includes("packages/cli"), `hook 命令里不该出现包内路径：${command}`);
		}
	});

	it("--channel 只在显式给出时才附加（默认不附加，走 activeChannel）", () => {
		const a = makeHome({ claude: {} });
		runInstall(["--yes"], { home: a.home });
		assert.deepEqual(hookCommands(a.claude, "Stop"), ["feishu-notify --done"]);
		assert.ok(!readFileSync(a.claude, "utf8").includes("--channel"));

		const b = makeHome({ claude: {} });
		const result = runInstall(["--yes", "--channel", "claude"], { home: b.home });
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.deepEqual(hookCommands(b.claude, "Stop"), ["feishu-notify --done --channel claude"]);
		assert.deepEqual(hookCommands(b.claude, "Notification"), ["feishu-notify --idle --channel claude"]);
	});

	it("已有旧的 --hook 用法（Stop 的别名）→ 视为等价，不再加一条", () => {
		const fixture = makeHome({ claude: { hooks: { Stop: [{ hooks: [{ command: "feishu-notify --hook", type: "command" }] }] } } });
		const result = runInstall(["--yes"], { home: fixture.home });
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.deepEqual(hookCommands(fixture.claude, "Stop"), ["feishu-notify --hook"]);
		assert.match(result.stdout, /已有等价 hook/);
	});

	it("幂等：连跑两次，第二次没有任何文件变化、也不产生新备份", () => {
		const fixture = makeHome();
		assert.equal(runInstall(["--yes"], { home: fixture.home }).status, 0);
		const afterFirst = treeState(fixture.home);
		const backupsAfterFirst = readdirSync(join(fixture.home, ".claude")).filter((name) => name.includes(".bak.")).length;

		const second = runInstall(["--yes"], { home: fixture.home });
		assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
		assert.equal(treeState(fixture.home), afterFirst, "第二次跑必须一个字节都不变");
		assert.equal(readdirSync(join(fixture.home, ".claude")).filter((name) => name.includes(".bak.")).length, backupsAfterFirst, "不该再产生备份");
		assert.match(second.stdout, /已经接线，无需改动/);
		assert.match(second.stdout, /0 失败/);
	});

	it("坏 JSON → 拒绝写入且一个字节都不动（不自动覆盖）", () => {
		const broken = "{ nope";
		const fixture = makeHome({ claude: broken });
		const result = runInstall(["--yes", "--target", "claude-code"], { home: fixture.home });

		assert.equal(readFileSync(fixture.claude, "utf8"), broken);
		assert.match(result.stdout, /⛔ 不会改动/);
		assert.match(result.stdout, /不可用（invalid-json）/);
		assert.ok(!existsSync(`${fixture.claude}.bak`));
		assert.equal(result.status, 1, "唯一请求的目标被拒 → 退出码 1");
	});

	it("settings.json 是符号链接 → 拒绝（写穿会改到 dotfiles 真身）", () => {
		const fixture = makeHome({ claude: null });
		const real = join(fixture.root, "dotfiles-settings.json");
		writeFileSync(real, `${JSON.stringify(defaultClaudeSettings(), null, 2)}\n`);
		mkdirSync(dirname(fixture.claude), { recursive: true });
		symlinkSync(real, fixture.claude);
		const before = readFileSync(real, "utf8");

		const result = runInstall(["--yes"], { home: fixture.home });
		assert.equal(readFileSync(real, "utf8"), before, "符号链接的目标文件不能被改");
		assert.ok(lstatSync(fixture.claude).isSymbolicLink(), "链接本身也不能被换成普通文件");
		assert.match(result.stdout, /⛔ 不会改动/);
		assert.match(result.stdout, /符号链接/);
	});

	it("hooks 不是对象 → 拒绝并说明期望形状", () => {
		const fixture = makeHome({ claude: { hooks: [] } });
		const result = runInstall(["--yes"], { home: fixture.home });
		assert.match(result.stdout, /hooks 字段不是对象/);
		assert.deepEqual(readJson(fixture.claude).hooks, []);
	});
});

// ---------------------------------------------------------------- opencode

describe("install：opencode", () => {
	it("默认对象形式；包可解析（假 npm）→ 写入 plugins", () => {
		const fixture = makeHome();
		const result = runInstall(["--yes", "--target", "opencode"], { home: fixture.home });
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.deepEqual(readJson(fixture.opencodeFile).plugins, [{ package: "opencode-feishu-notify" }]);
		assert.match(result.stdout, /预检：opencode-feishu-notify@0\.1\.0 可解析/);
		assert.equal(readJson(fixture.opencodeFile).$schema, "https://opencode.ai/config.json", "既有配置字段必须保留");
	});

	it("--opencode-form bare → 写裸字符串（两种形态在解析层等价，但都要能写）", () => {
		const fixture = makeHome();
		const result = runInstall(["--yes", "--opencode-form", "bare"], { home: fixture.home });
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.deepEqual(readJson(fixture.opencodeFile).plugins, ["opencode-feishu-notify"]);
	});

	// ---- G2：--channel 必须落进 options.channel（否则被插件默认值 + 降级静默覆盖）

	it('--channel team → options.channel 写进去（对象形式）', () => {
		const fixture = makeHome();
		const result = runInstall(["--yes", "--target", "opencode", "--channel", "team"], { home: fixture.home });
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.deepEqual(readJson(fixture.opencodeFile).plugins, [
			{ package: "opencode-feishu-notify", options: { channel: "team" } },
		]);
		assert.match(result.stdout, /options\.channel/);
	});

	it("未给 --channel → **不写** options（保持用 activeChannel 的默认语义）", () => {
		const fixture = makeHome();
		runInstall(["--yes", "--target", "opencode"], { home: fixture.home });
		const entry = readJson(fixture.opencodeFile).plugins[0];
		assert.deepEqual(entry, { package: "opencode-feishu-notify" });
		assert.equal(Object.hasOwn(entry, "options"), false, "没指定 channel 时不该凭空造一个 options");
	});

	it("带 --channel 幂等：连跑两次，第二次零变化且明确说已是这个 channel", () => {
		const fixture = makeHome();
		const args = ["--yes", "--target", "opencode", "--channel", "team"];

		const first = runInstall(args, { home: fixture.home });
		assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
		const afterFirst = treeState(fixture.home);

		const second = runInstall(args, { home: fixture.home });
		assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
		assert.equal(treeState(fixture.home), afterFirst, "第二次必须一个字节都不变（含不新增 .bak）");
		assert.match(second.stdout, /options\.channel 已是 "team"/);
		assert.deepEqual(readJson(fixture.opencodeFile).plugins, [
			{ package: "opencode-feishu-notify", options: { channel: "team" } },
		]);
	});

	it("已有 {package} 条目 + --channel → 就地补 options，不追加第二条，其它插件原样保留", () => {
		const fixture = makeHome({
			opencode: { plugins: [{ package: "someone-else" }, { package: "opencode-feishu-notify" }] },
		});
		const result = runInstall(["--yes", "--target", "opencode", "--channel", "team"], { home: fixture.home });
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.deepEqual(readJson(fixture.opencodeFile).plugins, [
			{ package: "someone-else" },
			{ package: "opencode-feishu-notify", options: { channel: "team" } },
		]);
	});

	it("已有条目的其它 options 键不会被 --channel 吃掉", () => {
		const fixture = makeHome({
			opencode: { plugins: [{ package: "opencode-feishu-notify", options: { channel: "old", keep: true } }] },
		});
		runInstall(["--yes", "--target", "opencode", "--channel", "team"], { home: fixture.home });
		assert.deepEqual(readJson(fixture.opencodeFile).plugins, [
			{ package: "opencode-feishu-notify", options: { channel: "team", keep: true } },
		]);
	});

	it("已有条目 + **未给** --channel → 原样不动（不推断用户想删掉 channel）", () => {
		const fixture = makeHome({
			opencode: { plugins: [{ package: "opencode-feishu-notify", options: { channel: "team" } }] },
		});
		const before = treeState(fixture.home);
		const result = runInstall(["--yes", "--target", "opencode"], { home: fixture.home });
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.equal(treeState(fixture.home), before);
		assert.deepEqual(readJson(fixture.opencodeFile).plugins, [
			{ package: "opencode-feishu-notify", options: { channel: "team" } },
		]);
	});

	it("--opencode-form bare + --channel → 升级成对象形式（裸串放不下 options，意图不丢）", () => {
		const fixture = makeHome();
		const result = runInstall(["--yes", "--target", "opencode", "--opencode-form", "bare", "--channel", "team"], {
			home: fixture.home,
		});
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.deepEqual(readJson(fixture.opencodeFile).plugins, [
			{ package: "opencode-feishu-notify", options: { channel: "team" } },
		]);
		assert.match(result.stdout, /裸字符串表达不了 options/);
	});

	it("已有裸字符串条目 + --channel → 就地升级为对象形式（不是再追加一条）", () => {
		const fixture = makeHome({ opencode: { plugins: ["opencode-feishu-notify"] } });
		const result = runInstall(["--yes", "--target", "opencode", "--channel", "team"], { home: fixture.home });
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.deepEqual(readJson(fixture.opencodeFile).plugins, [
			{ package: "opencode-feishu-notify", options: { channel: "team" } },
		]);
	});

	it("--channel 名字不合法 → 用法错误，一个字节都不写", () => {
		const fixture = makeHome();
		const before = treeState(fixture.home);
		const result = runInstall(["--yes", "--target", "opencode", "--channel", "bad name"], { home: fixture.home });
		assert.equal(result.status, 1);
		assert.match(result.stderr, /--channel 不合法/);
		assert.equal(treeState(fixture.home), before, "拒绝时不能留下半份配置");
	});

	it("两种形态互相视为已接线：先对象后裸串不再重复声明", () => {
		const fixture = makeHome({ opencode: { plugins: [{ package: "opencode-feishu-notify" }] } });
		const before = treeState(fixture.home);
		const result = runInstall(["--yes", "--target", "opencode", "--opencode-form", "bare"], { home: fixture.home });
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.equal(treeState(fixture.home), before);
		assert.match(result.stdout, /plugins 里已经有 opencode-feishu-notify/);
	});

	it("包不可解析（假 npm 报 404）→ **明确拒绝写入**并给出下一步，配置文件不被改", () => {
		const fixture = makeHome();
		const before = readFileSync(fixture.opencodeFile, "utf8");
		const result = runInstall(["--yes", "--target", "opencode"], { home: fixture.home, npm: FAIL_NPM });

		assert.equal(readFileSync(fixture.opencodeFile, "utf8"), before, "拒绝写入时配置文件必须一个字节不差");
		assert.match(result.stdout, /⛔ 不会改动：opencode-feishu-notify 还不可解析/);
		assert.match(result.stdout, /npm error code E404/);
		assert.match(result.stdout, /该包尚未发布/);
		assert.match(result.stdout, /--no-verify/);
		const leftovers = readdirSync(dirname(fixture.opencodeFile)).filter((name) => name.includes(".bak."));
		assert.deepEqual(leftovers, [], "拒绝时不写也不备份");
	});

	it("--no-verify 跳过预检（明知可解析但 npm 环境不可用时的逃生口）", () => {
		const fixture = makeHome();
		const result = runInstall(["--yes", "--target", "opencode", "--no-verify"], { home: fixture.home, npm: FAIL_NPM });
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.deepEqual(readJson(fixture.opencodeFile).plugins, [{ package: "opencode-feishu-notify" }]);
	});

	it("--dry-run 不跑 npm 预检（离线也该能看计划）", () => {
		const fixture = makeHome();
		const result = runInstall(["--dry-run", "--target", "opencode"], { home: fixture.home, npm: FAIL_NPM });
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.match(result.stdout, /--dry-run：跳过了写入前的包可解析性预检/);
		assert.deepEqual(readJson(fixture.opencodeFile).plugins, []);
	});

	it("plugins 形状/JSON 坏 → 拒绝且不覆盖", () => {
		const badShape = makeHome({ opencode: { plugins: { package: "x" } } });
		const shapeResult = runInstall(["--yes", "--target", "opencode"], { home: badShape.home });
		assert.match(shapeResult.stdout, /plugins 字段不是数组/);
		assert.deepEqual(readJson(badShape.opencodeFile).plugins, { package: "x" });

		const badJson = makeHome({ opencode: "{ oops" });
		const jsonResult = runInstall(["--yes", "--target", "opencode"], { home: badJson.home });
		assert.equal(readFileSync(badJson.opencodeFile, "utf8"), "{ oops");
		assert.match(jsonResult.stdout, /不可用（invalid-json）/);
	});
});

// ---------------------------------------------------------------- dsh

describe("install：dsh", () => {
	it("默认只探测与计划、**明确拒绝写入**（包还没实现，写进去会让 DSH 起不来）", () => {
		const fixture = makeHome();
		const before = treeState(fixture.home);
		const result = runInstall(["--target", "dsh", "--yes"], { home: fixture.home });

		assert.equal(treeState(fixture.home), before, "拒绝写入必须是零改动");
		assert.match(result.stdout, /⛔ 不会改动：dsh-feishu-notify 尚未实现/);
		assert.match(result.stdout, /（预览）.*dependencies：加/);
		assert.match(result.stdout, /（预览）.*dsh\.profile\.bundles：加/);
		assert.match(result.stdout, /--dsh-dev-dir/);
		assert.equal(result.status, 1, "--target 明确点名却被拒 → 退出码 1");
	});

	it("--dsh-dev-dir 联调：写 link:<绝对路径> 到 dependencies 与 bundles", () => {
		const dev = join(TMP, "dev-dsh");
		mkdirSync(dev, { recursive: true });
		writeFileSync(join(dev, "package.json"), `${JSON.stringify({ name: "dsh-feishu-notify", version: "0.0.1" }, null, 2)}\n`);
		const fixture = makeHome();

		const result = runInstall(["--target", "dsh", "--yes", "--dsh-dev-dir", dev], { home: fixture.home });
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

		const doc = readJson(fixture.profile());
		assert.equal(doc.dependencies["dsh-feishu-notify"], `link:${dev}`);
		assert.deepEqual(doc.dsh.profile.bundles, ["dsh-mnemon", "dsh-feishu-notify"]);
		assert.match(result.stdout, /不代替你跑 dsh\/pnpm|清单写好之后自己执行/);
	});

	it("--dsh-dev-dir 指向的包名不对 → 拒绝并说明", () => {
		const dev = join(TMP, "dev-dsh-wrong");
		mkdirSync(dev, { recursive: true });
		writeFileSync(join(dev, "package.json"), `${JSON.stringify({ name: "someone-else", version: "1.0.0" }, null, 2)}\n`);
		const fixture = makeHome();
		const result = runInstall(["--target", "dsh", "--yes", "--dsh-dev-dir", dev], { home: fixture.home });

		assert.match(result.stdout, /不是 dsh-feishu-notify/);
		assert.equal(result.status, 1);
		assert.equal(readJson(fixture.profile()).dependencies["dsh-feishu-notify"], undefined);
	});

	it("profile 已经接过线 → 无需改动（不是「拒绝」）", () => {
		const fixture = makeHome({
			dsh: { name: "dsh-profile-web", dependencies: { "dsh-feishu-notify": "^0.1.0" }, dsh: { profile: { bundles: ["dsh-feishu-notify"] } } },
		});
		const before = treeState(fixture.home);
		const result = runInstall(["--target", "dsh", "--yes"], { home: fixture.home });

		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.equal(treeState(fixture.home), before);
		assert.match(result.stdout, /已接线（dependencies \+ bundles 都有）/);
	});

	it("多个 profile：一个坏掉只跳过它，另一个照常计划", () => {
		const fixture = makeHome({
			profiles: ["web", "cli"],
			dsh: (name) => (name === "web" ? "{ broken" : { name: "dsh-profile-cli", dependencies: {}, dsh: { profile: { bundles: [] } } }),
		});
		const result = runInstall(["--target", "dsh", "--dry-run"], { home: fixture.home });
		assert.match(result.stdout, /profiles：cli, web/);
		assert.match(result.stdout, /profiles\/web\/package\.json 不可用（invalid-json）/);
		assert.match(result.stdout, /profiles\/cli\/package\.json → dependencies：加/);
	});
});

// ---------------------------------------------------------------- 编排

describe("install：编排与通用约束", () => {
	it("幂等（三目标全跑）：第二次树哈希完全不变", () => {
		const dev = join(TMP, "dev-dsh-idem");
		mkdirSync(dev, { recursive: true });
		writeFileSync(join(dev, "package.json"), `${JSON.stringify({ name: "dsh-feishu-notify", version: "0.0.1" }, null, 2)}\n`);
		const fixture = makeHome();
		const args = ["--yes", "--dsh-dev-dir", dev];

		const first = runInstall(args, { home: fixture.home });
		assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
		const afterFirst = treeState(fixture.home);
		for (const file of [fixture.claude, fixture.opencodeFile, fixture.profile()]) assert.match(readFileSync(file, "utf8"), /feishu-notify/);

		const second = runInstall(args, { home: fixture.home });
		assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
		assert.equal(treeState(fixture.home), afterFirst, "第二次必须零变化（含不新增 .bak）");
		assert.match(second.stdout, /3 就绪 \/ 0 被拒 \/ 0 跳过 \/ 0 失败/);
	});

	it("单目标失败不影响其它目标：一个目录不可写 → 它失败，另一个照样写入", () => {
		const fixture = makeHome();
		const opencodeDir = dirname(fixture.opencodeFile);
		chmodSync(opencodeDir, 0o555); // 目录不可写：临时文件建不出来 → apply 阶段失败
		try {
			const result = runInstall(["--yes", "--skip", "dsh"], { home: fixture.home });
			assert.equal(result.status, 1, "有失败 → 退出码 1");
			assert.match(result.stdout, /✓ claude-code\s+已写入/);
			assert.match(result.stdout, /✗ opencode\s+失败/);
			assert.match(result.stdout, /EACCES|permission denied|操作不被允许/i);
			// 成功那个目标仍然完成，并且给了它自己的回滚指令
			assert.deepEqual(hookCommands(fixture.claude, "Stop"), [USER_STOP_HOOK, "feishu-notify --done"]);
			assert.match(result.stdout, /cp -p ~\/\.claude\/settings\.json\.bak\./);
			// 失败目标没被改
			assert.deepEqual(readJson(fixture.opencodeFile).plugins, []);
		} finally {
			chmodSync(opencodeDir, 0o755);
		}
	});

	it("--skip / --target：跳过与白名单都只影响选择，不改变计划的判定", () => {
		const fixture = makeHome();
		const skipped = runInstall(["--dry-run", "--skip", "dsh,opencode"], { home: fixture.home });
		assert.match(skipped.stdout, /（按要求跳过：dsh, opencode）/);
		assert.ok(!skipped.stdout.includes("DSH (Cordis)\n"), "被跳过的目标不参与探测表");
		assert.equal(skipped.status, 0);

		const only = runInstall(["--dry-run", "--target", "claude"], { home: fixture.home });
		assert.match(only.stdout, /▸ Claude Code/);
		assert.ok(!only.stdout.includes("▸ opencode"));

		const both = runInstall(["--target", "claude", "--skip", "dsh"], { home: fixture.home });
		assert.equal(both.status, 1, "--target 与 --skip 互斥");
		assert.match(both.stderr, /只能给一个|互斥/);

		const unknown = runInstall(["--target", "ghost"], { home: fixture.home });
		assert.equal(unknown.status, 1);
		assert.match(unknown.stderr, /未知目标：ghost/);
	});

	it("非交互环境不给 --yes → 拒绝并要求确认（不挂住、不偷偷写）", () => {
		const fixture = makeHome();
		const before = treeState(fixture.home);
		const result = spawnSync(process.execPath, [CLI, "install"], { encoding: "utf8", env: envFor(fixture.home), input: "" });

		assert.equal(result.status, 1);
		assert.match(result.stderr, /非交互环境/);
		assert.match(result.stderr, /--yes/);
		assert.equal(treeState(fixture.home), before);
	});

	it("--dry-run 的计划与真跑写入的内容一致（同一份数据，不是另写一套描述）", () => {
		const fixture = makeHome({ claude: {} });
		const dry = runInstall(["--dry-run", "--target", "claude"], { home: fixture.home });
		assert.equal(dry.status, 0, dry.stderr);
		const planned = [...dry.stdout.matchAll(/^\s{10}\+ (\{.*\})$/gm)].map((match) => match[1]);
		assert.equal(planned.length, 2, `dry-run 应打印两个分组：\n${dry.stdout}`);

		assert.equal(runInstall(["--yes", "--target", "claude"], { home: fixture.home }).status, 0);
		const doc = readJson(fixture.claude);
		assert.deepEqual(planned, [JSON.stringify(doc.hooks.Notification[0]), JSON.stringify(doc.hooks.Stop[0])], "dry-run 里的 after 片段必须逐字节等于真跑写进去的内容");
	});

	it("install --help 列出全部开关；未知参数报用法错误", () => {
		const help = spawnSync(process.execPath, [CLI, "install", "--help"], { encoding: "utf8", env: envFor(TMP) });
		assert.equal(help.status, 0);
		for (const flag of ["--dry-run", "--yes", "--target", "--skip", "--channel", "--opencode-form", "--dsh-dev-dir", "--no-verify"]) {
			assert.match(help.stdout, new RegExp(flag.replace(/[-]/g, "\\-")));
		}

		const bad = spawnSync(process.execPath, [CLI, "install", "--nope"], { encoding: "utf8", env: envFor(TMP) });
		assert.equal(bad.status, 1);
		assert.match(bad.stderr, /不认识这些参数：--nope/);
	});
});

// ---------------------------------------------------------------- 模块级单元（不 spawn 真 npm）

describe("install：模块级单元（注入 spawn，不联网）", () => {
	const okSpawn = () => ({ status: 0, stdout: '"1.2.3"\n', stderr: "", error: undefined });
	const failSpawn = () => ({ status: 1, stdout: "", stderr: "npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/x - Not found\nnpm warn Ignoring workspaces for specified package(s)\n" });

	it("checkPublished：成功/404/找不到 npm/超时 四种结果都不抛", () => {
		const ok = checkPublished({ env: {}, spawn: okSpawn });
		assert.equal(ok.ok, true);
		assert.equal(ok.version, "1.2.3");
		assert.match(ok.message, /可解析/);

		const fail = checkPublished({ env: {}, spawn: failSpawn });
		assert.equal(fail.ok, false);
		assert.match(fail.message, /退出码 1/);
		assert.match(fail.message, /npm error code E404/);
		assert.ok(!fail.message.includes("Ignoring workspaces"), "warn/http 噪音不该进结论");

		const missing = checkPublished({ env: {}, spawn: () => ({ error: Object.assign(new Error("nope"), { code: "ENOENT" }) }) });
		assert.equal(missing.ok, false);
		assert.match(missing.message, /找不到 npm/);
		assert.match(missing.message, /FEISHU_NOTIFY_NPM/);

		const slow = checkPublished({ env: {}, spawn: () => ({ error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }) }) });
		assert.match(slow.message, /超时/);
	});

	it("entryTarget：两种写法归一化成同一个包名，认不出的返回 null（原样保留）", () => {
		assert.equal(entryTarget("opencode-feishu-notify"), "opencode-feishu-notify");
		assert.equal(entryTarget({ package: "opencode-feishu-notify" }), "opencode-feishu-notify");
		assert.equal(entryTarget({ package: "x", options: {} }), "x");
		assert.equal(entryTarget(42), null);
		assert.equal(entryTarget({ nope: true }), null);
		assert.equal(entryTarget(null), null);
		assert.equal(ocPackage, "opencode-feishu-notify", "包名常量与写入内容的来源必须一致");
	});

	it("commandFor：--channel 只在显式给出时附加；hook 命令是裸名（R11）", () => {
		assert.equal(claudeCommandFor("--idle"), "feishu-notify --idle");
		assert.equal(claudeCommandFor("--done", "claude"), "feishu-notify --done --channel claude");
		assert.ok(!claudeCommandFor("--idle").includes("/"));
	});

	it("listProfiles：只认 `profiles/*/package.json`，跳过 node_modules 与点开头目录", () => {
		const fixture = makeHome({ profiles: ["web"] });
		const profilesRoot = join(fixture.home, ".dsh", "profiles");
		mkdirSync(join(profilesRoot, "node_modules"), { recursive: true });
		writeFileSync(join(profilesRoot, "node_modules", "package.json"), "{}\n");
		mkdirSync(join(profilesRoot, ".hidden"), { recursive: true });
		writeFileSync(join(profilesRoot, ".hidden", "package.json"), "{}\n");
		mkdirSync(join(profilesRoot, "empty"), { recursive: true });

		const names = listProfiles({ HOME: fixture.home }).map((profile) => profile.name);
		assert.deepEqual(names, ["web"]);
	});
});

// ---------------------------------------------------------------- 隔离守卫

describe("install：隔离守卫", () => {
	it("所有写入都发生在临时 HOME 内；真实 HOME 与真实 ~/.config/feishu-notify 未被触碰", () => {
		assert.ok(TMP.startsWith(tmpdir()) || TMP.startsWith("/private/var/folders") || TMP.startsWith("/var/folders"));
		const realHome = process.env.HOME ?? "/nonexistent";
		assert.ok(!TMP.startsWith(realHome));
		assert.ok(!existsSync(join(realHome, ".config", "feishu-notify", "config.json.bak")), "本工具不写真实配置目录");
	});

	it("探测到的路径必须全在 HOME 之下（不含被测者本机的真实 agent 配置）", () => {
		const fixture = makeHome();
		const result = runInstall(["--dry-run"], { home: fixture.home });
		const paths = [...result.stdout.matchAll(/~\/[^\s]+/g)].map((match) => match[0]);
		assert.ok(paths.length > 0);
		for (const path of paths) assert.ok(path.startsWith("~/"), `输出里出现了非 HOME 相对路径：${path}`);
	});
});
