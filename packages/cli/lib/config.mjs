/**
 * lib/config.mjs — webhook 配置解析（唯一真源）
 *
 * 解析优先级（design.md §2，严格按序）：
 *   1. --webhook <url>                 （flag，最高优先，且不读任何文件）
 *   2. --channel <name>                （查配置 channels[name]）
 *   3. FEISHU_NOTIFY_WEBHOOK           （env）
 *   4. 配置 activeChannel              （查配置 channels[activeChannel]）
 *   5. 全缺                            → ConfigError(exitCode 2) + 引导语
 *
 * 铁律：**任何情况下都不回退到内置地址**（AC2）。宁可报错，也不要把通知发到别人的机器人。
 * 因此本文件不包含任何默认 webhook 字面量。
 *
 * 配置文件：${XDG_CONFIG_HOME:-$HOME/.config}/feishu-notify/config.json
 *          可用 FEISHU_NOTIFY_CONFIG 覆盖路径（测试/隔离必需）。
 */

import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const CONFIG_VERSION = 1;
export const CONFIG_DIR_NAME = "feishu-notify";
export const CONFIG_FILE_NAME = "config.json";
export const ENV_CONFIG_PATH = "FEISHU_NOTIFY_CONFIG";
export const ENV_WEBHOOK = "FEISHU_NOTIFY_WEBHOOK";

/**
 * 卡片 footer 的**中性默认**（R9）。
 *
 * 改造前卡片底部硬编码的是作者公司的标识（`Smarterlab · <时间戳>`），那是"把个人/公司标识
 * 烧进发布物"，不能发布。现在是配置项 `footer`，未配置时落在这个中性值上。
 */
export const DEFAULT_FOOTER = "feishu-notify";

/** footer 长度上限（R9：≤40 字符；超出会让卡片底部挤成一坨，也会让 note 元素超长） */
export const FOOTER_MAX_LENGTH = 40;

/** 引导语：AC2 要求 stderr 必须含它 */
export const INIT_GUIDANCE = "npx feishu-notify-cli init";

/** 配置域错误：一律 exitCode 2（配置缺失/坏/不可用 —— 都是“去修配置”） */
export class ConfigError extends Error {
	constructor(message, { exitCode = 2, reason = "config" } = {}) {
		super(message);
		this.name = "ConfigError";
		this.exitCode = exitCode;
		this.reason = reason;
	}
}

// ---------------------------------------------------------------- 路径

