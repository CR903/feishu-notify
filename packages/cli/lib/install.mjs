/**
 * lib/install.mjs — `install` 的编排（implement.md Step 4 第 4 条）
 *
 * 流程刻意做成"先全部算完，再问一次，再逐目标执行"：
 *
 *   探测 → 逐目标 buildPlan（纯计算，一次也不写）→ 打印计划 → 确认 → applyPlan × N → 结果表 + 回滚指令
 *
 * 这样三件事同时成立：
 *   - `--dry-run` 打印的就是**将要执行的那份计划**（不是另写一套"如果真跑会怎样"的描述）；
 *   - 用户在写盘之前能看到每个目标的确切改动；
 *   - 单目标失败被 try/catch 隔在本地（AC9：一个目标失败不影响其它目标）。
 *
 * 退出码：
 *   0  至少一个目标"就绪"（写入成功，或本来就无需改动），且没有意外失败
 *   1  有目标失败；或所有该做的都被拒绝（refuse）；或 `--target` 点名要求的目标被跳过/拒绝
 *   2  配置问题（本命令不读 feishu-notify 配置，保留给同族命令的语义）
 *
 * 不做的事：不跑包管理器（`pnpm` / `dsh plugin`）、不重启 agent、不碰
 * `~/.config/feishu-notify/` 之外的"我们自己的"状态 —— 所有写入都是用户显式调 `install`
 * 的后果，且每个被改的文件都留 `<file>.bak.<时间戳>`。
 */

import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

import { CommandError } from "./errors.mjs";
import { makeIo, say, takeValue } from "./io.mjs";
import { applyPlan, backupStamp, pathsFromEnv, prettyPath, rollbackCommand } from "./install-targets/common.mjs";
import { TARGETS, findTargetByName, targetLabelList } from "./install-targets/index.mjs";
import { DEFAULT_FORM, FORMS } from "./install-targets/opencode.mjs";

/** 计划状态 → 结果状态（dry-run 时 ok 变成"将写入"） */
const OUTCOME_MARK = { applied: "✓", would: "▸", noop: "=", skipped: "–", refused: "⛔", failed: "✗" };
const OUTCOME_TEXT = { applied: "已写入", would: "将写入（--dry-run，未落盘）", noop: "无需改动", skipped: "已跳过", refused: "未改动", failed: "失败" };

// ---------------------------------------------------------------- 参数

export function parseInstallFlags(argv) {
	const options = {
		dryRun: false,
		yes: false,
		targets: [],
		skip: [],
		channel: undefined,
		opencodeForm: DEFAULT_FORM,
		dshDevDir: undefined,
		noVerify: false,
		help: false,
	};

	const rest = [];
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		switch (arg) {
			case "--dry-run":
			case "-n":
				options.dryRun = true;
				break;
			case "--yes":
			case "-y":
				options.yes = true;
				break;
			case "--skip":
				options.skip.push(...splitTargets(takeValue(argv, ++index, "--skip")));
				break;
			case "--target":
			case "--only":
				options.targets.push(...splitTargets(takeValue(argv, ++index, "--target")));
				break;
			case "--channel":
				options.channel = takeValue(argv, ++index, "--channel");
				break;
			case "--opencode-form":
				options.opencodeForm = takeValue(argv, ++index, "--opencode-form");
				break;
			case "--dsh-dev-dir":
				options.dshDevDir = takeValue(argv, ++index, "--dsh-dev-dir");
				break;
			case "--no-verify":
				options.noVerify = true;
				break;
			case "--help":
			case "-h":
				options.help = true;
				break;
			default:
				rest.push(arg);
		}
	}
	if (rest.length > 0) throw new CommandError(`install 不认识这些参数：${rest.join(" ")}\n\n${installUsage()}`, { reason: "usage" });
	if (options.targets.length > 0 && options.skip.length > 0) throw new CommandError("--target 与 --skip 只能给一个（前者白名单，后者黑名单）", { reason: "usage" });
	if (!FORMS.includes(options.opencodeForm)) {
		throw new CommandError(`--opencode-form 只接受 ${FORMS.join(" / ")}（当前 ${JSON.stringify(options.opencodeForm)}）`, { reason: "usage" });
	}
	for (const name of [...options.targets, ...options.skip]) {
		if (!findTargetByName(name)) throw new CommandError(`未知目标：${name}（可用：${TARGETS.map((target) => target.id).join(", ")}）`, { reason: "usage" });
	}
	return options;
}

