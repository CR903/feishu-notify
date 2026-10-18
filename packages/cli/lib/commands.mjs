/**
 * lib/commands.mjs — `init` / `channel` / `doctor` 的实现（implement.md Step 3）
 *
 * 放在 lib 而不是 bin 里：bin 只做参数分发，逻辑要能被测试直接 import
 * （tests/init.test.mjs 既 import 本模块，也 spawn bin 走端到端）。
 *
 * 铁律（与 config.mjs 一致）：
 *   1. **任何输出都不出现 webhook 明文** —— 一律 maskWebhook；--json 也只用掩码。
 *   2. 全缺配置 → exit 2 + 引导语，绝不回退内置地址。
 *   3. `init` 先发测试卡片验证，**验证失败不落盘**。
 *   4. 坏 JSON 绝不自动覆盖（要 --force，且覆盖前先备份成 .bak.<时间戳>）。
 *
 * 退出码：
 *   0 成功 ／ 1 用法或运行期失败（发卡失败、channel 已存在…）／ 2 配置问题（缺/坏/找不到）
 */

import { copyFileSync, chmodSync, statSync } from "node:fs";
import { createInterface } from "node:readline/promises";

import {
	CONFIG_VERSION,
	ConfigError,
	DEFAULT_FOOTER,
	FOOTER_MAX_LENGTH,
	assertChannelName,
	configLoadError,
	configPath,
	effectiveFooter,
	maskWebhook,
	readConfig,
	removeChannel,
	resolveFooter,
	resolveWebhook,
	setActiveChannel,
	upsertChannel,
	validateFooter,
	validateWebhook,
	writeConfig,
} from "./config.mjs";
import { CommandError } from "./errors.mjs";
import { makeIo, say, takeValue } from "./io.mjs";
import { sendTestCard, shortBody } from "./sender.mjs";
import { checkWiring, renderWiring } from "./wiring.mjs";

// CommandError 的实现在 lib/errors.mjs（中断与 install.mjs 的循环依赖）；
// 这里再导出一次，bin 与测试继续从 commands.mjs 取它，调用方无需知道它搬过家。
export { CommandError };

// ---------------------------------------------------------------- io / 参数

/** --config <path> → 通过 FEISHU_NOTIFY_CONFIG 生效（与解析层同一份路径逻辑） */
function applyConfigOverride(env, configFilePath) {
	if (configFilePath === undefined) return { ...env };
	if (typeof configFilePath !== "string" || configFilePath.trim() === "") {
		throw new CommandError("--config 需要一个非空路径", { reason: "usage" });
	}
	return { ...env, FEISHU_NOTIFY_CONFIG: configFilePath };
}

function requireNoPositional(rest, commandName) {
	if (rest.length > 0) throw new CommandError(`${commandName} 不认识这些参数：${rest.join(" ")}`, { reason: "usage" });
}

// ---------------------------------------------------------------- 渲染（只输出掩码）

function renderChannels(config, { markActive = true, indent = "  " } = {}) {
	const names = Object.keys(config.channels);
	if (names.length === 0) return [`${indent}（无）`];
	const width = names.reduce((max, name) => Math.max(max, name.length), 0);
	return names.map((name) => {
		const entry = config.channels[name] ?? {};
		const marker = markActive && config.activeChannel === name ? "*" : " ";
		const label = entry.label ? `  label=${entry.label}` : "";
		return `${indent}${marker} ${name.padEnd(width)}  ${maskWebhook(entry.webhook)}${label}`;
	});
}

function renderResolvedSummary({ env, config }) {
	// 解析演示：把 env 里的 FEISHU_NOTIFY_WEBHOOK 摘掉，才能演示"配置路径"本身落在哪个 channel
	const probeEnv = { ...env };
	delete probeEnv.FEISHU_NOTIFY_WEBHOOK;
	const resolved = resolveWebhook({ env: probeEnv, config });
	return `  source=${resolved.source}${resolved.channelName ? ` channel=${resolved.channelName}` : ""} → ${maskWebhook(resolved.webhook)}`;
}

