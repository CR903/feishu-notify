/**
 * lib/install-targets/dsh.mjs — DSH（Cordis）profile 接线（prd R6 / AC9）
 *
 * 形态（本机实测）：`~/.dsh/profiles/<name>/package.json` 里两处要同时出现插件名 ——
 *   `dependencies`            让 pnpm 装它
 *   `dsh.profile.bundles`     让 DSH 启动时把它当 bundle 加载
 * 缺前者装不上；缺后者装了也不生效。**只写一半等于没装**。
 *
 * ## 为什么要预检注册表（而不是永远拒绝）
 *
 * `dsh-feishu-notify` 已实现（`packages/dsh`），但**尚未发布到 npm**。往 `bundles` 里写一个
 * 注册表上解析不出来的包，DSH 启动时加载 bundle 就会失败 —— 那比"没装"更糟（用户会以为是自己环境坏了）。
 * 所以本目标与 opencode 目标对齐：**写盘前跑一次 `npm view`**（`lib/install-targets/npm-check.mjs`），
 * 能解析才写；解析不到就**明确拒绝**并写清理由与下一步 —— 此时计划里的 steps 照常打印，
 * 作为"包一发布就会这么做"的预览。
 *
 * 这样做的关键收益：**包发布之后本目标无需改一行代码就能工作** —— 判定依据是注册表事实，不是硬编码开关。
 *
 * `--dsh-dev-dir <path>` 是本地联调口：指向本地 checkout 时改成写 `link:<绝对路径>`，
 * 并校验该目录里的 package.json 的 name 就是 `dsh-feishu-notify`（写错了名字照样装不上）。
 * 它写的是本地路径、不经过注册表，因此**跳过**上面的 npm 预检。
 *
 * ## 不做的事
 *
 * 不代替用户跑包管理器（`dsh plugin --profile <n> pnpm add …`）。理由：
 *   1. 它会联网装包、改 node_modules 与 lockfile，属于"用户的包管理器"而不是本工具的职责；
 *   2. `--dry-run` 的"零写入"承诺要能被验证 —— 一旦 install 会跑 pnpm，这条承诺就不再由本工具掌握。
 * 需要执行什么命令，会作为 nextSteps 原样打印出来。
 */

import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";

import { cloneJson, isPlainObject, makePlan, pathsFromEnv, prettyPath, readJsonFile, serializeJson, symlinkInfo } from "./common.mjs";
import { checkPublished } from "./npm-check.mjs";

export const id = "dsh";
export const label = "DSH (Cordis)";
export const aliases = ["cordis"];

export const PACKAGE_NAME = "dsh-feishu-notify";
/** 非联调路径下的目标版本区间。包尚未发布时，计划里打印的"将会写成什么"就是这个区间 */
export const DEFAULT_DEP_SPEC = "^0.1.0";
/** 联调：pnpm 的 link: 协议指向本地 checkout */
export const DEV_SPEC_PREFIX = "link:";

export function profilesDir(env = process.env) {
	return join(pathsFromEnv(env).home, ".dsh", "profiles");
}

/** 列出所有 profile（`profiles/*` 里带 package.json 的目录；node_modules 与点开头的一律不算） */
export function listProfiles(env = process.env) {
	const dir = profilesDir(env);
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	const profiles = [];
	for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : 1))) {
		if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
		if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
		const file = join(dir, entry.name, "package.json");
		if (!readJsonFile(file).exists && !symlinkInfo(file)) continue;
		profiles.push({ name: entry.name, file });
	}
	return profiles;
}

export function detect({ env = process.env } = {}) {
	const dir = profilesDir(env);
	const profiles = listProfiles(env);
	if (profiles.length === 0) {
		return { found: false, path: dir, detail: `没有 ${prettyPath(dir, env)}/*/package.json（DSH 没装，或没有 profile）`, profiles: [] };
	}
	return { found: true, path: dir, detail: `${prettyPath(dir, env)}：${profiles.map((profile) => profile.name).join(", ")}`, profiles };
}