/** 配置文件路径：FEISHU_NOTIFY_CONFIG > ${XDG_CONFIG_HOME:-$HOME/.config}/feishu-notify/config.json */
export function configPath({ env = process.env } = {}) {
	const override = env[ENV_CONFIG_PATH];
	if (typeof override === "string" && override.trim() !== "") {
		return isAbsolute(override) ? override : resolve(process.cwd(), override);
	}
	const home = env.HOME && env.HOME.trim() !== "" ? env.HOME : homedir();
	const base = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim() !== "" ? env.XDG_CONFIG_HOME : join(home, ".config");
	return join(base, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
}

// ---------------------------------------------------------------- 值校验

const PLACEHOLDER_TOKENS = /^(?:x+|xxx+|your[-_ ]?webhook|placeholder|<.*>|\.\.\.|…|你的webhook|你的地址)$/i;

/** 只允许 https；feishu/lark 域还要满足 hook 形状；占位符一律拒绝（避免“占位符静默通过”） */
export function validateWebhook(value, { source = "配置" } = {}) {
	if (typeof value !== "string" || value.trim() === "") {
		throw invalidWebhookError(value, source, "值为空");
	}
	const raw = value.trim();

	let parsed;
	try {
		parsed = new URL(raw);
	} catch {
		throw invalidWebhookError(raw, source, "不是合法 URL");
	}
	if (parsed.protocol !== "https:") {
		throw invalidWebhookError(raw, source, `协议必须是 https（当前 ${parsed.protocol.replace(":", "")}），http 会明文泄露 secret`);
	}
	if (!parsed.hostname) {
		throw invalidWebhookError(raw, source, "缺少主机名");
	}

	if (isFeishuHost(parsed.hostname)) {
		// URL 会把 < > 百分号编码掉，先解码再做占位符判定（否则 %3CPLACEHOLDER%3E 会蒙混过关）
		let pathname = parsed.pathname;
		try {
			pathname = decodeURIComponent(parsed.pathname);
		} catch {
			/* 非法百分号编码：沿用原始 pathname，交给形状校验报错 */
		}
		const segments = pathname.split("/").filter(Boolean);
		const marker = ["open-apis", "bot", "v2", "hook"];
		const okShape = segments.length === marker.length + 1 && marker.every((part, index) => segments[index] === part);
		if (!okShape) {
			throw invalidWebhookError(raw, source, "飞书机器人地址形状应为 /open-apis/bot/v2/hook/<token>");
		}
		const token = segments[marker.length];
		if (PLACEHOLDER_TOKENS.test(token)) {
			throw invalidWebhookError(raw, source, "token 看起来是占位符，请填写真实 webhook");
		}
		if (token.length < 8) {
			throw invalidWebhookError(raw, source, "token 过短，疑似不完整");
		}
	}
	return raw;
}

function isFeishuHost(hostname) {
	const host = hostname.toLowerCase();
	return host === "open.feishu.cn" || host === "open.larksuite.com" || host.endsWith(".feishu.cn") || host.endsWith(".larksuite.com");
}

function invalidWebhookError(value, source, why) {
	return new ConfigError(
		`webhook 不可用（来源：${source}）：${why}\n  当前值：${maskWebhook(value)}\n` +
			`  只接受 https:// 开头的真实地址。请运行：${INIT_GUIDANCE}`,
		{ reason: "invalid-webhook" },
	);
}

/** 掩码：保留 scheme+host，其余打掉（错误信息/doctor 里绝不打印 token） */
export function maskWebhook(value) {
	if (typeof value !== "string" || value.trim() === "") return "<空>";
	let parsed;
	try {
		parsed = new URL(value.trim());
	} catch {
		return "<非 URL 值>";
	}
	const head = `${parsed.protocol}//${parsed.host}`;
	const segments = parsed.pathname.split("/").filter(Boolean);
	if (segments.length === 0) return `${head}/<REDACTED>`;
	return `${head}/${segments.slice(0, -1).join("/")}${segments.length > 1 ? "/" : ""}<REDACTED>`;
}

// ---------------------------------------------------------------- footer（R9）

/**
 * footer 取值校验：字符串、≤40 字符、**不含换行**（换行会把 note 元素撑破）。
 * 空字符串是合法的 —— 语义是"只显示时间戳"。
 */
export function validateFooter(value, { source = "footer" } = {}) {
	if (typeof value !== "string") {
		throw new ConfigError(`${source} 必须是字符串（当前 ${typeof value}）`, { reason: "invalid-footer" });
	}
	if (value.length > FOOTER_MAX_LENGTH) {
		throw new ConfigError(`${source} 过长：${value.length} 字符，上限 ${FOOTER_MAX_LENGTH}`, { reason: "invalid-footer" });
	}
	if (/[\r\n]/.test(value)) {
		throw new ConfigError(`${source} 不能包含换行`, { reason: "invalid-footer" });
	}
	return value;
}

/**
 * 解析最终 footer。返回 `{ footer, source }`：
 *   - 配置里有 footer（含空串）→ 原样返回，source='config'（空串 = 只显示时间戳）
 *   - 配置里没有 footer         → DEFAULT_FOOTER（中性），source='default'
 *   - 配置自身缺失/坏           → 抛 ConfigError(exit 2)；调用方（发送端）据此回退到中性默认
 *
 * 注意：footer 是**装饰性**字段，发送端对它的态度是"尽力而为" ——
 * 解析不出来就用中性默认继续发，绝不因为一个装饰字段让通知发不出去。
 */
export function resolveFooter({ env = process.env, configFilePath, config } = {}) {
	const fromConfig = (raw, path) => {
		if (raw === undefined) return { footer: DEFAULT_FOOTER, source: "default", path };
		return { footer: validateFooter(raw), source: "config", path };
	};

	if (config !== undefined) return fromConfig(config.footer, configFilePath);

	const loaded = readConfig({ env, path: configFilePath });
	if (!loaded.ok) throw configLoadError(loaded);
	return fromConfig(loaded.config.footer, loaded.path);
}

// ---------------------------------------------------------------- 读配置

/**
 * 读配置文件。**只读，永不写入**（坏 JSON 绝不自动覆盖）。
 * @returns {{ok:true, path:string, config:object} | {ok:false, path:string, reason:string, message:string}}
 */
export function readConfig({ env = process.env, path } = {}) {
	const file = path ?? configPath({ env });

	let text;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		if (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "ELOOP") {
			return { ok: false, path: file, reason: "missing", message: "配置文件不存在" };
		}
		if (error.code === "EISDIR") {
			return { ok: false, path: file, reason: "unreadable", message: "该路径是目录，不是配置文件" };
		}
		return { ok: false, path: file, reason: "unreadable", message: `读取失败：${error.code ?? error.message}` };
	}

	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return { ok: false, path: file, reason: "invalid-json", message: `不是合法 JSON：${error.message}` };
	}

	const shape = validateConfigShape(parsed);
	if (!shape.ok) return { ok: false, path: file, reason: "invalid-shape", message: shape.message };

	return { ok: true, path: file, config: shape.config };
}