function configPathLine(file) {
	return `  配置文件：${file}`;
}

/**
 * 自检卡片（init 的验证卡、doctor 的逐 channel 测试卡）必须**带上当前生效的 footer**，
 * 否则用户看不出自己配的 footer 到底生效没有 —— 卡片是唯一能"预览真实外观"的地方。
 * `effectiveFooter()` 永不抛：手改坏的 footer 降级成中性默认，不拦下 doctor 的主流程。
 */
function selfCheckCardOptions({ webhook, channelName, label, config }) {
	return { webhook, channelName, label, footer: effectiveFooter(config) };
}

/** footer 是人类可读的展示文本（不是密钥），可明文打印；空串含义特殊，单独标注 */
function renderFooter(footer, { source } = {}) {
	const shown = footer === "" ? "<空>（卡片只显示时间戳）" : footer;
	return source ? `  footer：${shown}（source=${source}）` : `  footer：${shown}`;
}

/** 读配置，失败即抛带引导语的 ConfigError（exit 2） */
function loadConfigOrThrow({ env }) {
	const loaded = readConfig({ env });
	if (!loaded.ok) throw configLoadError(loaded);
	return loaded;
}

// ---------------------------------------------------------------- 交互输入

async function readAllStdin(stream) {
	const chunks = [];
	for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
	return Buffer.concat(chunks).toString("utf8");
}

async function promptWebhook(io) {
	const rl = createInterface({ input: io.stdin, output: io.stderr, terminal: Boolean(io.stdin.isTTY) });
	try {
		// 提示写 stderr，stdout 留给结果；输入由终端回显（介意就别用交互式，用 --webhook-stdin）
		const answer = await rl.question("飞书机器人 webhook URL（https://open.feishu.cn/open-apis/bot/v2/hook/…）: ");
		return answer.trim();
	} finally {
		rl.close();
	}
}

/** 决定本次要写入的 webhook 原文：--webhook > --webhook-stdin > 交互式提问 */
async function readWebhookInput({ options, io }) {
	if (options.webhookFromStdin && options.webhook !== undefined) {
		throw new CommandError("--webhook 与 --webhook-stdin 只能给一个（后者用于避免明文进 argv）", { reason: "usage" });
	}
	if (options.webhookFromStdin) {
		const value = (await readAllStdin(io.stdin)).trim();
		if (value === "") throw new CommandError("--webhook-stdin 没有从 stdin 读到内容", { reason: "usage" });
		return value;
	}
	if (options.webhook !== undefined) return options.webhook;
	if (!io.stdin.isTTY) {
		throw new CommandError(
			"非交互环境（stdin 不是终端）。请用：\n" +
				"  feishu-notify-cli init --non-interactive --webhook <url> [--channel <name>]\n" +
				"  或把地址从 stdin 传入：feishu-notify-cli init --non-interactive --webhook-stdin",
			{ reason: "usage" },
		);
	}
	return await promptWebhook(io);
}

// ---------------------------------------------------------------- init

function parseInitFlags(argv) {
	const options = { nonInteractive: false, webhook: undefined, webhookFromStdin: false, channel: undefined, label: undefined, footer: undefined, config: undefined, noVerify: false, force: false };
	const rest = [];
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		switch (arg) {
			case "--non-interactive":
				options.nonInteractive = true;
				break;
			case "--webhook":
				options.webhook = takeValue(argv, ++index, "--webhook");
				break;
			case "--webhook-stdin":
				options.webhookFromStdin = true;
				break;
			case "--channel":
				options.channel = takeValue(argv, ++index, "--channel");
				break;
			case "--label":
				options.label = takeValue(argv, ++index, "--label");
				break;
			case "--footer":
				// 允许显式传空串（= 只显示时间戳）：takeValue 只拒绝缺值/下一个是 flag
				options.footer = takeValue(argv, ++index, "--footer");
				break;
			case "--config":
				options.config = takeValue(argv, ++index, "--config");
				break;
			case "--no-verify":
				options.noVerify = true;
				break;
			case "--force":
				options.force = true;
				break;
			default:
				rest.push(arg);
		}
	}
	requireNoPositional(rest, "init");
	return options;
}

