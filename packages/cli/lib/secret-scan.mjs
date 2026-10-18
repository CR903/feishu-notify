/**
 * lib/secret-scan.mjs — 发布前密钥闸门（AC6）
 *
 * 扫两处：
 *   1. **整个 git 仓库索引**（跟踪文件 + 未被 .gitignore 忽略的新文件，后者现在不入库但 `git add -A` 会入）。
 *      单仓三包（packages/*）之后这条尤其重要：扫描根不再是"cwd"，而是 `git rev-parse --show-toplevel`，
 *      否则从 `packages/cli` 跑就只看得见本包，根目录与另两个包会从闸门视野里消失。
 *   2. `npm pack --dry-run --json` 列出的发布产物（在**包目录**里跑 pack，逐个读内容）
 *
 * 两个"根"是分开的，别把它们合并：
 *   - **索引根**（index root）：永远是 git 仓库根。命令行里 `--root` 只用于"扫一个仓库之外的目录"（测试注入的临时仓库）。
 *   - **包根**（pack root）：`npm pack` 的目标。默认取本文件所在的最近一个含 package.json 的目录。
 * 报告中所有路径都统一写成**相对索引根**，索引与 pack 两条来源因此能自然去重。
 *
 * 判定“命中真实 hook” = 出现 `<marker><token>` 且 token 不属于下列白名单：
 *   - 角度括号占位符：`<PLACEHOLDER>` / `<REDACTED>` / `<你的 webhook>`
 *   - `xxx` / `PLACEHOLDER` / `REDACTED`
 *   - 文档与测试样例前缀：`test-*` / `example-*` / `fake-*` / `dummy-*` / `sample-*`
 *
 * ---------------------------------------------------------------- 通用凭据形态（E）
 *
 * 除了飞书 hook 这一种形状，闸门还认**具名凭据形态**（见 CREDENTIAL_PATTERNS）：
 * openai / anthropic / github / aws / google / slack / stripe / Bearer / PEM 私钥。
 *
 *   - **每条都带左边界** `(?<![A-Za-z0-9_-])`。这不是洁癖：没有它时，路径名
 *     `trellis-task-bac…` 会被切出词内的 `ta·sk-bac…` 并误报成 `sk-` 凭据
 *     （2026-10-18 实际发生过）。tests/secret-scan.test.mjs 有一条反例把这条钉住。
 *   - 白名单（`<…>`/`xxx`/`PLACEHOLDER`/`test-*`/`example-*`/`${token}`）继续有效，
 *     只是作用在“凭据的 secret 部分”上。PEM 头无法内嵌占位符，故一律命中；文档要举例
 *     请写成 `-----BEGIN <PRIVATE KEY>-----`（不匹配本形态）。
 *   - **报告里绝不出现命中串本身**：凭据命中只报文件名 + 行号 + 形态名，`value` 固定
 *     为 `<REDACTED>`。检测函数 `findCredentials()` 返回的对象里根本不存在命中的字符串。
 *
 * 另有一条**本机 live 指纹**交叉校验：把 `~/.local/bin/feishu-notify`、
 * `~/.config/opencode/plugins/feishu-notify.ts`、`~/.claude/settings.json` 里出现过的
 * hook token 提取成集合（只留内存，不打印、不落盘；提取时**不过样例白名单** ——
 * live 文件里的 token 天然都是真实地址），命中仓库内容即失败。
 * 这条针对的正是 R-1："两个文件里硬编码的个人地址有没有被抄进仓库"。
 * （Step 2 迁移后本机地址会挪进配置文件，届时这条会自然失效；结构扫描才是长期闸门。）
 *
 * 说明（与 AC6 字面措辞的偏差，已在回报中说明）：AC6 写的是
 * `open-apis/bot/v2/hook/` 出现次数为 0。字面做不到——`lib/config.mjs` 必须校验该 URL 形状、
 * bash 用法示例也带该形状。因此闸门的实际语义是"不允许出现**真实 token**"。
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { maskWebhook } from "./config.mjs";

/** 拆开拼接：让本文件自身不含完整的 marker 字面量（免得扫描器自己命中自己） */
export const HOOK_MARKER = ["open-apis", "bot", "v2", "hook"].join("/") + "/";