function splitTargets(value) {
	return String(value)
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
}

export function installUsage() {
	return [
		"用法: feishu-notify-cli install [--dry-run] [--yes] [--target <t>… | --skip <t>…] [选项]",
		"",
		"  探测本机已装的 agent，把 feishu-notify 幂等地接进它们的配置。",
		`  目标：${targetLabelList()}`,
		"",
		"  --dry-run            只打印计划，**零写入**（计划与真跑用的是同一份数据）",
		"  --yes                跳过确认（非交互环境必须给）",
		"  --target <t>        只处理这些目标（逗号分隔；名字或别名，如 claude）",
		"  --skip <t>          跳过这些目标（逗号分隔）",
		"  --channel <name>    把 --channel <name> 附加到写入的 hook 上（默认不附加，走 activeChannel）",
		`  --opencode-form <f> opencode 的声明形态：${FORMS.join(" / ")}（默认 ${DEFAULT_FORM}；两种在解析层等价，见 lib/install-targets/opencode.mjs）`,
		"  --dsh-dev-dir <p>   DSH 联调：用 link:<绝对路径> 指向本地 checkout（默认拒绝写 DSH profile）",
		"  --no-verify         跳过写入前的预检（opencode 的包可解析性）",
		"",
		"写入前一律留 <file>.bak.<时间戳>；重复跑第二次不产生任何文件变化；结束时打印回滚指令。",
		"退出码：0 至少一个目标就绪；1 有失败，或该做的全被拒绝，或 --target 点名的目标被跳过/拒绝。",
	].join("\n");
}

// ---------------------------------------------------------------- 渲染

const MAX_SNIPPET = 220;

function snippet(text) {
	if (text === undefined || text === null) return null;
	const one = String(text).replace(/\s+/g, " ").trim();
	return one.length > MAX_SNIPPET ? `${one.slice(0, MAX_SNIPPET)}…` : one;
}

/** 结果表里只放理由的开头 —— 计划段已经完整印过一遍，这里重复整段只会淹掉表格 */
function shortReason(reason) {
	if (reason === undefined || reason === null) return null;
	const one = String(reason).replace(/\s+/g, " ").trim();
	return one.length > 110 ? `${one.slice(0, 110)}…` : one;
}

function renderDetection(plans, env) {
	const lines = ["  探测："];
	for (const plan of plans) {
		const mark = plan.detect.found ? "✓" : "–";
		lines.push(`    ${mark} ${plan.label.padEnd(16)} ${plan.detect.detail}`);
	}
	lines.push(`    （HOME=${pathsFromEnv(env).home}）`);
	return lines;
}

function renderPlan(plan, env) {
	const lines = [`    ▸ ${plan.label}`];
	switch (plan.status) {
		case "skip":
			lines.push(`        – 跳过：${plan.reason}`);
			break;
		case "noop":
			lines.push("        = 已经接线，无需改动");
			break;
		case "refuse":
			lines.push(`        ⛔ 不会改动：${plan.reason}`);
			for (const step of plan.steps) lines.push(`        （预览）${step.title}`);
			break;
		default:
			for (const step of plan.steps) {
				lines.push(`        • ${step.title}`);
				if (step.before !== undefined) lines.push(`          - ${snippet(step.before)}`);
				if (step.after !== undefined) lines.push(`          + ${snippet(step.after)}`);
			}
			lines.push(`        将写入：${plan.files.map((file) => prettyPath(file.path, env)).join("、")}`);
	}
	for (const note of plan.notes) lines.push(`        ! ${note}`);
	if (plan.nextSteps.length > 0) {
		lines.push("        下一步：");
		for (const step of plan.nextSteps) lines.push(`          - ${step}`);
	}
	return lines;
}