export async function commandInit(argv, { env: baseEnv = process.env, io: rawIo, spawn, send = sendTestCard } = {}) {
	const io = makeIo(rawIo);
	const options = parseInitFlags(argv);
	const env = applyConfigOverride(baseEnv, options.config);

	const webhook = validateWebhook(await readWebhookInput({ options, io }), { source: options.webhookFromStdin ? "--webhook-stdin" : "--webhook" });
	const name = assertChannelName(options.channel ?? "default");
	const file = configPath({ env });
	// footer 先校验再发卡：一个不合法的 --footer 不该先浪费一张测试卡片
	const footerInput = options.footer !== undefined ? validateFooter(options.footer, { source: "--footer" }) : undefined;

	const existing = readConfig({ env });
	let config;
	let replacingBroken = false;

	if (existing.ok) {
		const previous = existing.config.channels[name];
		const label = options.label !== undefined ? options.label : previous?.label;
		config = upsertChannel(existing.config, name, { webhook, label }, { force: true });
		config.activeChannel = name;
		if (previous && previous.webhook !== webhook) {
			say(io, `  ↻ 覆盖已有 channel "${name}" 的地址（原地址 ${maskWebhook(previous.webhook)}）`);
		}
	} else if (existing.reason === "missing") {
		config = { version: CONFIG_VERSION, activeChannel: name, channels: { [name]: options.label !== undefined ? { webhook, label: options.label } : { webhook } } };
	} else {
		if (!options.force) {
			throw new ConfigError(
				`现有配置文件不可用，**不会自动覆盖**：${existing.path}\n  ${existing.message}\n` +
					`  请先自行备份/修复；确实要重建请加 --force（会先备份成 .bak.<时间戳>）。`,
				{ reason: `refuse-overwrite-${existing.reason}` },
			);
		}
		replacingBroken = true;
		config = { version: CONFIG_VERSION, activeChannel: name, channels: { [name]: options.label !== undefined ? { webhook, label: options.label } : { webhook } } };
	}

	// --footer 给了就写（覆盖）；没给时，已有配置里的 footer 由 cloneConfig 原样保留
	if (footerInput !== undefined) config = withFooter(config, footerInput);

	say(io, "feishu-notify init");
	say(io, configPathLine(file));
	say(io, `  channel：${name}${options.label !== undefined ? `（label=${options.label}）` : ""}`);
	say(io, `  webhook：${maskWebhook(webhook)}`);
	say(io, renderFooter(config.footer ?? DEFAULT_FOOTER, { source: config.footer === undefined ? "default" : "config" }));

	// 先验证，后落盘：验证失败什么都不写
	if (!options.noVerify) {
		say(io, "  ▸ 发送测试卡片验证地址…");
		const result = await send({ ...selfCheckCardOptions({ webhook, channelName: name, label: options.label, config }), spawn, env: baseEnv });
		if (!result.ok) {
			throw new CommandError(
				`❌ 测试卡片没发出去，**未写入任何配置**：${result.message}\n` +
					`  请确认 webhook 是否正确、机器人是否启用、网络是否可达。\n` +
					`  确认无需验证可加 --no-verify（不推荐）。`,
				{ reason: "verify-failed" },
			);
		}
		say(io, `  ✓ 测试卡片已送达（${result.message}，${result.elapsedMs}ms）`);
	} else {
		say(io, "  ⚠ 已跳过测试卡片（--no-verify）：地址未经实测");
	}

	if (replacingBroken) {
		const backup = backupConfig(file);
		say(io, `  ⚠ 原文件已损坏，先备份到：${backup}`);
	}

	const written = writeConfig(config, { env, force: options.force });
	say(io, `✅ 配置已写入：${written}（${modeOf(written)}）`);
	say(io, `  activeChannel：${config.activeChannel}`);
	say(io, "  channels：");
	for (const line of renderChannels(config)) say(io, line);
	say(io, "  解析优先级：--webhook > --channel > FEISHU_NOTIFY_WEBHOOK > activeChannel > 报错退出");
	say(io, `  解析演示（不带 --webhook/--channel）：`);
	say(io, renderResolvedSummary({ env, config }));
	say(io, `  下一步：npx feishu-notify-cli doctor（逐 channel 实测可达性）`);
	return 0;
}

