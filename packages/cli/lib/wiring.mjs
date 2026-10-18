/**
 * lib/wiring.mjs — 接线健康自检（prd R11 / AC10）
 *
 * ## 要诊断的事故（2026-10-18，真实发生）
 *
 * 仓库改名 → `~/.local/bin/feishu-notify-cli` 变成**悬空符号链接** →
 * 发送端找不到解析器 → `exit 2` → **通知静默失效**（用户只看到"没收到卡片"，
 * 而发送端自己的报错在 hook 环境里没人看）。事后由子代理复现并修复。
 *
 * 教训：`feishu-notify` 能跑、`feishu-notify-cli` 能跑，**都不代表接线健康** ——
 * hook 调用的是发送端，而发送端要再找到解析器、再找到 Node ≥ 18 才能真正把卡片发出去。
 * 任何一环断掉都是"静默"的。所以这里把这条链**逐环**检查一遍，并把断点与修法打印出来。
 *
 * ## 分类规则（顺序即真相来源）
 *
 * 用 `lstat` 判"这个路径本身是什么"，用 `stat`/`access` 跟随判"它指向的东西在不在、能不能执行"
 * （`.trellis/spec/opencode-plugin/filesystem-truth.md`：`stat` 会跟随符号链接，
 * 因此**一个悬空链接用 `stat` 看会像"不存在"，而用 `lstat` 才能看出"这是个指向虚无的链接"**）。
 *
 *   ok               存在、不是目录、可执行
 *   dangling-symlink 是链接，但目标不存在  ← 本次事故的形态
 *   not-executable   存在但不可执行（少 x 位）
 *   directory        是个目录
 *   missing          不存在
 *
 * ## 顺序与发送端一致（bin/feishu-notify 的 find_cli）
 *
 *   解析器：$FEISHU_NOTIFY_CLI → 发送端同目录 → $HOME/.local/bin → PATH
 *   Node  ：$FEISHU_NOTIFY_NODE → PATH 的 node → /usr/local/bin → /opt/homebrew/bin → nvm
 *
 * `ok` 的判定是"至少有一个可用项"。但**坏掉的候选也会被逐条打印**：悬空的
 * `~/.local/bin/feishu-notify-cli` 会**被发送端跳过**（`[ -x ]` 失败）而落到后面的候选上，
 * 今天能跑，明天 PATH 一变就静默失效 —— 这正是需要提前修掉的隐患。
 */

import { accessSync, constants, lstatSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export const NODE_MIN_MAJOR = 18;

const KIND_TEXT = {
	ok: "可执行",
	missing: "不存在",
	"dangling-symlink": "悬空符号链接",
	"not-executable": "存在但不可执行（缺 x 位）",
	directory: "是目录，不是可执行文件",
	unknown: "状态未知",
};

/**
 * 给一个**具体路径**分类。永不抛。
 *
 * 符号链接一律先 `lstat` 认出"它是链接"、`readlink` 读出指向，再单独跟随看目标：
 * 目标不存在就是 `dangling-symlink`（**事故形态**）；只跟随的话，悬空链接会被误报成"不存在"，
 * 而"不存在"与"指向虚无的链接"需要的修法是不同的（前者要装，后者要删/重指）。
 *
 * @returns {{path, kind, target?, detail}}
 */
export function classify(path) {
	const stat = lstatSync(path, { throwIfNoEntry: false });
	if (!stat) return { path, kind: "missing", detail: KIND_TEXT.missing };

	if (stat.isSymbolicLink()) {
		let target = null;
		try {
			target = readlinkSync(path);
		} catch {
			/* 读不到就只报"是链接" */
		}

		let follow = null;
		try {
			follow = statSync(path, { throwIfNoEntry: false }) ?? null;
		} catch {
			follow = null; // ELOOP 之类：同样当作不可用
		}
		if (follow === null) {
			return { path, kind: "dangling-symlink", target, detail: `悬空符号链接 → ${target ?? "<读不到目标>"}（目标不存在）` };
		}
		if (follow.isDirectory()) return { path, kind: "directory", target, detail: `符号链接 → ${target ?? "?"}（是个目录）` };
		if (!isExecutable(path)) return { path, kind: "not-executable", target, detail: `符号链接 → ${target ?? "?"}，但不可执行` };
		return { path, kind: "ok", target, detail: `符号链接 → ${target ?? "?"}` };
	}

	if (stat.isDirectory()) return { path, kind: "directory", detail: KIND_TEXT.directory };
	if (!isExecutable(path)) return { path, kind: "not-executable", detail: `${KIND_TEXT["not-executable"]}（mode ${(stat.mode & 0o777).toString(8)}）` };
	return { path, kind: "ok", detail: KIND_TEXT.ok };
}

function isExecutable(path) {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * PATH 上按顺序找同名可执行文件。
 * 自己扫目录而不是 `which`：`which` 只回"能找到的那个"，看不到"某个目录下还有一条悬空链接"。
 */
function pathCandidates(name, env) {
	const entries = String(env.PATH ?? "").split(delimiter).filter(Boolean);
	const seen = new Set();
	const found = [];
	for (const entry of entries) {
		if (seen.has(entry)) continue;
		seen.add(entry);
		if (found.length >= 24) break; // 够用了；PATH 超长时不必遍历到底
		found.push(join(entry, name));
	}
	return found;
}

/** 按路径去重（保序）：同一个文件可能被两条不同的搜索规则命中，重复打印只会让诊断更难读 */
function dedupeByPath(paths) {
	const seen = new Set();
	const unique = [];
	for (const path of paths) {
		if (seen.has(path)) continue;
		seen.add(path);
		unique.push(path);
	}
	return unique;
}

function nvmCandidates(home) {
	try {
		return readdirSync(join(home, ".nvm", "versions", "node"))
			.sort()
			.map((version) => join(home, ".nvm", "versions", "node", version, "bin", "node"));
	} catch {
		return [];
	}
}

/** Node 版本号（只看 major 是否 ≥ 18；调用失败返回 null） */
function nodeMajor(path, spawn) {
	try {
		const result = spawn(path, ["-e", "process.stdout.write(String(process.versions.node))"], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "pipe"] });
		if (result.error || result.status !== 0) return null;
		const raw = (result.stdout ?? "").trim();
		const major = Number(raw.split(".")[0]);
		return Number.isFinite(major) ? { major, version: raw } : null;
	} catch {
		return null;
	}
}