/** 结构校验（只校验形状；webhook 的 https 合法性留到真正使用时再判） */
export function validateConfigShape(raw) {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		return { ok: false, message: "顶层必须是 JSON 对象" };
	}
	if (raw.version === undefined) return { ok: false, message: "缺少 version 字段" };
	if (raw.version !== CONFIG_VERSION) {
		return { ok: false, message: `不支持的配置版本：${JSON.stringify(raw.version)}（本工具支持 version ${CONFIG_VERSION}）` };
	}
	if (raw.channels === undefined) return { ok: false, message: "缺少 channels 字段" };
	if (raw.channels === null || typeof raw.channels !== "object" || Array.isArray(raw.channels)) {
		return { ok: false, message: "channels 必须是对象：{ <name>: { webhook } }" };
	}
	const names = Object.keys(raw.channels);
	if (names.length === 0) return { ok: false, message: "channels 里至少要有一个 channel" };

	for (const name of names) {
		const entry = raw.channels[name];
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
			return { ok: false, message: `channels.${name} 必须是对象 { webhook, label? }` };
		}
		if (typeof entry.webhook !== "string") {
			return { ok: false, message: `channels.${name}.webhook 必须是字符串` };
		}
		if (entry.label !== undefined && typeof entry.label !== "string") {
			return { ok: false, message: `channels.${name}.label 必须是字符串` };
		}
	}
	if (raw.activeChannel !== undefined && (typeof raw.activeChannel !== "string" || raw.activeChannel.trim() === "")) {
		return { ok: false, message: "activeChannel 必须是非空字符串" };
	}
	// footer 只在**读取时**校验类型；长度/换行这类取值约束留到真正使用时（validateFooter），
	// 这样用户手改出一个不合规的 footer 会降级成中性默认，而不会连带把 webhook 解析一起弄挂。
	if (raw.footer !== undefined && typeof raw.footer !== "string") {
		return { ok: false, message: "footer 必须是字符串" };
	}
	return { ok: true, config: raw };
}

// ---------------------------------------------------------------- 解析

/**
 * 把 readConfig 的失败结果翻译成带引导语的 ConfigError（exit 2）。
 * 导出供 `channel` / `doctor` 复用 —— 引导语只保留这一份实现。
 */
export function configLoadError(loaded) {
	switch (loaded.reason) {
		case "missing":
			return new ConfigError(
				`未配置飞书机器人 webhook。请运行：${INIT_GUIDANCE}\n` +
					`  配置文件不存在：${loaded.path}\n` +
					`  （也可用 --webhook <url> 或 FEISHU_NOTIFY_WEBHOOK=<url> 临时指定）`,
				{ reason: "missing-config" },
			);
		case "invalid-json":
			return new ConfigError(
				`配置文件不是合法 JSON，**未自动覆盖**：${loaded.path}\n  ${loaded.message}\n` +
					`  请修复该文件，或先备份再运行：${INIT_GUIDANCE}`,
				{ reason: "invalid-json" },
			);
		default:
			return new ConfigError(
				`配置文件不可用：${loaded.path}\n  ${loaded.message}\n  请修复该文件，或先备份再运行：${INIT_GUIDANCE}`,
				{ reason: loaded.reason },
			);
	}
}

