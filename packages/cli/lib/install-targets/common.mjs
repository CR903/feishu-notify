/**
 * lib/install-targets/common.mjs — install 三目标共用的地基（implement.md Step 4）
 *
 * 三条设计要点，每条都直接对应 prd R6 / AC5 的硬要求：
 *
 * 1. **计划与执行分离**：探测与"要改什么"全部在 `buildPlan()` 里算完（纯计算，一次也不写盘），
 *    `applyPlan()` 只是把计划里的 `after` 落下去。`--dry-run` 打印的就是将要执行的那份计划，
 *    所以 dry-run 与真跑**不可能**出现两种行为（这是 AC5 的"零写入"与"计划可读"能同时成立的原因）。
 *
 * 2. **幂等 = 不写不备份**：`after` 与 `before` 逐字节相同 → 不写文件、**也不产生 .bak**。
 *    备份文件本身也是文件变化，若第二次跑还复制一份 .bak，
 *    "第二次跑没有任何文件变化（哈希断言）"这条要求会直接失败。
 *
 * 3. **符号链接一律不写**（filesystem-truth spec）：写穿链接会改到别处（比如 dotfiles 仓库里的
 *    真身），temp+rename 顶替链接又会毁掉 dotfiles 布局。两种结局都不是用户预期的，所以探测到
 *    链接就 refuse，并把"指向哪里"打印出来，由用户自己决定。
 *
 * 本文件不做任何 I/O 之外的策略判断；三个目标模块各自决定 status / 理由 / 修复指引。
 */

import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** 计划的状态：ok 会写；noop / skip / refuse 都不写（但含义与"谁该处理"不同） */
export const PLAN_STATUS = ["ok", "noop", "skip", "refuse"];

/** 备份后缀与 commands.mjs `backupConfig()` 同形：`<file>.bak.<ISO 时间戳，冒号点号换成 ->` */
export function backupStamp(date = new Date()) {
	return date.toISOString().replace(/[:.]/g, "-");
}

/**
 * HOME / XDG 的取值与 lib/config.mjs 一致（`env` 优先于进程真实环境）。
 * 全部路径都从这里派生 —— 测试才能把整个安装过程关进临时 HOME。
 */
export function pathsFromEnv(env = process.env) {
	const home = typeof env?.HOME === "string" && env.HOME.trim() !== "" ? env.HOME : homedir();
	const xdg = typeof env?.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.trim() !== "" ? env.XDG_CONFIG_HOME : join(home, ".config");
	return { home, xdg };
}

export function isPlainObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 展示用：把 HOME 前缀缩成 `~`（输出里尽量不出现长长的绝对路径） */
export function prettyPath(path, env = process.env) {
	const { home } = pathsFromEnv(env);
	if (typeof path !== "string" || home === "" || path === home) return path;
	return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}


/**
 * 读一个 JSON 文件。**只读**。
 * 返回 `{ ok, exists, text, value, reason?, message? }`：
 *   - 不存在 → `ok:true, exists:false`（调用方自己决定要不要新建）
 *   - 坏 JSON / 顶层不是对象 / 读不了 → `ok:false` + 原因（调用方一律 refuse，绝不覆盖）
 */
export function readJsonFile(file) {
	let text;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		if (error.code === "ENOENT" || error.code === "ENOTDIR") return { ok: true, exists: false, text: null, value: undefined };
		return { ok: false, exists: true, text: null, value: undefined, reason: "unreadable", message: `读取失败：${error.code ?? error.message}` };
	}

	let value;
	try {
		value = JSON.parse(text);
	} catch (error) {
		return { ok: false, exists: true, text, value: undefined, reason: "invalid-json", message: `不是合法 JSON：${error.message}` };
	}
	if (!isPlainObject(value)) {
		return { ok: false, exists: true, text, value: undefined, reason: "not-an-object", message: "顶层必须是 JSON 对象" };
	}
	return { ok: true, exists: true, text, value };
}

/**
 * 序列化写回用的 JSON。
 * 统一 2 空格缩进 + 末尾换行（与 lib/config.mjs 的写配置一致）；
 * 已有的键序会被 `JSON.parse` 保留，因此 diff 通常只有我们真正改的那几处。
 */
export function serializeJson(value) {
	return `${JSON.stringify(value, null, 2)}\n`;
}