function backupConfig(file) {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const backup = `${file}.bak.${stamp}`;
	copyFileSync(file, backup);
	chmodSync(backup, 0o600);
	return backup;
}

/** 把 footer 放到 activeChannel 之后（键序固定，配置文件 diff 才可读） */
function withFooter(config, footer) {
	const next = { version: config.version };
	if (config.activeChannel !== undefined) next.activeChannel = config.activeChannel;
	next.footer = footer;
	next.channels = config.channels;
	return next;
}

function modeOf(file) {
	try {
		return `权限 ${(statSync(file).mode & 0o777).toString(8)}`;
	} catch {
		return "权限未知";
	}
}

// ---------------------------------------------------------------- channel

function parseChannelFlags(argv, { mode }) {
	const allowed = {
		list: new Set(["--config", "--json"]),
		add: new Set(["--config", "--webhook", "--webhook-stdin", "--label", "--set-active", "--no-verify", "--force"]),
		remove: new Set(["--config", "--force"]),
		"set-active": new Set(["--config"]),
	}[mode];
	if (!allowed) throw new CommandError(`内部错误：未知的 channel 子命令模式 ${mode}`, { reason: "internal" });

	const options = { config: undefined, json: false, webhook: undefined, webhookFromStdin: false, label: undefined, setActive: false, noVerify: false, force: false, name: undefined };
	const positionals = [];
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		const flagsTakingValue = new Set(["--config", "--webhook", "--label"]);
		if (flagsTakingValue.has(arg)) {
			if (!allowed.has(arg)) throw new CommandError(`channel ${mode} 不接受 ${arg}`, { reason: "usage" });
			const value = takeValue(argv, ++index, arg);
			if (arg === "--config") options.config = value;
			else if (arg === "--webhook") options.webhook = value;
			else options.label = value;
			continue;
		}
		if (arg.startsWith("--")) {
			if (!allowed.has(arg)) throw new CommandError(`channel ${mode} 不接受 ${arg}`, { reason: "usage" });
			if (arg === "--json") options.json = true;
			else if (arg === "--webhook-stdin") options.webhookFromStdin = true;
			else if (arg === "--set-active") options.setActive = true;
			else if (arg === "--no-verify") options.noVerify = true;
			else if (arg === "--force") options.force = true;
			continue;
		}
		positionals.push(arg);
	}
	if (positionals.length > 1) throw new CommandError(`参数太多：${positionals.join(" ")}`, { reason: "usage" });
	options.name = positionals[0];
	return options;
}

export async function commandChannel(argv, { env: baseEnv = process.env, io: rawIo, spawn, send = sendTestCard } = {}) {
	const io = makeIo(rawIo);
	const [sub, ...rest] = argv;

	switch (sub) {
		case "list":
			return channelList(rest, { baseEnv, io });
		case "add":
			return await channelAdd(rest, { baseEnv, io, spawn, send });
		case "remove":
		case "rm":
			return channelRemove(rest, { baseEnv, io });
		case "set-active":
			return channelSetActive(rest, { baseEnv, io });
		case "help":
		case "--help":
		case "-h":
			say(io, channelUsage());
			return 0;
		case undefined:
			throw new CommandError(`channel 需要子命令（list / add / remove / set-active）\n\n${channelUsage()}`, { reason: "usage" });
		default:
			throw new CommandError(`未知的 channel 子命令：${sub}\n\n${channelUsage()}`, { reason: "usage" });
	}
}