/** 校验 `--dsh-dev-dir`：必须是目录、里面的 package.json 的 name 必须等于我们的包名 */
function resolveDevSpec(devDir) {
	const dir = resolve(devDir);
	const parsed = readJsonFile(join(dir, "package.json"));
	if (!parsed.exists) return { ok: false, reason: `--dsh-dev-dir ${dir} 里没有 package.json` };
	if (!parsed.ok) return { ok: false, reason: `--dsh-dev-dir ${dir}/package.json 不可用（${parsed.reason}）：${parsed.message}` };
	const name = parsed.value.name;
	if (name !== PACKAGE_NAME) return { ok: false, reason: `--dsh-dev-dir ${dir} 的包名是 ${JSON.stringify(name)}，不是 ${PACKAGE_NAME}` };
	return { ok: true, spec: `${DEV_SPEC_PREFIX}${dir}`, dir };
}

export function buildPlan({ env = process.env, options = {} } = {}) {
	const detection = detect({ env });
	const base = { id, label, detect: detection };
	const refuse = (reason, nextSteps = []) => makePlan({ ...base, status: "refuse", reason, nextSteps });
	const skip = (reason, nextSteps = []) => makePlan({ ...base, status: "skip", reason, nextSteps });

	if (!detection.found) {
		return skip(detection.detail, ["先装上 DSH 并至少有一个 profile（~/.dsh/profiles/<name>/package.json），再回来跑 install"]);
	}

	const devDir = options.dshDevDir;
	let depSpec = DEFAULT_DEP_SPEC;
	let dev = null;
	if (devDir !== undefined) {
		dev = resolveDevSpec(devDir);
		if (!dev.ok) return refuse(dev.reason, ["检查 --dsh-dev-dir 是否指向 packages/dsh（含 package.json、且 name 为 " + PACKAGE_NAME + "）"]);
		if (!isAbsolute(dev.dir)) return refuse(`内部错误：--dsh-dev-dir 解析出的不是绝对路径：${dev.dir}`);
		depSpec = dev.spec;
	}

	const steps = [];
	const files = [];
	const notes = [];
	const nextSteps = [];
	let changedProfiles = 0;

	for (const profile of detection.profiles) {
		const where = prettyPath(profile.file, env);
		const link = symlinkInfo(profile.file);
		if (link) {
			notes.push(`${where} 是符号链接（指向 ${link.target ?? "<读不到>"}）→ 跳过该 profile（本工具不写符号链接）`);
			continue;
		}

		const parsed = readJsonFile(profile.file);
		if (!parsed.ok) {
			notes.push(`${where} 不可用（${parsed.reason}）：${parsed.message} → 跳过该 profile`);
			nextSteps.push(`修好 ${where} 后再重跑 install`);
			continue;
		}

		const doc = parsed.value;
		if (doc.dependencies !== undefined && !isPlainObject(doc.dependencies)) {
			notes.push(`${where} 的 dependencies 不是对象 → 跳过该 profile`);
			continue;
		}
		const dsh = doc.dsh;
		if (dsh !== undefined && !isPlainObject(dsh)) {
			notes.push(`${where} 的 dsh 字段不是对象 → 跳过该 profile`);
			continue;
		}
		const profileSection = dsh?.profile;
		if (profileSection !== undefined && !isPlainObject(profileSection)) {
			notes.push(`${where} 的 dsh.profile 不是对象 → 跳过该 profile`);
			continue;
		}
		const bundles = profileSection?.bundles;
		if (bundles !== undefined && !Array.isArray(bundles)) {
			notes.push(`${where} 的 dsh.profile.bundles 不是数组 → 跳过该 profile`);
			continue;
		}

		const dependencies = doc.dependencies ?? {};
		const currentBundles = bundles ?? [];
		const needDep = dependencies[PACKAGE_NAME] === undefined;
		const needBundle = !currentBundles.includes(PACKAGE_NAME);
		if (!needDep && !needBundle) {
			notes.push(`${where}：已接线（dependencies + bundles 都有），无需改动`);
			continue;
		}

		const next = cloneJson(doc);
		if (needDep) {
			next.dependencies = { ...dependencies, [PACKAGE_NAME]: depSpec };
			steps.push({
				title: `${where} → dependencies：加 \`${PACKAGE_NAME}: ${depSpec}\``,
				before: JSON.stringify(dependencies),
				after: JSON.stringify(next.dependencies),
			});
		}
		if (needBundle) {
			next.dsh = { ...(dsh ?? {}), profile: { ...(profileSection ?? {}), bundles: [...currentBundles, PACKAGE_NAME] } };
			steps.push({
				title: `${where} → dsh.profile.bundles：加 \`${PACKAGE_NAME}\``,
				before: JSON.stringify(currentBundles),
				after: JSON.stringify(next.dsh.profile.bundles),
			});
		}
		changedProfiles += 1;
		files.push({ path: profile.file, before: parsed.text, after: serializeJson(next) });
	}

	if (changedProfiles === 0) {
		notes.push("所有探测到的 profile 都已接线，无需改动");
		return makePlan({ ...base, status: "noop", notes });
	}

	nextSteps.unshift(
		"DSH 侧不代跑包管理器：清单写好之后自己执行（profile 名换成你的）：",
		...detection.profiles.map((profile) => `  dsh plugin --profile ${profile.name} pnpm install`),
		"卸载（AC4）：从 dependencies 与 dsh.profile.bundles 里删掉两处，再 pnpm install",
	);
	nextSteps.push(`联调本地 checkout：install --target dsh --dsh-dev-dir <packages/dsh 的路径>（会写 link:<绝对路径>，并校验包名）`);

	if (dev === null) {
		notes.push("写入前会用 `npm view` 确认这个包在注册表上可解析；解析不出来就拒绝写入（不给 DSH 留一个加载不起来的 bundle）");
	} else {
		notes.push(`联调模式：dependencies 写的是 ${depSpec}（指向 ${dev.dir}），不经过 npm 注册表`);
		notes.push("本轮不代替你跑 dsh/pnpm；清单写好后按下面的命令装一次");
	}

	return makePlan({
		...base,
		status: "ok",
		steps,
		notes,
		nextSteps,
		files,
	});
}