function channelNames(config) {
	return Object.keys(config.channels);
}

function pickChannel(loaded, name, { via }) {
	const config = loaded.config;
	const entry = Object.prototype.hasOwnProperty.call(config.channels, name) ? config.channels[name] : undefined;
	if (!entry) {
		const available = channelNames(config);
		throw new ConfigError(
			`配置里没有名为 "${name}" 的 channel（已有：${available.length > 0 ? available.join(", ") : "无"}）\n` +
				`  配置文件：${loaded.path}\n  可用 npx feishu-notify-cli channel list 查看。`,
			{ reason: "channel-not-found" },
		);
	}
	return { webhook: validateWebhook(entry.webhook, { source: `${via} "${name}"` }), channelName: name };
}

/**
 * 解析最终 webhook。返回 { webhook, source, channelName? }，失败抛 ConfigError(exitCode 2)。
 * source ∈ 'flag' | 'channel' | 'env' | 'activeChannel'
 */
export function resolveWebhook({ flagWebhook, channel, env = process.env, configFilePath, config } = {}) {
	let loaded = null;
	const load = () => {
		if (config !== undefined) return { ok: true, path: configFilePath ?? configPath({ env }), config };
		if (loaded === null) loaded = readConfig({ env, path: configFilePath });
		return loaded;
	};

	// 1. flag（不碰文件系统）
	if (flagWebhook !== undefined) {
		return { webhook: validateWebhook(flagWebhook, { source: "--webhook" }), source: "flag" };
	}

	// 2. --channel
	if (channel !== undefined && channel !== null && String(channel).trim() !== "") {
		const name = String(channel).trim();
		const current = load();
		if (!current.ok) throw configLoadError(current);
		const picked = pickChannel(current, name, { via: "channel" });
		return { ...picked, source: "channel" };
	}

	// 3. env
	const fromEnv = env[ENV_WEBHOOK];
	if (typeof fromEnv === "string" && fromEnv.trim() !== "") {
		return { webhook: validateWebhook(fromEnv, { source: ENV_WEBHOOK }), source: "env" };
	}

	// 4. activeChannel
	const current = load();
	if (!current.ok) throw configLoadError(current);
	const active = current.config.activeChannel;
	if (typeof active !== "string" || active.trim() === "") {
		throw new ConfigError(
			`配置文件里没有 activeChannel，无法确定用哪个 channel：${current.path}\n` +
				`  请运行：${INIT_GUIDANCE}  或  npx feishu-notify-cli channel set-active <name>`,
			{ reason: "no-active-channel" },
		);
	}
	const picked = pickChannel(current, active.trim(), { via: "activeChannel" });
	return { ...picked, source: "activeChannel" };
}

// ---------------------------------------------------------------- 写配置（Step 3 的 init 用；0600）

/**
 * 原子写配置：同目录 temp + rename，权限 0600，目录 0700。
 * 坏 JSON **绝不自动覆盖**（除非 force）。默认拒绝覆盖符号链接/目录。
 */
