/**
 * lib/install-targets/opencode.mjs — 在 `~/.config/opencode/opencode.json` 的 `plugins` 里声明插件
 *
 * ## 两种写法的实测结论（原计划里的"待实测"已被消解）
 *
 * 任务书原文："对象形式 `{"package": …}` 与裸字符串两种都实现、由 flag 选择，因为**哪种能被解析
 * 尚未实测**"。本题实测了本机在跑的 opencode 2.0.32（`@opencode/cli` 的编译产物里含源码文本），
 * 结论是 **两种写法在解析层完全等价**，因此"选哪种"不再是正确性问题，只是风格问题：
 *
 *   1. 配置键就是 `plugins`（`Config.Info` 里 `plugins: Array<string | {package, options}>`，
 *      描述为 "Ordered plugin enablement directives and external package declarations"）。
 *   2. 归一化函数把两者压成同一种指令：
 *        `typeof entry !== "string"` → `{ target: entry.package, options: entry.options ?? {} }`
 *        裸字符串                    → `{ target: entry, options: {} }`
 *      于是 `"opencode-feishu-notify"` 与 `{"package":"opencode-feishu-notify"}` 产出**同一个** target。
 *   3. 裸字符串还有一个额外语义：**以 `-` 开头表示"移除"**（`"-foo"` = 移除 foo，`"-*"` 清空）。
 *      我们的包名不带 `-`，但这条意味着**直接改配置文本时必须避免写出 `-` 前缀**。
 *   4. 非绝对路径的 target 会被当作**包名交给包管理器安装/解析**
 *      （`install !== false` → `add(target)`，否则先 `resolve(target)`；解析不出来是 `pending` 状态，
 *      随后带 install 再试一次），失败只是让该插件处于 failed 状态、**不会让 opencode 起不来**。
 *      绝对路径的 target 必须是**目录**（指向文件的会被丢弃并告警）。
 *
 * **仍然没实测的是"注册表上真有这个包并且能装上"** —— 那需要包已发布。所以写入之前会先跑一次
 * `npm view <name> version`：解析不出来就**拒绝写入**并给出下一步（tasks 原话："不要留下一半改动
 * 的配置"）。`--no-verify` 可以跳过这次预检。
 *
 * ## 默认写法
 *
 * 默认用**对象形式**（`{"package": …}`）：语义最明确、且留了 `options` 的位置。要改风格用
 * `--opencode-form bare`。两种写法都实现、都由测试锁定，所以这不是"二选一放弃另一个"。
 */

import { statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { cloneJson, isPlainObject, makePlan, pathsFromEnv, prettyPath, readJsonFile, serializeJson, symlinkInfo } from "./common.mjs";

export const id = "opencode";
export const label = "opencode";
export const PACKAGE_NAME = "opencode-feishu-notify";

/** 写入形态：`object`（默认）或 `bare`（裸字符串）。两者解析等价，见文件头。 */
export const FORMS = ["object", "bare"];
export const DEFAULT_FORM = "object";

export const DEFAULT_NPM = "npm";
export const NPM_TIMEOUT_MS = 20_000;

export function configPath(env = process.env) {
	return join(pathsFromEnv(env).xdg, "opencode", "opencode.json");
}

export function configDir(env = process.env) {
	return join(pathsFromEnv(env).xdg, "opencode");
}

/** 从 `plugins` 的条目里取出"包名/路径"；认不出的形状返回 null（原样保留，只提示） */
export function entryTarget(entry) {
	if (typeof entry === "string") return entry;
	if (isPlainObject(entry) && typeof entry.package === "string") return entry.package;
	return null;
}

export function entryFor(form = DEFAULT_FORM) {
	if (form === "bare") return PACKAGE_NAME;
	if (form === "object") return { package: PACKAGE_NAME };
	throw new Error(`内部错误：未知的 opencode 写入形态 ${form}`);
}

function dirExists(dir) {
	try {
		return statSync(dir).isDirectory();
	} catch {
		return false;
	}
}

export function detect({ env = process.env } = {}) {
	const file = configPath(env);
	if (readJsonFile(file).exists || symlinkInfo(file)) return { found: true, path: file, detail: prettyPath(file, env) };
	if (dirExists(configDir(env))) {
		return { found: false, path: file, detail: `${prettyPath(configDir(env), env)} 在，但没有 opencode.json（opencode 还没写过自己的配置）` };
	}
	return { found: false, path: file, detail: `没有 ${prettyPath(configDir(env), env)}（opencode 没装，或没跑过）` };
}

/**
 * 预检：这个包在注册表上能解析吗？
 * 走 `npm view <name> version --json`（可用 `FEISHU_NOTIFY_NPM` 换 npm 可执行文件，测试用）。
 * **永不抛** —— 失败都是返回值，由调用方决定是拒绝写入还是继续。
 */
export function checkPublished({ env = process.env, spawn = spawnSync, timeoutMs = NPM_TIMEOUT_MS, name = PACKAGE_NAME } = {}) {
	const npm = env.FEISHU_NOTIFY_NPM || DEFAULT_NPM;
	let result;
	try {
		// --workspaces=false：在 monorepo 里跑 npm 会多打一行 "Ignoring workspaces…"，那是噪音不是结论
		result = spawn(npm, ["view", name, "version", "--json", "--workspaces=false"], { encoding: "utf8", timeout: timeoutMs, env, stdio: ["ignore", "pipe", "pipe"] });
	} catch (error) {
		return { ok: false, name, message: `调用 ${npm} 失败：${error?.message ?? error}` };
	}
	if (result.error) {
		const code = result.error.code;
		if (code === "ENOENT") return { ok: false, name, message: `找不到 npm（可用 FEISHU_NOTIFY_NPM 指定路径）：${npm}` };
		if (code === "ETIMEDOUT" || result.signal) return { ok: false, name, message: `npm view 超时（${timeoutMs}ms，多半是网络/代理不可达）` };
		return { ok: false, name, message: `调用 ${npm} 失败：${result.error.message}` };
	}
	if (result.status !== 0) {
		return { ok: false, name, message: `npm view ${name} 退出码 ${result.status}：${compactNpmError(result.stderr)}` };
	}

	const raw = (result.stdout ?? "").trim();
	let version;
	try {
		const parsed = JSON.parse(raw);
		version = Array.isArray(parsed) ? parsed[parsed.length - 1] : parsed;
	} catch {
		version = raw.replace(/^"|"$/g, "");
	}
	if (typeof version !== "string" || version.trim() === "") {
		return { ok: false, name, message: `npm view ${name} 没有给出可用版本号（输出：${raw.slice(0, 120)}）` };
	}
	return { ok: true, name, version: version.trim(), message: `${name}@${version.trim()} 可解析（npm view 实测）` };
}

/** 从 npm 的 stderr 里挑出真正的结论（丢掉 warn/http 这类噪音） */
function compactNpmError(stderr) {
	const lines = String(stderr ?? "")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	const errors = lines.filter((line) => line.startsWith("npm error"));
	const chosen = (errors.length > 0 ? errors.slice(0, 2) : lines).join("；");
	return chosen.replace(/\s+/g, " ").slice(0, 220);
}

/** 包还不可解析 → 把"计划"改成"拒绝写入"，理由与下一步都写清楚 */
export function refuseUnpublished(plan, check) {
	return makePlan({
		...plan,
		status: "refuse",
		files: [],
		reason:
			`${check.name} 还不可解析（${check.message}）。**没有改动任何文件**：` +
			`往 plugins 里写一个解析不出来的包名，只会让 opencode 记一条 failed 插件。`,
		nextSteps: [
			`该包尚未发布 → 等 packages/opencode 发布后再跑 install；手动接线方式见 README 的 Wiring 章节`,
			`已知包能被解析但仍要写入：install --target opencode --no-verify`,
		],
	});
}

/** 调用方（orchestrator）在真正要写之前调它；--dry-run 与 --no-verify 会跳过 */
export async function preflight({ plan, env = process.env, spawn = spawnSync } = {}) {
	if (plan.status !== "ok") return plan;
	const check = checkPublished({ env, spawn });
	if (!check.ok) return refuseUnpublished(plan, check);
	return makePlan({ ...plan, notes: [...plan.notes, `预检：${check.message}`] });
}

export function buildPlan({ env = process.env, options = {} } = {}) {
	const file = configPath(env);
	const detection = detect({ env });
	const form = options.opencodeForm ?? DEFAULT_FORM;
	const base = { id, label, detect: detection };
	const refuse = (reason, nextSteps = []) => makePlan({ ...base, status: "refuse", reason, nextSteps });
	const skip = (reason, nextSteps = []) => makePlan({ ...base, status: "skip", reason, nextSteps });

	if (!detection.found) {
		return skip(detection.detail, ["先装上 opencode 并跑一次（它会写 ~/.config/opencode/opencode.json），再回来跑 install"]);
	}

	const link = symlinkInfo(file);
	if (link) {
		return refuse(
			`${prettyPath(file, env)} 是符号链接（指向 ${link.target ?? "<读不到>"}）。本工具不写符号链接（理由见 lib/install-targets/common.mjs 的文件头）。`,
			[`把它换成普通文件（把 dotfiles 里那份拷回来）后重跑 install，或直接手改 dotfiles 那份`],
		);
	}

	const parsed = readJsonFile(file);
	if (!parsed.ok) {
		return refuse(`${prettyPath(file, env)} 不可用（${parsed.reason}）：${parsed.message}`, [
			"先修好这份 JSON（本工具**不会**自动覆盖一个坏文件），再跑 install",
		]);
	}

	const doc = parsed.value;
	if (doc.plugins !== undefined && !Array.isArray(doc.plugins)) {
		return refuse(`opencode.json 的 plugins 字段不是数组（当前 ${isPlainObject(doc.plugins) ? "对象" : typeof doc.plugins}）`, [
			"plugins 应为数组，条目是 `\"包名\"` 或 `{ \"package\": \"包名\", \"options\": {} }`；修正后重跑 install",
		]);
	}

	const entries = doc.plugins ?? [];
	const notes = [];
	const existing = entries.find((entry) => entryTarget(entry) === PACKAGE_NAME);
	if (existing !== undefined) {
		notes.push(`plugins 里已经有 ${PACKAGE_NAME}（原文 ${JSON.stringify(existing)}），不再重复声明`);
		return makePlan({ ...base, status: "noop", notes });
	}

	const removal = entries.find((entry) => entryTarget(entry) === `-${PACKAGE_NAME}`);
	if (removal !== undefined) {
		notes.push(`⚠ plugins 里有移除指令 ${JSON.stringify(removal)}（裸字符串以 \`-\` 开头表示**移除**）：先删掉它，否则依赖顺序决定谁生效`);
	}
	const unrecognized = entries.filter((entry) => entryTarget(entry) === null);
	if (unrecognized.length > 0) {
		notes.push(`plugins 里有 ${unrecognized.length} 条本工具认不出的条目（原样保留）：${JSON.stringify(unrecognized)}`);
	}

	const entry = entryFor(form);
	const next = cloneJson(doc);
	next.plugins = [...entries, entry];
	notes.push(
		"写法：两种形态在解析层等价（实测 opencode 2.0.32：裸字符串与 {package} 归一化成同一个 target）；" +
			`本次写的是 ${form === "bare" ? "裸字符串" : "对象形式"}，换风格用 --opencode-form ${form === "bare" ? "object" : "bare"}`,
	);
	notes.push("写入前会用 `npm view` 确认这个包能被解析；解析不出来就拒绝写入（不给 opencode 留一条 failed 插件）");

	return makePlan({
		...base,
		status: "ok",
		steps: [{ title: `plugins：追加 ${JSON.stringify(entry)}`, before: JSON.stringify(entries), after: JSON.stringify(next.plugins) }],
		notes,
		files: [{ path: file, before: parsed.text, after: serializeJson(next) }],
	});
}