function channelList(argv, { baseEnv, io }) {
	const options = parseChannelFlags(argv, { mode: "list" });
	const env = applyConfigOverride(baseEnv, options.config);
	const { config, path } = loadConfigOrThrow({ env });

	if (options.json) {
		say(
			io,
			JSON.stringify(
				{
					configPath: path,
					activeChannel: config.activeChannel ?? null,
					footer: config.footer ?? DEFAULT_FOOTER,
					footerSource: config.footer === undefined ? "default" : "config",
					channels: Object.entries(config.channels).map(([name, entry]) => ({
						name,
						label: entry.label ?? null,
						webhook: maskWebhook(entry.webhook), // 只给掩码：--json 也可能被写进日志
						active: config.activeChannel === name,
					})),
				},
				null,
				2,
			),
		);
		return 0;
	}

	say(io, "feishu-notify channel list");
	say(io, configPathLine(path));
	say(io, renderFooter(config.footer ?? DEFAULT_FOOTER, { source: config.footer === undefined ? "default" : "config" }));
	say(io, `  channels（${Object.keys(config.channels).length}）：`);
	for (const line of renderChannels(config)) say(io, line);
	say(io, "  （* = activeChannel；webhook 只显示掩码，明文只在配置文件里）");
	say(io, `  下一步：npx feishu-notify-cli doctor`);
	return 0;
}

async function channelAdd(argv, { baseEnv, io, spawn, send }) {
	const options = parseChannelFlags(argv, { mode: "add" });
	const env = applyConfigOverride(baseEnv, options.config);
	if (options.name === undefined) throw new CommandError(`channel add 需要 <name>\n\n${channelUsage()}`, { reason: "usage" });
	const name = assertChannelName(options.name);

	const webhook = validateWebhook(await readWebhookInput({ options, io }), { source: options.webhookFromStdin ? "--webhook-stdin" : "--webhook" });
	const loaded = readConfig({ env });
	const file = loaded.path;
	const existing = loaded.ok ? loaded.config : null;
	if (!loaded.ok && loaded.reason !== "missing") throw configLoadError(loaded);

	if (existing && existing.channels[name] !== undefined && !options.force) {
		throw new CommandError(`channel "${name}" 已存在。要覆盖请加 --force（或先 channel remove）。`, { reason: "channel-exists" });
	}

	say(io, "feishu-notify channel add");
	say(io, configPathLine(file));
	say(io, `  channel：${name}`);
	say(io, `  webhook：${maskWebhook(webhook)}`);

	// 先把要写的 config 算出来（与发卡无关），自检卡片才能带上"当前生效的 footer"
	let config = existing ?? { version: CONFIG_VERSION, activeChannel: name, channels: {} };
	config = upsertChannel(config, name, { webhook, label: options.label }, { force: options.force });

	if (!options.noVerify) {
		say(io, "  ▸ 发送测试卡片验证地址…");
		const result = await send({ ...selfCheckCardOptions({ webhook, channelName: name, label: options.label, config }), spawn, env: baseEnv });
		if (!result.ok) {
			throw new CommandError(
				`❌ 测试卡片没发出去，**未写入任何配置**：${result.message}\n  确认无需验证可加 --no-verify（不推荐）。`,
				{ reason: "verify-failed" },
			);
		}
		say(io, `  ✓ 测试卡片已送达（${result.message}，${result.elapsedMs}ms）`);
	}

	if (options.setActive || config.activeChannel === undefined) config.activeChannel = name;

	const written = writeConfig(config, { env, force: options.force });
	say(io, `✅ 已写入：${written}（${modeOf(written)}）`);
	say(io, `  activeChannel：${config.activeChannel}`);
	for (const line of renderChannels(config)) say(io, line);
	return 0;
}