const TOKEN_PATTERN = new RegExp(escapeRegExp(HOOK_MARKER) + "([A-Za-z0-9_%.-]{6,})", "g");

const ALLOWED_TOKEN = /^(?:x+|placeholder|redacted|your[-_ ]?webhook|\.\.\.|…)$/i;
const ALLOWED_SAMPLE_TOKEN = /^(?:test|example|fake|dummy|sample)(?:[-_.][A-Za-z0-9_.-]+)?$/i;

/**
 * 具名凭据形态。每条：
 *   - `id`      报告里用的形态名（只说“是什么形态”，与命中串无关，故不泄露）
 *   - `pattern` 带 `g` 的正则；**左边界写在各条里**（`(?<![A-Za-z0-9_-])`），
 *               否则路径名 `trellis-task-bac…` 里的 `sk-bac…` 会误报（实际事故）
 *
 * 注意：本文件自身的源码会被闸门扫描，所以这些正则字面量必须**不会命中自己** ——
 * 每条前缀后紧跟的都是正则元字符（`[`、`\`），不是可构成 secret 的字符。
 */
const CREDENTIAL_PATTERNS = [
	{ id: "openai-key", pattern: /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9]{20,}/g },
	{ id: "anthropic-key", pattern: /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{20,}/g },
	{ id: "github-token", pattern: /(?<![A-Za-z0-9_-])gh[po]_[A-Za-z0-9]{36,}/g },
	{ id: "github-pat", pattern: /(?<![A-Za-z0-9_-])github_pat_[A-Za-z0-9_]{22,}/g },
	{ id: "aws-access-key-id", pattern: /(?<![A-Za-z0-9_-])AKIA[0-9A-Z]{16}/g },
	{ id: "google-api-key", pattern: /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}/g },
	{ id: "slack-token", pattern: /(?<![A-Za-z0-9_-])xox[abprs]-[A-Za-z0-9-]{10,}/g },
	{ id: "stripe-live-key", pattern: /(?<![A-Za-z0-9_-])sk_live_[A-Za-z0-9]{16,}/g },
	{ id: "bearer-token", pattern: /(?<![A-Za-z0-9_-])Bearer\s+[A-Za-z0-9._~+/=-]{20,}/gi },
	{ id: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
];

/** 剥掉凭据前缀，剩下的才是 secret 部分（白名单判定作用在它身上） */
const CREDENTIAL_PREFIX = /^(?:Bearer\s+|sk-ant-|sk_live_|sk-|github_pat_|gh[po]_|AKIA|AIza|xox[abprs]-)/i;

const MAX_FILE_BYTES = 4 * 1024 * 1024;

export function isAllowedToken(token) {
	return ALLOWED_TOKEN.test(token) || ALLOWED_SAMPLE_TOKEN.test(token);
}

/**
 * 凭据形态的白名单：`<...>` / `${token}` / PLACEHOLDER / REDACTED / your-key / xxx / test-* / example-*。
 *
 * PEM 头剥不掉前缀（`secret === raw`）→ 直接返回 false（一律命中）；想在文档里举例，
 * 用不匹配本形态的 `-----BEGIN <PRIVATE KEY>-----`。
 */
export function isAllowedCredential(raw) {
	if (/[<>]/.test(raw) || raw.includes("${")) return true;
	if (/placeholder|redacted|your[-_ ]?(?:key|token|secret|webhook)/i.test(raw)) return true;
	const secret = raw.replace(CREDENTIAL_PREFIX, "");
	if (secret === raw) return false; // 没剥掉前缀（例如 PEM 头）→ 不是占位符
	if (/^(?:x+|\.{3}|…)$/i.test(secret)) return true;
	if (/^(?:test|example|fake|dummy|sample)(?:[-_.]|$)/i.test(secret)) return true;
	return false;
}

