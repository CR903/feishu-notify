/**
 * lib/install-targets/claude-code.mjs — 把两条 hook 合并进 `~/.claude/settings.json`（prd R6 / AC5）
 *
 * 合并的是什么（与作者本机在跑的那份一致）：
 *   Notification（matcher `idle_prompt`）→ `feishu-notify --idle`
 *   Stop                                → `feishu-notify --done`
 *
 * 三个刻意的选择：
 *
 * 1. **命令写裸名 `feishu-notify`，不写 `~/.local/bin/…` 也不写仓库路径**（prd R11）。
 *    hook 由 shell 执行，裸名走 PATH —— 这正是"全局安装产出真实 bin"的用法。
 *    指向仓库/某个 bin 目录写死了，仓库一改名（2026-10-18 的事故）整条链就悬空。
 *
 * 2. **去重按 command 字符串**（任务书要求）。在此之上多认一层"等价"：同事件、且命令里
 *    确实是在调 feishu-notify，就当作已接线 —— 否则用户机器上已有的
 *    `~/.local/bin/feishu-notify --idle` 会被我们再加一条 `feishu-notify --idle`，
 *    **每次事件发两张卡**。等价但不同文的情况只提示、不改用户既有配置（非破坏性）。
 *
 * 3. `--channel <name>` **只在用户显式传了才附加**；默认不附加，让发送端走 activeChannel
 *    （多机器人分流是用户的配置决定，不该由安装器替他钉死）。
 *
 * `timeout: 10000` 照抄作者本机在跑的配置；Claude Code 文档对该字段单位（秒/毫秒）的说法
 * 变动过，换版本的机器上以官方文档为准。
 */

import { join } from "node:path";

import { cloneJson, isPlainObject, makePlan, pathsFromEnv, prettyPath, readJsonFile, serializeJson, symlinkInfo } from "./common.mjs";

export const id = "claude-code";
export const label = "Claude Code";
/** `--skip claude` / `--target claude` 也认（用户不会记得我们内部叫 claude-code） */
export const aliases = ["claude"];

/** 与作者本机在跑的 hook 一致（见文件头注释） */
export const HOOK_TIMEOUT_MS = 10_000;

export const EVENTS = [
	{ event: "Notification", matcher: "idle_prompt", flags: ["--idle"] },
	// `--hook` 是 `--done` 的旧别名（同一个 Stop 事件），判重时一起认，免得一个事件发两张卡
	{ event: "Stop", matcher: undefined, flags: ["--done", "--hook"] },
];

export function settingsPath(env = process.env) {
	return join(pathsFromEnv(env).home, ".claude", "settings.json");
}

/** 本次要写进配置的命令行。`channel` 只有显式给了才带上（见文件头第 3 条） */
export function commandFor(flag, channel) {
	return channel ? `feishu-notify ${flag} --channel ${channel}` : `feishu-notify ${flag}`;
}

function handlerFor(flag, channel) {
	// 键序与作者本机既有条目一致（command / timeout / type），这样 diff 只多一行
	return { command: commandFor(flag, channel), timeout: HOOK_TIMEOUT_MS, type: "command" };
}

