/**
 * lib/install-targets/npm-check.mjs — 「这个包在注册表上能解析吗」的预检（opencode 与 dsh 共用）
 *
 * 两个目标都要在**写盘之前**回答同一个问题：`<PACKAGE_NAME>` 现在能不能被解析到。
 * 抽出这一份的理由不是省几行，而是**两边不能漂**：只要预检口径变了（换成别的 npm、
 * 换超时、换"怎么算可解析"），两个目标必须同时变，否则会出现"一个放行、一个拒绝"的接线。
 *
 * 判定只用一条命令：`npm view <name> version --json`。语义就是"注册表上有没有这个包"，
 * 而不是"我这里装没装" —— 因此**包一发布，两个目标都无需改代码就能写入**（这是本文件存在的意义）。
 *
 * **永不抛** —— 失败都是返回值，由调用方决定是拒绝写入还是继续。
 */

import { spawnSync } from "node:child_process";

export const DEFAULT_NPM = "npm";
export const NPM_TIMEOUT_MS = 20_000;

/**
 * 预检：`name` 在注册表上能解析吗？
 * 走 `npm view <name> version --json`（可用 `FEISHU_NOTIFY_NPM` 换 npm 可执行文件，测试用）。
 */
export function checkPublished({ env = process.env, spawn = spawnSync, timeoutMs = NPM_TIMEOUT_MS, name } = {}) {
	if (typeof name !== "string" || name.trim() === "") throw new Error("内部错误：checkPublished 需要包名");
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
export function compactNpmError(stderr) {
	const lines = String(stderr ?? "")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	const errors = lines.filter((line) => line.startsWith("npm error"));
	const chosen = (errors.length > 0 ? errors.slice(0, 2) : lines).join("；");
	return chosen.replace(/\s+/g, " ").slice(0, 220);
}