// ---------------------------------------------------------------- 确认

async function askConfirm(io, question) {
	const rl = createInterface({ input: io.stdin, output: io.stderr, terminal: Boolean(io.stdin.isTTY) });
	try {
		return await rl.question(question);
	} finally {
		rl.close();
	}
}

// ---------------------------------------------------------------- install

export async function commandInstall(argv, { env = process.env, io: rawIo, spawn = spawnSync, confirm } = {}) {
	const io = makeIo(rawIo);
	const options = parseInstallFlags(argv);
	if (options.help) {
		say(io, installUsage());
		return 0;
	}

	const selected = options.targets.length > 0
		? TARGETS.filter((target) => options.targets.some((name) => findTargetByName(name) === target))
		: TARGETS.filter((target) => !options.skip.some((name) => findTargetByName(name) === target));

	say(io, "feishu-notify install");
	say(io, "");

	// ---- 逐目标算计划（纯计算，一次也不写）
	const plans = [];
	for (const target of selected) {
		let plan;
		try {
			plan = target.buildPlan({ env, options });
		} catch (error) {
			plan = {
				id: target.id,
				label: target.label,
				status: "refuse",
				detect: { found: false, path: null, detail: "探测时出错" },
				steps: [],
				files: [],
				notes: [],
				reason: `探测/计划阶段出错：${error instanceof Error ? error.message : String(error)}`,
				nextSteps: [],
			};
		}
		if (options.dryRun && typeof target.preflight === "function") {
			plan = { ...plan, notes: [...plan.notes, "（--dry-run：跳过了写入前的包可解析性预检）"] };
		} else if (!options.dryRun && typeof target.preflight === "function" && plan.status === "ok") {
			plan = options.noVerify
				? { ...plan, notes: [...plan.notes, "（--no-verify：跳过了写入前的包可解析性预检 —— 能不能装上看运气）"] }
				: await target.preflight({ plan, env, spawn, options });
		}
		plans.push(plan);
	}

	for (const line of renderDetection(plans, env)) say(io, line);
	say(io, "");

	if (options.skip.length > 0) say(io, `  （按要求跳过：${options.skip.join(", ")}）`);
	say(io, "  计划：");
	for (const plan of plans) for (const line of renderPlan(plan, env)) say(io, line);
	say(io, "");

	const actionable = plans.filter((plan) => plan.status === "ok");
	const stamp = backupStamp();

	if (actionable.length === 0) {
		say(io, "  没有需要写入的改动。");
		if (plans.length === 0) {
			say(io, "  （--skip 把目标全跳过了，没什么可做）");
		} else if (plans.every((plan) => plan.status === "skip" && !plan.detect.found)) {
			say(io, "  没有探测到任何可接入的 agent。各目标需要的文件：");
			for (const target of TARGETS) say(io, `    ${target.id.padEnd(12)} ${target.detect({ env }).detail}`);
			say(io, "  装好其中之一再跑一次；发送端本身可用性用 `feishu-notify-cli doctor` 确认。");
		}
		return finish(io, plans, [], env, { dryRun: options.dryRun });
	}

	// ---- 确认（--dry-run 不问；--yes 不问）
	if (!options.dryRun && !options.yes) {
		const files = actionable.flatMap((plan) => plan.files.map((file) => prettyPath(file.path, env)));
		if (!io.stdin.isTTY) {
			throw new CommandError(
				`非交互环境（stdin 不是终端）：确认后重跑，或加 --yes。\n  将要写入：\n${files.map((file) => `    ${file}`).join("\n")}`,
				{ reason: "usage" },
			);
		}
		const answer = confirm ? await confirm() : await askConfirm(io, `  将要写入 ${files.length} 个文件（各留 .bak.${stamp}）。确认继续？[y/N] `);
		if (!/^y(es)?$/i.test(String(answer).trim())) {
			say(io, "  已取消：没有写任何文件。");
			return 1;
		}
	}

	// ---- 逐目标执行（单目标失败不外溢）
	const results = [];
	for (const plan of plans) {
		if (plan.status !== "ok") {
			results.push({ plan, outcome: plan.status === "noop" ? "noop" : plan.status === "skip" ? "skipped" : "refused", detail: plan.reason ?? null });
			continue;
		}
		if (options.dryRun) {
			results.push({ plan, outcome: "would", detail: null });
			continue;
		}
		const applied = applyPlan(plan, { stamp });
		results.push({ plan, outcome: applied.ok ? "applied" : "failed", detail: applied.ok ? null : applied.error, changed: applied.changed });
	}

	return finish(io, plans, results, env, { dryRun: options.dryRun });
}