function channelRemove(argv, { baseEnv, io }) {
	const options = parseChannelFlags(argv, { mode: "remove" });
	const env = applyConfigOverride(baseEnv, options.config);
	if (options.name === undefined) throw new CommandError(`channel remove 需要 <name>\n\n${channelUsage()}`, { reason: "usage" });
	const name = options.name;

	const { config, path } = loadConfigOrThrow({ env });
	if (config.activeChannel === name && !options.force) {
		throw new CommandError(
			`"${name}" 是当前 activeChannel，删掉它会让默认解析失效。\n` +
				`  先把别的设为默认：npx feishu-notify-cli channel set-active <name>\n` +
				`  或确认要用剩下第一个 channel 当默认：channel remove ${name} --force`,
			{ reason: "remove-active-channel" },
		);
	}

	let next = removeChannel(config, name);
	if (next.activeChannel === name) {
		next = setActiveChannel(next, Object.keys(next.channels)[0]);
		say(io, `  ↻ activeChannel 改为：${next.activeChannel}`);
	}

	const written = writeConfig(next, { env });
	say(io, `✅ 已删除 channel "${name}"（配置文件：${written}，${modeOf(written)}）`);
	say(io, `  activeChannel：${next.activeChannel}`);
	for (const line of renderChannels(next)) say(io, line);
	return 0;
}

function channelSetActive(argv, { baseEnv, io }) {
	const options = parseChannelFlags(argv, { mode: "set-active" });
	const env = applyConfigOverride(baseEnv, options.config);
	if (options.name === undefined) throw new CommandError(`channel set-active 需要 <name>\n\n${channelUsage()}`, { reason: "usage" });

	const { config, path } = loadConfigOrThrow({ env });
	const next = setActiveChannel(config, options.name);
	const written = writeConfig(next, { env });
	say(io, `✅ activeChannel 已设为 "${next.activeChannel}"（配置文件：${written}，${modeOf(written)}）`);
	say(io, configPathLine(path));
	for (const line of renderChannels(next)) say(io, line);
	return 0;
}

function channelUsage() {
	return [
		"用法: feishu-notify-cli channel <list|add|remove|set-active> [参数]",
		"",
		"  channel list [--config <path>] [--json]",
		"  channel add <name> (--webhook <url> | --webhook-stdin) [--label <文本>] [--set-active] [--no-verify] [--force]",
		"  channel remove <name> [--force]",
		"  channel set-active <name>",
		"",
		"所有输出只显示掩码；真正的 webhook 明文只存在配置文件里（0600）。",
		"卡片底部的 footer 用 `feishu-notify-cli footer` 查看（它不是密钥，可明文显示）。",
	].join("\n");
}

// ---------------------------------------------------------------- footer

function parseFooterFlags(argv) {
	const options = { config: undefined, json: false };
	const rest = [];
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		switch (arg) {
			case "--config":
				options.config = takeValue(argv, ++index, "--config");
				break;
			case "--json":
				options.json = true;
				break;
			default:
				rest.push(arg);
		}
	}
	requireNoPositional(rest, "footer");
	return options;
}

/**
 * `footer` —— 给**发送端**用的取值入口：stdout 只放 footer 字符串（便于 bash 直接赋值）。
 *
 * 退出码语义刻意与 `resolve` 一致，因为发送端要能区分两种情况：
 *   0 + stdout=""  → 配置里明确写了空 footer（只显示时间戳）
 *   非 0           → 配置缺失/坏 → 发送端回退到中性默认 DEFAULT_FOOTER（绝不因此不发卡）
 * `source=…` 打到 stderr，与 `resolve` 的风格一致。
 */