export function writeConfig(config, { path, env = process.env, force = false } = {}) {
	const shape = validateConfigShape(config);
	if (!shape.ok) throw new ConfigError(`拒绝写入结构非法的配置：${shape.message}`, { reason: "invalid-shape" });

	const file = path ?? configPath({ env });
	const dir = dirname(file);

	const existing = lstatSync(file, { throwIfNoEntry: false });
	if (existing && !force) {
		if (existing.isSymbolicLink()) {
			throw new ConfigError(
				`拒绝覆盖符号链接（避免写穿到别处）：${file}\n  如确需如此，请先自行处理该链接。`,
				{ reason: "refuse-symlink" },
			);
		}
		if (existing.isDirectory()) {
			throw new ConfigError(`拒绝覆盖目录：${file}`, { reason: "refuse-directory" });
		}
		const previous = readConfig({ env, path: file });
		if (!previous.ok && previous.reason !== "missing") {
			throw new ConfigError(
				`现有配置文件已损坏，**不会自动覆盖**：${file}\n  ${previous.message}\n  请先备份或修复，或显式使用 force。`,
				{ reason: `refuse-overwrite-${previous.reason}` },
			);
		}
	}

	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const body = `${JSON.stringify(config, null, 2)}\n`;
	const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
	try {
		writeFileSync(tmp, body, { mode: 0o600 });
		chmodSync(tmp, 0o600); // umask 之外再保险一次
		renameSync(tmp, file);
	} finally {
		rmSync(tmp, { force: true });
	}
	chmodSync(file, 0o600);
	return file;
}

// ---------------------------------------------------------------- channel 变更（纯函数，Step 3 的 init/channel 用）

/** channel 名约束：避免空白/路径符号把配置文件和错误信息搞乱 */
export const CHANNEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function assertChannelName(name, { source = "channel 名" } = {}) {
	if (typeof name !== "string" || !CHANNEL_NAME_PATTERN.test(name)) {
		throw new ConfigError(
			`${source}不合法：${JSON.stringify(name)}\n  只允许字母/数字开头，后接字母、数字、._-（最长 64 字符）`,
			{ exitCode: 1, reason: "invalid-channel-name" },
		);
	}
	return name;
}

/** 新增/覆盖一个 channel，返回**新对象**（不改入参）。activeChannel 需调用方显式决定。 */
export function upsertChannel(config, name, { webhook, label } = {}, { force = false } = {}) {
	assertChannelName(name);
	const next = cloneConfig(config);
	if (next.channels[name] !== undefined && !force) {
		throw new ConfigError(`channel "${name}" 已存在。要覆盖请加 --force。`, { exitCode: 1, reason: "channel-exists" });
	}
	const previous = next.channels[name];
	const entry = { webhook };
	if (label !== undefined) entry.label = label;
	else if (previous?.label !== undefined) entry.label = previous.label;
	next.channels[name] = entry;
	if (next.activeChannel === undefined || next.activeChannel.trim() === "") next.activeChannel = name;
	return next;
}

/** 删除一个 channel，返回新对象。删掉 activeChannel 时由调用方先改 activeChannel。 */
export function removeChannel(config, name) {
	const next = cloneConfig(config);
	if (!Object.prototype.hasOwnProperty.call(next.channels, name)) {
		throw new ConfigError(
			`配置里没有名为 "${name}" 的 channel（已有：${Object.keys(next.channels).join(", ") || "无"}）`,
			{ exitCode: 1, reason: "channel-not-found" },
		);
	}
	if (Object.keys(next.channels).length === 1) {
		throw new ConfigError("这是最后一个 channel，删掉就没有可用地址了。直接删配置文件或改用它更合适。", {
			exitCode: 1,
			reason: "last-channel",
		});
	}
	delete next.channels[name];
	return next;
}

/** 设置 activeChannel（channel 必须存在） */
export function setActiveChannel(config, name) {
	assertChannelName(name);
	if (!Object.prototype.hasOwnProperty.call(config.channels, name)) {
		throw new ConfigError(
			`配置里没有名为 "${name}" 的 channel（已有：${Object.keys(config.channels).join(", ") || "无"}）`,
			{ exitCode: 2, reason: "channel-not-found" },
		);
	}
	const next = cloneConfig(config);
	next.activeChannel = name;
	return next;
}

/** 浅拷贝 + channels 深一层，避免调用方拿到被改动的原件（footer 是顶层标量，随浅拷贝带走） */
export function cloneConfig(config) {
	const channels = {};
	for (const [name, entry] of Object.entries(config.channels ?? {})) channels[name] = { ...entry };
	const next = { version: config.version };
	if (config.activeChannel !== undefined) next.activeChannel = config.activeChannel;
	if (config.footer !== undefined) next.footer = config.footer;
	next.channels = channels;
	return next;
}