/**
 * 接线自检。**永不抛**（doctor 的主流程不能被它拖垮）。
 *
 * @returns {{
 *   ok: boolean,
 *   sender: { ok, path: string|null, candidates: object[] },
 *   resolver: { ok, path: string|null, candidates: object[] },
 *   node: { ok, path: string|null, version: string|null, required: number, candidates: object[], self: {path, version} },
 *   fixes: string[],
 * }}
 */
export function checkWiring({ env = process.env, selfPath = process.argv[1], spawn = spawnSync } = {}) {
	const home = typeof env.HOME === "string" && env.HOME.trim() !== "" ? env.HOME : homedir();
	const selfDir = selfPath ? dirname(resolve(selfPath)) : process.cwd();

	const report = {
		ok: false,
		sender: { ok: false, path: null, candidates: [] },
		resolver: { ok: false, path: null, candidates: [] },
		node: { ok: false, path: null, version: null, required: NODE_MIN_MAJOR, candidates: [], self: { path: process.execPath, version: process.version } },
		fixes: [],
	};

	try {
		// ---- 发送端（hook 直接调用的那个）
		const senderCandidates = dedupeByPath([join(selfDir, "feishu-notify"), join(home, ".local", "bin", "feishu-notify"), ...pathCandidates("feishu-notify", env)]);
		report.sender.candidates = senderCandidates.map((path, index) => ({ ...classify(path), order: index + 1 }));
		const sender = report.sender.candidates.find((candidate) => candidate.kind === "ok");
		report.sender.ok = sender !== undefined;
		report.sender.path = sender?.path ?? null;

		// ---- 解析器（发送端再去找它；顺序照抄 bash 的 find_cli）
		const envCli = typeof env.FEISHU_NOTIFY_CLI === "string" && env.FEISHU_NOTIFY_CLI.trim() !== "" ? env.FEISHU_NOTIFY_CLI : null;
		const senderDir = sender ? dirname(sender.path) : selfDir;
		const resolverCandidates = dedupeByPath([
			...(envCli ? [envCli] : []),
			join(senderDir, "feishu-notify-cli"),
			join(home, ".local", "bin", "feishu-notify-cli"),
			...pathCandidates("feishu-notify-cli", env),
		]);
		report.resolver.candidates = resolverCandidates.map((path, index) => ({ ...classify(path), order: index + 1 }));
		const resolver = report.resolver.candidates.find((candidate) => candidate.kind === "ok");
		report.resolver.ok = resolver !== undefined;
		report.resolver.path = resolver?.path ?? null;

		// ---- Node ≥ 18（发送端要它来跑解析器）
		const nodeCandidates = [
			...(env.FEISHU_NOTIFY_NODE ? [env.FEISHU_NOTIFY_NODE] : []),
			...(pathCandidates("node", env).slice(0, 3)),
			"/usr/local/bin/node",
			"/opt/homebrew/bin/node",
			...nvmCandidates(home),
		];
		const seenNode = new Set();
		for (const path of nodeCandidates) {
			if (seenNode.has(path)) continue;
			seenNode.add(path);
			const classified = classify(path);
			if (classified.kind !== "ok") {
				report.node.candidates.push({ ...classified, major: null });
				continue;
			}
			const version = nodeMajor(path, spawn);
			report.node.candidates.push({ ...classified, major: version?.major ?? null, version: version?.version ?? null });
			if (version && version.major >= NODE_MIN_MAJOR) {
				report.node.ok = true;
				report.node.path = path;
				report.node.version = version.version;
				break;
			}
		}

		report.ok = report.sender.ok && report.resolver.ok && report.node.ok;
		report.fixes = buildFixes(report, env);
	} catch (error) {
		report.error = error instanceof Error ? error.message : String(error);
	}

	return report;
}