export function commandFooter(argv, { env: baseEnv = process.env, io: rawIo } = {}) {
	const io = makeIo(rawIo);
	const options = parseFooterFlags(argv);
	const env = applyConfigOverride(baseEnv, options.config);

	const resolved = resolveFooter({ env }); // 配置问题 → ConfigError(exit 2)
	if (options.json) {
		say(io, JSON.stringify({ ...resolved, default: DEFAULT_FOOTER, maxLength: FOOTER_MAX_LENGTH }, null, 2));
		return 0;
	}
	say(io, resolved.footer); // 允许为空行：空 == 只显示时间戳
	console.error(`source=${resolved.source}${resolved.path ? ` config=${resolved.path}` : ""}`);
	return 0;
}

// ---------------------------------------------------------------- doctor

function parseDoctorFlags(argv) {
	const options = { config: undefined, json: false, channel: undefined };
	const rest = [];
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		switch (arg) {
			case "--config":
				options.config = takeValue(argv, ++index, "--config");
				break;
			case "--json":
				options.json = true;
				break;
			case "--channel":
				options.channel = takeValue(argv, ++index, "--channel");
				break;
			default:
				rest.push(arg);
		}
	}
	requireNoPositional(rest, "doctor");
	return options;
}

export async function commandDoctor(argv, { env: baseEnv = process.env, io: rawIo, spawn, send = sendTestCard } = {}) {
	const io = makeIo(rawIo);
	const options = parseDoctorFlags(argv);
	const env = applyConfigOverride(baseEnv, options.config);
	const { config, path } = loadConfigOrThrow({ env });

	let names = Object.keys(config.channels);
	if (options.channel !== undefined) {
		if (!Object.prototype.hasOwnProperty.call(config.channels, options.channel)) {
			throw new ConfigError(
				`配置里没有名为 "${options.channel}" 的 channel（已有：${names.join(", ")}）\n  配置文件：${path}`,
				{ reason: "channel-not-found" },
			);
		}
		names = [options.channel];
	}

	// 接线自检（R11/AC10）：真实 hook 走的是"发送端 → 解析器 → Node"这条链，
	// 它和"doctor 自己跑得动"是两件事。放在发卡之前：它是免费的，且故障模式是静默的。
	const wiring = checkWiring({ env: baseEnv });

	const envOverride = baseEnv.FEISHU_NOTIFY_WEBHOOK;
	const report = {
		configPath: path,
		activeChannel: config.activeChannel ?? null,
		footer: config.footer ?? DEFAULT_FOOTER,
		footerSource: config.footer === undefined ? "default" : "config",
		envOverride: envOverride ? maskWebhook(envOverride) : null,
		wiring,
		channels: [],
	};

	if (!options.json) {
		say(io, "feishu-notify doctor");
		say(io, configPathLine(path));
		say(io, `  activeChannel：${config.activeChannel ?? "<未设置>"}`);
		say(io, renderFooter(config.footer ?? DEFAULT_FOOTER, { source: config.footer === undefined ? "default" : "config" }));
		say(io, `  channels（${Object.keys(config.channels).length}）：`);
		for (const line of renderChannels(config)) say(io, line);
		if (envOverride) {
			say(io, `  ⚠ 环境变量 FEISHU_NOTIFY_WEBHOOK 已设置（${maskWebhook(envOverride)}）：发送端会**优先**用它，覆盖 activeChannel`);
		} else {
			say(io, "  环境变量 FEISHU_NOTIFY_WEBHOOK：未设置（发送端走 activeChannel）");
		}
		for (const line of renderWiring(wiring)) say(io, line);
		say(io, `  ▸ 逐 channel 发测试卡片（真实发出，用于确认可达性；卡片带当前 footer）…`);
	}

	for (const name of names) {
		const entry = config.channels[name];
		let webhook = null;
		let validationError = null;
		try {
			webhook = validateWebhook(entry.webhook, { source: `channel "${name}"` });
		} catch (error) {
			validationError = error instanceof Error ? error.message : String(error);
		}

		if (webhook === null) {
			const firstLine = (validationError ?? "地址不可用").split("\n")[0];
			report.channels.push({ name, ok: false, reason: "invalid-webhook", detail: firstLine, webhook: maskWebhook(entry.webhook) });
			if (!options.json) say(io, `  ✗ ${name.padEnd(12)} 地址不可用：${firstLine}`);
			continue;
		}

		const result = await send({ ...selfCheckCardOptions({ webhook, channelName: name, label: entry.label, config }), spawn, env: baseEnv });
		report.channels.push({
			name,
			ok: result.ok,
			webhook: maskWebhook(webhook),
			httpCode: result.httpCode,
			bodyCode: result.bodyCode ?? null,
			detail: result.ok ? result.message : `${result.message}${result.body ? `：${shortBody(result.body)}` : ""}`,
			elapsedMs: result.elapsedMs,
		});
		if (!options.json) {
			const mark = result.ok ? "✓" : "✗";
			const tail = result.ok ? `${result.message}，${result.elapsedMs}ms` : `${result.message}${result.body ? `：${shortBody(result.body)}` : ""}`;
			say(io, `  ${mark} ${name.padEnd(12)} ${tail}`);
		}
	}

	const okCount = report.channels.filter((entry) => entry.ok).length;
	const allOk = okCount === report.channels.length;
	report.ok = allOk;
	report.summary = `${okCount}/${report.channels.length} 通`;

	if (options.json) {
		say(io, JSON.stringify(report, null, 2));
		return allOk ? 0 : 1;
	}

	say(io, `  结论：${report.summary}${allOk ? "" : "（不通的看上面的 message；webhook 换新地址后重跑 doctor）"}`);
	if (!wiring.ok) {
		say(io, "  ⚠ 接线自检没通过（见上面的 ✗ 行）：即使这里每条 channel 都通，hook 环境里的通知也可能**静默失效**。");
	}
	if (!allOk) {
		say(io, `  排查：飞书机器人是否启用、token 是否被重置、网络/代理是否可达。改地址用：`);
		say(io, `    npx feishu-notify-cli channel add <name> --webhook <url>`);
	}
	const failing = report.channels.filter((entry) => !entry.ok).length;
	return failing === 0 ? 0 : 1;
}