function finish(io, plans, results, env, { dryRun = false } = {}) {
	if (results.length === 0) {
		// 没有任何可写改动：也给一张"结果表"，让输出形状保持一致
		results = plans.map((plan) => ({ plan, outcome: plan.status === "noop" ? "noop" : plan.status === "skip" ? "skipped" : "refused", detail: plan.reason ?? null }));
	}

	say(io, dryRun ? "  结果（--dry-run，未落盘）：" : "  结果：");
	for (const result of results) {
		const mark = OUTCOME_MARK[result.outcome];
		const extra = [];
		if (result.outcome === "applied") extra.push(`${result.changed.length} 个文件`);
		if (result.outcome === "failed" || result.outcome === "refused") extra.push(shortReason(result.detail) ?? "未知原因");
		if (result.outcome === "skipped" && result.detail) extra.push(shortReason(result.detail));
		say(io, `    ${mark} ${result.plan.id.padEnd(12)} ${OUTCOME_TEXT[result.outcome]}${extra.length > 0 ? `：${extra.join("；")}` : ""}`);
		if (result.outcome === "failed" && (result.changed ?? []).length > 0) {
			say(io, `        ⚠ 该目标已部分写入（下面给了它自己的回滚指令）`);
		}
	}

	const applied = results.filter((result) => result.outcome === "applied");
	const backups = results.flatMap((result) => result.changed ?? []).filter((entry) => entry.backup);
	if (backups.length > 0) {
		say(io, "");
		say(io, dryRun ? "  回滚（--dry-run 未写，仅供参考）：" : "  回滚（每个被改的文件都留了备份）：");
		for (const entry of backups) say(io, `    ${rollbackCommand(entry, env)}`);
	}

	const changedPaths = results.flatMap((result) => result.changed ?? []);
	if (dryRun && results.some((result) => result.outcome === "would")) {
		say(io, "");
		say(io, "  （--dry-run：零写入。去掉 --dry-run 并加 --yes 即可真跑）");
	}

	const failed = results.filter((result) => result.outcome === "failed");
	const refused = results.filter((result) => result.outcome === "refused");
	const ready = results.filter((result) => result.outcome === "applied" || result.outcome === "noop" || result.outcome === "would");
	const skipped = results.filter((result) => result.outcome === "skipped");

	say(io, "");
	say(io, `  小结：${ready.length} 就绪 / ${refused.length} 被拒 / ${skipped.length} 跳过 / ${failed.length} 失败${dryRun ? "（--dry-run）" : ""}`);
	if (refused.length > 0) {
		say(io, "  被拒的目标都给了「为什么」与「下一步」（见上面的计划段）；本工具宁可不动你的配置，也不写一个坏掉的接线。");
	}
	if (!dryRun && changedPaths.length === 0 && failed.length === 0 && refused.length === 0 && ready.length === 0) {
		say(io, "  本次没有探测到可接入的目标。");
	}

	if (failed.length > 0) return 1;
	if (refused.length > 0 && ready.length === 0) return 1;
	return 0;
}