/**
 * 包尚未发布（`npm view` 解析不到）→ 把"计划"改成"拒绝写入"。
 *
 * 拒绝的真正理由不是"没实现"，而是**写进去会让 DSH 起不来**：`dsh.profile.bundles` 里有一个
 * 解析不出来的包，DSH 在 profile 启动阶段加载 bundle 就失败 —— 那比"没装"更糟
 * （用户会以为是自己环境坏了）。计划里的 `steps` 原样保留，所以拒绝时打印的仍是一份
 * "包一发布就会这么做"的预览；`files` 清空，确保一个字节都不写。
 */
export function refuseUnpublished(plan, check) {
	return makePlan({
		...plan,
		status: "refuse",
		files: [],
		reason:
			`${PACKAGE_NAME} 尚未发布（${check.message}）。**没有改动任何文件**：往 dependencies 与 dsh.profile.bundles 里写一个` +
			"注册表上解析不出来的 bundle，DSH 启动时加载它会失败 —— 比「没装」更糟。上面是「将来会改成什么」的预览。",
		nextSteps: [
			"该包尚未发布 → 等 packages/dsh 发布后再跑 install（届时本目标无需改代码就能写入）",
			...plan.nextSteps,
		],
	});
}

/**
 * 调用方（orchestrator）在真正要写之前调它；`--dry-run` 与 `--no-verify` 会跳过。
 *
 * `--dsh-dev-dir` 写的是 `link:<本地路径>`，跟注册表无关 → 不预检
 * （否则联调会被"包还没发布"挡住，而联调的全部意义就是不等发布）。
 */
export async function preflight({ plan, env = process.env, spawn = spawnSync, options = {} } = {}) {
	if (plan.status !== "ok") return plan;
	if (options.dshDevDir !== undefined) {
		return makePlan({ ...plan, notes: [...plan.notes, "联调（--dsh-dev-dir）：写的是 link: 本地路径，与 npm 注册表无关 → 跳过注册表预检"] });
	}
	const check = checkPublished({ env, spawn, name: PACKAGE_NAME });
	if (!check.ok) return refuseUnpublished(plan, check);
	return makePlan({ ...plan, notes: [...plan.notes, `预检：${check.message}`] });
}