// ---------------------------------------------------------------- usage

export function commandsUsage() {
	return [
		"  feishu-notify-cli init [--non-interactive] (--webhook <url> | --webhook-stdin) [--channel <name>] [--label <文本>] [--footer <文本>] [--config <path>] [--no-verify] [--force]",
		"      交互式或在自动化里初始化配置；**先发测试卡片验证，验证失败不落盘**，成功后写 0600",
		"  feishu-notify-cli channel list [--config <path>] [--json]",
		"  feishu-notify-cli channel add <name> (--webhook <url> | --webhook-stdin) [--label <文本>] [--set-active] [--no-verify] [--force]",
		"  feishu-notify-cli channel remove <name> [--force]",
		"  feishu-notify-cli channel set-active <name>",
		"  feishu-notify-cli footer [--config <path>] [--json]",
		"      打印卡片底部要用的 footer（stdout 只放该字符串；source=… 打到 stderr）。配置问题 → exit 2，发送端据此回退到中性默认",
		"  feishu-notify-cli doctor [--channel <name>] [--config <path>] [--json]",
		"      读配置 → **接线自检**（发送端/解析器/Node 三环，含悬空符号链接）→ 逐 channel 发测试卡片 → 报告哪条通",
		"  feishu-notify-cli install [--dry-run] [--yes] [--target <t>…|--skip <t>…] [--channel <name>]",
		"      一键接入本机已装的 agent（claude-code / opencode / dsh）；幂等、写前备份、结束打印回滚指令",
		"      细节：feishu-notify-cli install --help",
		"",
		`卡片 footer 是配置项（顶层 footer，≤${FOOTER_MAX_LENGTH} 字符、不含换行）；未配置时用中性默认 "${DEFAULT_FOOTER}"。`,
	].join("\n");
}