/**
 * 找出文本里的具名凭据（**返回值里没有任何命中串**，只有 index 与形态 id）。
 * 报告方据此只能写出“哪条文件、第几行、什么形态”。
 */
export function findCredentials(text) {
	const source = typeof text === "string" ? text : "";
	const hits = [];
	for (const { id, pattern } of CREDENTIAL_PATTERNS) {
		for (const match of source.matchAll(pattern)) {
			if (isAllowedCredential(match[0])) continue;
			hits.push({ index: match.index, id });
		}
	}
	return hits;
}


/** 找出文本里所有 hook token（**不过白名单**）—— live 文件里的 token 天然都是真实地址 */
export function rawHookTokens(text) {
	const tokens = [];
	for (const match of text.matchAll(TOKEN_PATTERN)) tokens.push({ index: match.index, token: match[1] });
	return tokens;
}

/**
 * 找出文本里“疑似真实 hook”：结构上不像占位符/样例，**或** token 出现在 live 集合里
 * （live 集合里的 token 即使形状合规也必须拦）。返回 [{index, token, value, live}]，value 已脱敏。
 */
export function findHookTokens(text, { liveTokens: live = new Set() } = {}) {
	const hits = [];
	for (const hit of rawHookTokens(text)) {
		const isLive = live.has(hit.token);
		if (!isLive && isAllowedToken(hit.token)) continue;
		hits.push({ ...hit, value: maskContext(text, hit.index, hit.token), live: isLive });
	}
	return hits;
}

/** 命中处的上下文 URL 脱敏（绝不回传 token 原文） */
function maskContext(text, index, token) {
	const urlStart = text.lastIndexOf("http", index);
	const raw = urlStart === -1 ? `https://…/${HOOK_MARKER}${token}` : text.slice(urlStart, index + token.length);
	return maskWebhook(raw);
}

/** 仓库内需要扫描的文件：git 跟踪 + 未忽略的新文件（排除 .git 自身） */
export function listIndexFiles({ root = process.cwd() } = {}) {
	const tracked = gitLines(root, ["ls-files", "-z"]);
	const untracked = gitLines(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
	const seen = new Map();
	for (const file of tracked) seen.set(file, "tracked");
	for (const file of untracked) if (!seen.has(file)) seen.set(file, "untracked");
	return [...seen.entries()].map(([path, scope]) => ({ path, scope }));
}

/**
 * git 仓库根（索引扫描的锚点）。
 *
 * 为什么需要它：`git ls-files` 在子目录里只会列出该子目录下的文件。单仓三包之后
 * 从 `packages/cli` 跑闸门就必须显式回到仓库根，否则根目录与其它包是盲区。
 * 不在 git 仓库里（返回 null）时由调用方退回传入的目录。
 */
export function gitTopLevel(dir = process.cwd()) {
	try {
		const out = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			maxBuffer: 1024 * 1024,
		});
		const top = out.trim();
		return top === "" ? null : top;
	} catch {
		return null;
	}
}