/** 结构化克隆：够用（JSON 文档里没有函数/undefined），且不会改到入参 */
export function cloneJson(value) {
	return JSON.parse(JSON.stringify(value));
}

/**
 * 符号链接探测（filesystem-truth spec）：`lstat` 判"是不是链接"，`existsSync` 跟随判"目标在不在"。
 * 返回 `null`（不是链接）或 `{ target, resolves }`。
 */
export function symlinkInfo(file) {
	const stat = lstatSync(file, { throwIfNoEntry: false });
	if (!stat || !stat.isSymbolicLink()) return null;
	let target = null;
	try {
		target = readlinkSync(file);
	} catch {
		/* 读不到就只报"是链接" */
	}
	return { target, resolves: existsSync(file) };
}

/**
 * 组装一份计划。字段含义：
 *   status   "ok"(有改动，会写) / "noop"(已接线，无需改动) / "skip"(没探测到，或用户跳过) / "refuse"(拒绝写)
 *   detect   { found, path, detail }
 *   steps    [{ title, before?, after? }]   —— 人读的改动清单（before/after 是窄化后的 JSON 片段）
 *   files    [{ path, before, after }]      —— 机器执行的改动清单；after===before 表示"不写"
 *   notes    额外提示（不改变状态）
 *   reason   refuse/skip 的理由（一行）
 *   nextSteps 可执行的下一步（用户可以照着做）
 */
export function makePlan({ id, label, status, detect, steps = [], files = [], notes = [], reason = null, nextSteps = [] }) {
	if (!PLAN_STATUS.includes(status)) throw new Error(`内部错误：未知的安装计划状态 ${status}`);
	return { id, label, status, detect, steps, files, notes, reason, nextSteps };
}

/**
 * 执行计划。返回 `{ ok, changed: [{path, backup}], error? }`。
 *
 * - 只写 `after != null && after !== before` 的文件 —— 这是幂等的唯一实现点。
 * - 写前**一律** `<file>.bak.<时间戳>`（本轮共用同一个时间戳，便于把一次安装的备份认成一组）。
 * - 写用 temp + rename（同目录内原子替换），权限沿用原文件；新文件 0644。
 * - 中途失败不假装成功：把已经改过的文件连同备份一起返回，调用方能打印针对性的回滚指令。
 */
export function applyPlan(plan, { dryRun = false, stamp = backupStamp() } = {}) {
	if (dryRun) return { ok: true, changed: [] };

	const changed = [];
	try {
		for (const file of plan.files ?? []) {
			if (file === null || typeof file !== "object") continue;
			if (file.after === null || file.after === undefined) continue;
			if (file.after === file.before) continue;

			const stat = lstatSync(file.path, { throwIfNoEntry: false });
			let mode = 0o644;
			let backup = null;
			if (stat) {
				// 计划阶段已判过，这里再判一次：从 buildPlan 到 apply 之间文件可能被换掉（TOCTOU）
				if (stat.isSymbolicLink()) throw new Error(`拒绝写入符号链接：${file.path}`);
				if (stat.isDirectory()) throw new Error(`拒绝覆盖目录：${file.path}`);
				mode = stat.mode & 0o777;
				backup = `${file.path}.bak.${stamp}`;
				copyFileSync(file.path, backup);
			}
			writeAtomic(file.path, file.after, { mode });
			// 写成功才算"改过"：备份建了但写失败时，原文件还是原样，不该让调用方去回滚它
			changed.push({ path: file.path, backup });
		}
	} catch (error) {
		return { ok: false, changed, error: error instanceof Error ? error.message : String(error) };
	}
	return { ok: true, changed };
}

/** temp + rename 的原子写（rename 只在同一文件系统内原子，所以 temp 必须同目录） */
export function writeAtomic(file, text, { mode = 0o644 } = {}) {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.install-${process.pid}-${Date.now()}`;
	try {
		writeFileSync(tmp, text, { mode });
		chmodSync(tmp, mode);
		renameSync(tmp, file);
	} finally {
		rmSync(tmp, { force: true });
	}
	return file;
}

/** 回滚指令（只对真的写过、且原本就存在的文件给） */
export function rollbackCommand({ path, backup }, env = process.env) {
	if (!backup) return `rm ${prettyPath(path, env)}   # 本次新建的文件，删掉即回到安装前`;
	return `cp -p ${prettyPath(backup, env)} ${prettyPath(path, env)}`;
}