function buildFixes(report, env) {
	const fixes = [];
	const home = typeof env.HOME === "string" && env.HOME.trim() !== "" ? env.HOME : homedir();

	const brokenResolver = report.resolver.candidates.filter((candidate) => candidate.kind === "dangling-symlink");
	for (const candidate of brokenResolver) {
		fixes.push(
			`${candidate.path} 是悬空符号链接（→ ${candidate.target ?? "?"}）：删掉或重装 — ` +
				`\`rm ${candidate.path}\` 然后 \`npm i -g feishu-notify-cli\``,
		);
	}
	for (const candidate of report.resolver.candidates.filter((item) => item.kind === "not-executable")) {
		fixes.push(`${candidate.path} 不可执行：\`chmod +x ${candidate.path}\`（或重装 npm 包）`);
	}

	if (!report.resolver.ok) {
		fixes.push(
			`发送端找不到解析器 feishu-notify-cli：装一次即可 — \`npm i -g feishu-notify-cli\`` +
				`（全局安装会在同一个 bin 目录里产出两个命令，发送端按"同目录"找到解析器）`,
		);
		fixes.push(`临时指定：\`FEISHU_NOTIFY_CLI=/path/to/feishu-notify-cli feishu-notify "测试"\``);
	}

	if (!report.sender.ok) {
		fixes.push(
			`找不到发送端 feishu-notify（${join(home, ".local", "bin")} 与 PATH 上都没有）：` +
				`\`npm i -g feishu-notify-cli\`；Claude Code 的 hook 命令里写的若是绝对路径，请同步改掉`,
		);
	}

	if (!report.node.ok) {
		const tooOld = report.node.candidates.filter((candidate) => candidate.major !== null && candidate.major < NODE_MIN_MAJOR);
		fixes.push(
			`找不到 Node ≥ ${NODE_MIN_MAJOR}（解析器是 Node 脚本）：装一个，或用 \`FEISHU_NOTIFY_NODE=/path/to/node\` 指定` +
				(tooOld.length > 0 ? `（PATH 上这些太旧：${tooOld.map((item) => `${item.path} v${item.major}`).join(", ")}）` : ""),
		);
	}

	if (report.ok) fixes.push("接线健康：发送端、解析器、Node 三环齐全。");
	return fixes;
}

/** doctor 的一段人类可读输出（返回待打印的行；不自己写 io，便于测试断言） */
export function renderWiring(wiring) {
	const lines = ["  ▸ 接线自检（真实 hook 走的那条链：发送端 → 解析器 → Node ≥ 18）…"];
	const mark = (ok) => (ok ? "✓" : "✗");

	const sender = wiring.sender;
	lines.push(`    ${mark(sender.ok)} 发送端        ${sender.path ?? "<找不到>"}`);
	if (!sender.ok) {
		for (const candidate of sender.candidates.filter((item) => item.kind !== "missing")) {
			lines.push(`        ✗ ${candidate.path}：${candidate.detail}`);
		}
	}

	const resolver = wiring.resolver;
	lines.push(`    ${mark(resolver.ok)} 解析器        ${resolver.path ?? "<找不到>"}`);
	// 坏候选即使被跳过也要打印：今天靠后面的候选兜住了，明天 PATH 一变就是静默失效
	for (const candidate of resolver.candidates.filter((item) => item.kind !== "ok" && item.kind !== "missing")) {
		lines.push(`        ✗ ${candidate.path}：${candidate.detail}`);
	}

	const node = wiring.node;
	lines.push(`    ${mark(node.ok)} Node ≥ ${node.required}    ${node.path ? `${node.path}（${node.version}）` : "<找不到>"}`);
	lines.push(`        （doctor 自己跑在 ${node.self.version} 上，但 hook 环境的 PATH 可能不同）`);

	if (wiring.error) lines.push(`    ⚠ 接线自检没跑完：${wiring.error}`);

	// 坏候选（被跳过的那种）也要给修法：它今天被后面的候选兜住了，明天 PATH 一变就是静默失效
	const broken = [...sender.candidates, ...resolver.candidates].filter((candidate) => candidate.kind !== "ok" && candidate.kind !== "missing");
	if (!wiring.ok || broken.length > 0) {
		lines.push("    修复：");
		for (const fix of wiring.fixes) lines.push(`      - ${fix}`);
	}
	if (!wiring.ok) {
		lines.push("    （接线自检不影响 doctor 的退出码：hook 的 PATH/HOME 与你的 shell 不同，这里给的是指引）");
	}
	return lines;
}