/** 本文件所在的包目录（向上找最近的 package.json）。用于 `npm pack` 的目标。 */
export function packageRootOfModule() {
	let dir = dirname(fileURLToPath(import.meta.url));
	for (;;) {
		if (existsSync(join(dir, "package.json"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/**
 * 目录的真实路径。存在的目录一律 realpath 一下，因为 `git rev-parse --show-toplevel` 给的是真实路径，
 * 而 `mkdtempSync(tmpdir())` 在 macOS 上给的是符号链接路径（/var → /private/var）——
 * 两边不统一，`path.relative` 就会产出 `../../..` 这种垃圾路径。
 */
function realDir(path) {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function gitLines(root, args) {
	try {
		const out = execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
		return out.split("\0").filter(Boolean);
	} catch (error) {
		throw new Error(`git ${args[0]} 失败（root=${root}）：${error.message}`);
	}
}

/** `npm pack --dry-run --json` 的发布产物清单（相对路径） */
export function packFileList({ root = process.cwd(), npm = process.env.npm_execpath ? process.execPath : "npm" } = {}) {
	const args = npm === process.execPath ? [process.env.npm_execpath, "pack", "--dry-run", "--json"] : ["pack", "--dry-run", "--json"];
	const out = execFileSync(npm, args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, env: { ...process.env, npm_config_loglevel: "silent" } });
	const parsed = JSON.parse(out);
	if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("npm pack --dry-run --json 输出为空");
	const files = parsed[0].files;
	if (!Array.isArray(files)) throw new Error("npm pack --dry-run --json 缺少 files 字段");
	return files.map((entry) => entry.path);
}

/**
 * 本机 live 文件：这些位置是"真实地址可能出现在机器上的地方"。
 *
 * Step 2 之后地址从发送端脚本挪进了配置（config.json），因此配置文件也必须是 live 源 ——
 * 否则"把本机真实地址抄进仓库"这条闸门会随着迁移而失效。
 */
export function defaultLiveFiles() {
	const home = homedir();
	const configDir = process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim() !== "" ? process.env.XDG_CONFIG_HOME : join(home, ".config");
	return [
		join(home, ".local/bin/feishu-notify"),
		join(configDir, "feishu-notify", "config.json"),
		join(home, ".config/opencode/plugins/feishu-notify.ts"),
		join(home, ".claude/settings.json"),
	];
}

/** 从 live 文件里提取 token 集合（只留内存） */
export function liveTokens({ files = defaultLiveFiles() } = {}) {
	const tokens = new Map();
	for (const file of files) {
		let text;
		try {
			text = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		for (const hit of rawHookTokens(text)) tokens.set(hit.token, file);
	}
	return tokens;
}

/**
 * 主扫描。返回 { ok, root, packRoot, scanned, hits, warnings, liveTokenCount }。
 * ok=false 时调用方必须让它变成非零退出。
 *
 * 参数：
 *   - root    索引扫描的入口目录（自动上溯到 git 仓库根；不在仓库里就用它自己）
 *   - packRoot 跑 `npm pack` 的包目录（默认与 root 相同）；单仓三包下由 CLI 显式传入本包目录
 *   - scanned 里的路径一律**相对索引根**，与 hits.file 同一坐标系
 */
export function scanRepository({ root = process.cwd(), packRoot = root, includePack = true, liveFiles } = {}) {
	const hits = [];
	const warnings = [];
	const scanned = [];

	// 索引锚点：永远回到 git 仓库根（子目录里跑也不漏根目录与其它包）
	const indexRoot = gitTopLevel(root) ?? realDir(root);
	const packDir = realDir(packRoot);

	// 索引来源
	const targets = [];
	const seen = new Set();
	try {
		for (const entry of listIndexFiles({ root: indexRoot })) {
			const absolute = resolve(indexRoot, entry.path);
			seen.add(absolute);
			targets.push({ path: entry.path, scope: entry.scope, absolute });
		}
	} catch (error) {
		hits.push({ file: "<git>", scope: "repo", line: 0, value: "-", reason: "git-failed", detail: error.message });
	}

	// 发布产物来源（相对包根 → 统一换算成相对索引根）
	if (includePack) {
		try {
			for (const rel of packFileList({ root: packDir })) {
				const absolute = resolve(packDir, rel);
				if (seen.has(absolute)) continue;
				seen.add(absolute);
				targets.push({ path: relative(indexRoot, absolute) || rel, scope: "pack", absolute });
			}
		} catch (error) {
			hits.push({ file: "<npm pack>", scope: "pack", line: 0, value: "-", reason: "pack-failed", detail: error.message });
		}
	}

	if (targets.length === 0) warnings.push("没有扫到任何文件（既没有 git 索引文件，也没有 pack 产物）——闸门形同虚设，请检查 root");

	const tokens = liveTokens({ files: liveFiles });

	for (const { path, scope, absolute } of targets) {
		let buffer;
		try {
			const stat = statSync(absolute, { throwIfNoEntry: false });
			if (!stat || !stat.isFile()) continue;
			if (stat.size > MAX_FILE_BYTES) {
				warnings.push(`跳过超大文件（>${MAX_FILE_BYTES}B）：${path}`);
				continue;
			}
			buffer = readFileSync(absolute);
		} catch (error) {
			warnings.push(`读取失败，跳过：${path}（${error.code ?? error.message}）`);
			continue;
		}

		if (buffer.includes(0)) {
			warnings.push(`跳过二进制文件：${path}`);
			continue;
		}
		const text = buffer.toString("utf8");
		scanned.push(relative(indexRoot, absolute) || path);

		for (const hit of findHookTokens(text, { liveTokens: tokens })) {
			const line = text.slice(0, hit.index).split("\n").length;
			hits.push({
				file: relative(indexRoot, absolute) || path,
				scope,
				line,
				value: hit.value,
				reason: hit.live ? "live-hook-leak" : "hook-token",
				detail: hit.live ? `与本机 live 文件（${tokens.get(hit.token)}）里的地址相同` : undefined,
			});
		}

		// 通用凭据形态：只报形态名，绝不回传命中串（findCredentials 的返回值里本来就没有）
		for (const hit of findCredentials(text)) {
			const line = text.slice(0, hit.index).split("\n").length;
			hits.push({
				file: relative(indexRoot, absolute) || path,
				scope,
				line,
				value: "<REDACTED>",
				reason: "credential",
				detail: `凭据形态：${hit.id}`,
			});
		}
	}

	return { ok: hits.length === 0, root: indexRoot, packRoot: packDir, scanned, hits, warnings, liveTokenCount: tokens.size };
}

/** 供测试与 CLI 复用：把结果格式化成可读文本 */
export function formatReport(result) {
	const lines = ["密钥闸门 secret-scan"];
	lines.push(`  root：${result.root}`);
	if (result.packRoot && result.packRoot !== result.root) lines.push(`  pack root：${result.packRoot}`);
	lines.push(`  扫描文件：${result.scanned.length} 个（git 索引 + pack 产物去重）`);
	lines.push(`  本机 live 指纹：${result.liveTokenCount} 个（仅内存比对，不打印）`);
	for (const warning of result.warnings) lines.push(`  ⚠ ${warning}`);
	if (result.ok) {
		lines.push("  ✓ 未发现真实 hook token 或具名凭据");
		return lines.join("\n");
	}
	lines.push(`  ✗ 命中 ${result.hits.length} 处：`);
	for (const hit of result.hits) {
		lines.push(`    - ${hit.file}:${hit.line} [${hit.scope}] ${hit.reason} ${hit.value}${hit.detail ? ` — ${hit.detail}` : ""}`);
	}
	lines.push("  修复：把真实地址/凭据换成 <PLACEHOLDER> 或占位形态，或改为从配置/环境读取。");
	return lines.join("\n");
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------- CLI

function main(argv) {
	const args = new Set(argv);
	const json = args.has("--json");
	const noPack = args.has("--no-pack");
	const rootIndex = argv.indexOf("--root");
	const explicit = rootIndex !== -1;
	const given = explicit ? resolve(argv[rootIndex + 1] ?? ".") : process.cwd();

	// 明确给了 --root（测试注入的仓库）→ 就扫它、并在它里面 pack；
	// 否则索引锚点回到 git 仓库根、pack 打在本包目录 —— 单仓三包下的正确分工。
	const root = explicit ? given : (gitTopLevel(given) ?? given);
	const packRoot = explicit ? given : (packageRootOfModule() ?? root);

	const result = scanRepository({ root, packRoot, includePack: !noPack });
	if (json) console.log(JSON.stringify(result, null, 2));
	else console.log(formatReport(result));
	process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main(process.argv.slice(2));
}