const FEISHU_NOTIFY_IN_COMMAND = /(?:^|[\s"'/])feishu-notify(?:\.sh|\.mjs)?(?:\s|$)/;

function looksLikeFeishuNotify(command) {
	return typeof command === "string" && FEISHU_NOTIFY_IN_COMMAND.test(command);
}

function commandHasFlag(command, flag) {
	if (typeof command !== "string") return false;
	const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(?:^|\\s)${escaped}(?=\\s|$)`).test(command);
}

/** 同事件、同调用对象 → 视为等价（比"命令字符串完全相同"宽一档，理由见文件头第 2 条） */
function equivalentHandler(handlers, spec) {
	return handlers.find((handler) => isPlainObject(handler) && looksLikeFeishuNotify(handler.command) && spec.flags.some((flag) => commandHasFlag(handler.command, flag))) ?? null;
}

class RefuseError extends Error {
	constructor(reason, { nextSteps = [] } = {}) {
		super(reason);
		this.reason = reason;
		this.nextSteps = nextSteps;
	}
}

/** 探测：只看 `~/.claude/settings.json` 在不在（没有它就没有可合并的 hook 容器） */
export function detect({ env = process.env } = {}) {
	const file = settingsPath(env);
	const stat = symlinkInfo(file) ?? null;
	if (stat) {
		return { found: true, path: file, detail: `${prettyPath(file, env)}（**是符号链接**，指向 ${stat.target ?? "<读不到>"}）` };
	}
	const exists = readJsonFile(file);
	if (!exists.exists) return { found: false, path: file, detail: `没有 ${prettyPath(file, env)}（Claude Code 没装，或从未跑过）` };
	return { found: true, path: file, detail: prettyPath(file, env) };
}

export function buildPlan({ env = process.env, options = {} } = {}) {
	const file = settingsPath(env);
	const detection = detect({ env });
	const base = { id, label, detect: detection };
	const refuse = (reason, nextSteps = []) => makePlan({ ...base, status: "refuse", reason, nextSteps });
	const skip = (reason, nextSteps = []) => makePlan({ ...base, status: "skip", reason, nextSteps });

	if (!detection.found) {
		return skip(detection.detail, ["装好 Claude Code 并至少启动一次（它会生成 ~/.claude/settings.json），再回来跑 install"]);
	}

	const link = symlinkInfo(file);
	if (link) {
		return refuse(
			`${prettyPath(file, env)} 是符号链接（指向 ${link.target ?? "<读不到>"}）。本工具不写符号链接：` +
				"写穿会改到你 dotfiles 仓库里的真身，替换链接又会毁掉你的 dotfiles 布局 —— 两种都不是你预期的。",
			[
				`确认要由本工具接管：把 ${prettyPath(file, env)} 换成普通文件（把你 dotfiles 里的那份拷回来），再跑一次 install`,
				`或者手改 dotfiles 里那份（两条 hook 见 README 的 Wiring 章节）`,
			],
		);
	}

	const parsed = readJsonFile(file);
	if (!parsed.ok) {
		return refuse(`${prettyPath(file, env)} 不可用（${parsed.reason}）：${parsed.message}`, [
			"先修好这份 JSON（本工具**不会**自动覆盖一个坏文件），再跑 install",
		]);
	}
	if (parsed.value.hooks !== undefined && !isPlainObject(parsed.value.hooks)) {
		return refuse(`settings.json 的 hooks 字段不是对象（当前 ${Array.isArray(parsed.value.hooks) ? "数组" : typeof parsed.value.hooks}）`, [
			"hooks 应该是 { <EventName>: [ { matcher?, hooks: [...] } ] }；手改正确后重跑 install",
		]);
	}

	const channel = options.channel;
	const before = parsed.text;
	const next = cloneJson(parsed.value);
	const steps = [];
	const notes = [];

	try {
		for (const spec of EVENTS) {
			const groups = next.hooks?.[spec.event];
			if (groups !== undefined && !Array.isArray(groups)) {
				throw new RefuseError(`settings.json 的 hooks.${spec.event} 不是数组`, {
					nextSteps: [`请把 hooks.${spec.event} 改回数组（Claude Code 的 hook 分组列表），再重跑 install`],
				});
			}

			const existingGroups = groups ?? [];
			const group = spec.matcher === undefined
				? existingGroups.find((candidate) => isPlainObject(candidate) && candidate.matcher === undefined)
				: existingGroups.find((candidate) => isPlainObject(candidate) && candidate.matcher === spec.matcher);

			if (group !== undefined && group.hooks !== undefined && !Array.isArray(group.hooks)) {
				throw new RefuseError(`settings.json 的 hooks.${spec.event} 里某个分组的 hooks 不是数组`, {
					nextSteps: ["分组形状应为 { matcher?, hooks: [ { type, command, timeout? } ] }；修好后重跑 install"],
				});
			}

			const handlers = group?.hooks ?? [];
			const command = commandFor(spec.flags[0], channel);

			if (handlers.some((handler) => isPlainObject(handler) && handler.command === command)) {
				continue; // 完全一致 → 已接线，什么都不做
			}

			const similar = equivalentHandler(handlers, spec);
			if (similar) {
				notes.push(`${spec.event}：已有等价 hook \`${similar.command}\`，保持不变（没再加一条，避免同事件发两张卡）；换成 \`${command}\` 请手改或删掉旧条目后重跑`);
				continue;
			}

			const hook = handlerFor(spec.flags[0], channel);
			let beforeGroup;
			let afterGroup;
			if (group === undefined) {
				const created = spec.matcher === undefined ? { hooks: [hook] } : { hooks: [hook], matcher: spec.matcher };
				next.hooks = { ...(next.hooks ?? {}), [spec.event]: [...existingGroups, created] };
				beforeGroup = null;
				afterGroup = created;
			} else {
				group.hooks = [...handlers, hook];
				beforeGroup = { ...group, hooks: handlers };
				afterGroup = group;
			}

			steps.push({
				title: `hooks.${spec.event}${spec.matcher ? `（matcher=${spec.matcher}）` : ""}：追加 \`${command}\``,
				before: JSON.stringify(beforeGroup),
				after: JSON.stringify(afterGroup),
			});
		}
	} catch (error) {
		if (error instanceof RefuseError) return refuse(error.reason, error.nextSteps);
		throw error;
	}

	if (steps.length === 0) {
		return makePlan({ ...base, status: "noop", notes });
	}

	const after = serializeJson(next);
	notes.push("整份 settings.json 会按 2 空格缩进重写（键序保留；Claude Code 的其它配置一个字段都没动）");
	notes.push(`hook 命令写的是裸名 \`feishu-notify\`（走 PATH）—— 请确保它是**全局安装**的，别指向开发仓库（见 README 的 Wiring 章节）`);
	if (channel !== undefined) notes.push(`已按要求把 --channel ${channel} 附加到两条 hook 上（用 channel list 可确认这名字存在）`);

	return makePlan({ id, label, detect: detection, status: "ok", steps, notes, files: [{ path: file, before, after }] });
}
