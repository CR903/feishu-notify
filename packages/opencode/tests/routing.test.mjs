/**
 * tests/routing.test.mjs — **路由取证**：迁移后的通知到底打到哪个机器人
 *
 * 这是 implement.md Step 3.3 的取证，用 stub 掉 curl 的方式做，**零真实卡片**：
 * 把假 curl 放进 PATH，发送端（bash）照常跑完整条链（挑 node → 调 feishu-notify-cli 解析 → curl），
 * 只有最后一步被替身接住，于是我们能看见**实际打过去的 URL**。
 *
 * 三态（design §2.1 那张表）逐条取证：
 *   ① 真实配置里有 `opencode` channel        → 打到它（= 迁移前那个机器人，行为不变）
 *   ② 临时配置里只有 `default`（模拟单机器人用户） → 先失败 → 降级 → 打到**配置里的 activeChannel**
 *   ③ 配置整个不存在                          → 一次都不发，放弃并记日志
 *
 * 每个组合都从两个维度各验一遍：
 *   模块：`src/feishu-notify.ts`（包内源文件） × `~/.config/opencode/plugins/feishu-notify.ts`（live，若已部署）
 *   路径：**默认发送路径**（不注入 run，走插件里真实的 NOTIFY_BIN；只有装了全局发送端才能跑）
 *         × 注入 run（argv 交给仓库里那份发送端）—— 这条任何机器都能跑，所以取证不会因为
 *           "本机没装 CLI" 而静默跳过（NOTIFY_BIN 的可移植性是另一个问题，见回报）
 *
 * 于是"部署出去的那份也这么路由"不是推断 —— 前提是 live == 包内，由 live-gate.test.mjs 的哈希闸门钉住。
 * 输出只打印掩码；真实 token 只在本进程内存里比对。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { installStubCurl, maskUrl, readStubCalls, readStubPayload, resetStubLog } from './helpers/stub-curl.mjs';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SENDER = resolve(PACKAGE_ROOT, '..', 'cli', 'bin', 'feishu-notify');
const CLI = resolve(PACKAGE_ROOT, '..', 'cli', 'bin', 'feishu-notify-cli');
const LIVE_PLUGIN = join(homedir(), '.config', 'opencode', 'plugins', 'feishu-notify.ts');
const LIVE_SENDER = join(homedir(), '.local', 'bin', 'feishu-notify'); // 插件里的 NOTIFY_BIN

const HAS_SIBLING = existsSync(SENDER) && existsSync(CLI);
const SIBLING_SKIP = '兄弟包 packages/cli 不在（单拷本包时才会缺）';
const NOT_INSTALLED_SKIP = `本机没装发送端 ${LIVE_SENDER}（插件里的 NOTIFY_BIN 就是它）—— 先 npm i -g feishu-notify-cli`;

const TMP = mkdtempSync(join(tmpdir(), 'feishu-notify-oc-routing-'));
const STUB_DIR = join(TMP, 'stub-bin');
const STUB_LOG = join(TMP, 'stub-log.jsonl');

const DEGRADE_CONFIG = join(TMP, 'degrade', 'config.json'); // 只有 default 的临时配置
const DEGRADE_TOKEN = 'test-degrade-target-0001'; // 样例前缀，密钥闸门认得出不是真地址
const MISSING_CONFIG = join(TMP, 'nowhere', 'config.json');
const MSG_FILE = join(TMP, 'msg.txt');

after(() => rmSync(TMP, { recursive: true, force: true }));

before(() => {
	installStubCurl(STUB_DIR);
	mkdirSync(dirname(DEGRADE_CONFIG), { recursive: true });
	writeFileSync(MSG_FILE, '路由取证：这张卡片**不该真的发出去**（curl 是替身）。\n');
	writeFileSync(
		DEGRADE_CONFIG,
		`${JSON.stringify({ version: 1, activeChannel: 'default', channels: { default: { webhook: `https://open.feishu.cn/open-apis/bot/v2/hook/${DEGRADE_TOKEN}`, label: '默认' } } }, null, 2)}\n`,
	);
});

/**
 * 发送端要的 env。一律前置假 curl，并**摘掉 FEISHU_NOTIFY_WEBHOOK**：
 * 它的优先级高于 activeChannel，留着会让"降级那一态打到哪儿"失去意义。
 * `undefined` 的键直接删掉（spawn 的 env 里留个 undefined 值容易引起误会）。
 */
function senderEnv(patch = {}) {
	const env = { ...process.env, PATH: `${STUB_DIR}:${process.env.PATH}`, FEISHU_NOTIFY_CLI: CLI, FEISHU_STUB_LOG: STUB_LOG };
	delete env.FEISHU_NOTIFY_WEBHOOK;
	for (const [key, value] of Object.entries(patch)) {
		if (value === undefined) delete env[key];
		else env[key] = value;
	}
	return env;
}

/** 注入用的 run：argv 原样交给仓库里那份发送端（真进程、真解析、只有 curl 是替身） */
const runnerWith = (env) => (argv) => {
	const result = spawnSync('bash', [SENDER, ...argv], { encoding: 'utf8', env });
	return {
		ok: result.status === 0,
		status: result.status ?? -1,
		stderr: result.stderr ?? '',
		stdout: result.stdout ?? '',
	};
};

/** 临时改 process.env（只有"默认路径"那一模式需要：runSender 读的是进程 env） */
function withProcessEnv(patch, fn) {
	const saved = new Map();
	for (const [key, value] of Object.entries(patch)) {
		saved.set(key, process.env[key]);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return fn();
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

/** 两种调用模式：注入 run（可移植）/ 默认路径（最接近生产，需要本机装了发送端） */
const MODES = [
	{
		label: '注入 run → 仓库发送端',
		skip: () => (HAS_SIBLING ? false : SIBLING_SKIP),
		invoke: (module, args, { channel, logger, config }) =>
			module.feishuNotify(args, { channel, logger, run: runnerWith(senderEnv({ FEISHU_NOTIFY_CONFIG: config })) }),
	},
	{
		label: '默认路径（插件的 NOTIFY_BIN）',
		skip: () => (HAS_SIBLING ? (existsSync(LIVE_SENDER) ? false : NOT_INSTALLED_SKIP) : SIBLING_SKIP),
		invoke: (module, args, { channel, logger, config }) =>
			withProcessEnv(senderEnv({ FEISHU_NOTIFY_CONFIG: config }), () => module.feishuNotify(args, { channel, logger })),
	},
];

/** 模块清单：包内源文件 + （若已部署）live 文件 */
async function modules(t) {
	const list = [{ label: '包内 src/feishu-notify.ts', module: await import('../src/feishu-notify.ts') }];
	if (existsSync(LIVE_PLUGIN)) {
		list.push({ label: 'live 插件文件', module: await import(pathToFileURL(LIVE_PLUGIN).href) });
	} else {
		t.diagnostic(`live 插件未部署（${LIVE_PLUGIN}）→ 本轮只验包内源文件`);
	}
	for (const entry of list) {
		if (typeof entry.module.feishuNotify !== 'function') {
			assert.fail(
				`${entry.label} 没有导出 feishuNotify —— 它是改造前的旧版（插件里还带着硬编码地址）。先跑：node scripts/deploy.mjs`,
			);
		}
	}
	return list;
}

/** 问真 CLI："这个 channel 的地址 token 是什么"（只留内存，不打印） */
function resolveToken(channel) {
	const result = spawnSync(process.execPath, [CLI, 'resolve', '--channel', channel], { encoding: 'utf8', env: senderEnv() });
	if (result.status !== 0) return null;
	const url = result.stdout.trim();
	return url === '' ? null : url.replace(/.*\//, '');
}

const tokensCalled = () => readStubCalls(STUB_LOG).map((call) => call.token);
const collectLogger = () => {
	const lines = [];
	return { lines, logger: (msg) => lines.push(msg) };
};

// ---------------------------------------------------------------- ① 真实配置

describe('路由 ①：真实配置里有 opencode channel → 打到它', () => {
	it('打到的 token == 配置里 opencode channel 的 token；一次成功，不重试', async (t) => {
		const expected = resolveToken('opencode');
		if (expected === null) return t.skip('本机配置里没有 opencode channel（那正是 ② 的场景）');

		for (const mode of MODES) {
			const skip = mode.skip();
			if (skip) {
				t.diagnostic(`${mode.label}: 跳过（${skip}）`);
				continue;
			}
			for (const { label, module } of await modules(t)) {
				resetStubLog(STUB_LOG);
				const { lines, logger } = collectLogger();

				const outcome = mode.invoke(module, ['--title', '路由取证 ①', '--file', MSG_FILE], {
					channel: 'opencode',
					logger,
					config: undefined, // 不设 FEISHU_NOTIFY_CONFIG = 用本机真实配置
				});

				const calls = readStubCalls(STUB_LOG);
				t.diagnostic(
					`  [${mode.label}] ${label}: reason=${outcome.reason} 打到 ${maskUrl(calls[0]?.url ?? '')}` +
						` | token == 配置里 opencode channel: ${calls[0]?.token === expected}`,
				);

				assert.equal(outcome.reason, 'sent', `${mode.label} / ${label}: ${lines.join('\n')}`);
				assert.equal(outcome.attempts.length, 1, `${mode.label} / ${label}: 有该 channel 时不该重试`);
				assert.equal(calls.length, 1, `${mode.label} / ${label}: 应只发一次`);
				// 一律比**布尔**而不是比 token 本身：断言失败时 node 会打印 actual/expected，
				// 那两个值就是真实地址的 token —— 测试输出里绝不能出现它。
				assert.equal(calls[0].token === expected, true, `${mode.label} / ${label}: 打到的不是配置里 opencode channel 那个机器人`);
				assert.match(readStubPayload(STUB_LOG), /路由取证 ①/, `${mode.label} / ${label}: 卡片正文应来自本次通知`);
				assert.match(readStubPayload(STUB_LOG), /"msg_type":"interactive"/, `${mode.label} / ${label}: 走的是卡片路径`);
				assert.match(lines.join('\n'), /notify ok:/);
			}
		}
	});
});

// ---------------------------------------------------------------- ② 只有 default → 降级

describe('路由 ②：只有 default（单机器人用户）→ 降级到 activeChannel，不是内置地址', () => {
	it('先带 --channel 失败（exit 2）→ 去掉 --channel 重试 → 打到临时配置里的 default', async (t) => {
		const realOpencodeToken = resolveToken('opencode'); // 可能为 null（本机没配 opencode channel）

		for (const mode of MODES) {
			const skip = mode.skip();
			if (skip) {
				t.diagnostic(`${mode.label}: 跳过（${skip}）`);
				continue;
			}
			for (const { label, module } of await modules(t)) {
				resetStubLog(STUB_LOG);
				const { lines, logger } = collectLogger();

				const outcome = mode.invoke(module, ['--title', '路由取证 ②', '--file', MSG_FILE], {
					channel: 'opencode',
					logger,
					config: DEGRADE_CONFIG,
				});

				const calls = readStubCalls(STUB_LOG);
				const log = lines.join('\n');
				t.diagnostic(
					`  [${mode.label}] ${label}: reason=${outcome.reason} 尝试 ${outcome.attempts.length} 次 打到 ${maskUrl(calls[0]?.url ?? '')}` +
						` | token == 临时配置 default: ${calls[0]?.token === DEGRADE_TOKEN}` +
						(realOpencodeToken ? ` | token != 真实 opencode channel: ${calls[0]?.token !== realOpencodeToken}` : ''),
				);

				assert.equal(outcome.reason, 'sent-degraded', `${mode.label} / ${label}: ${log}`);
				assert.equal(outcome.attempts.length, 2, `${mode.label} / ${label}: 应是"失败 → 重试"两次`);
				assert.equal(outcome.attempts[0].withChannel, true, `${mode.label} / ${label}: 第一次应带 --channel`);
				assert.equal(outcome.attempts[1].withChannel, false, `${mode.label} / ${label}: 重试应去掉 --channel`);
				assert.equal(outcome.attempts[0].status, 2, `${mode.label} / ${label}: 第一次应因配置问题 exit 2`);
				assert.equal(calls.length, 1, `${mode.label} / ${label}: 第一次没有可行地址，curl 不该被调用`);
				// 比布尔，不把 token 放进 actual/expected（见 ① 的注释）
				assert.equal(calls[0].token === DEGRADE_TOKEN, true, `${mode.label} / ${label}: 降级后应打到配置的 activeChannel`);
				if (realOpencodeToken) {
					assert.equal(calls[0].token !== realOpencodeToken, true, `${mode.label} / ${label}: 不得改投 opencode 机器人（那是乱投）`);
				}
				assert.match(log, /notify DEGRADED/, `${mode.label} / ${label}: 降级必须是显式日志`);
				assert.match(log, /activeChannel/, `${mode.label} / ${label}: 日志要写明降级去了哪里`);
				assert.match(readStubPayload(STUB_LOG), /路由取证 ②/);
			}
		}
	});
});

// ---------------------------------------------------------------- ③ 什么都没配 → 放弃

describe('路由 ③：配置整个不存在 → 一次都不发（没有内置地址可以回退）', () => {
	it('exit 2 + 引导语 → 不重试、不发卡、记日志', async (t) => {
		for (const mode of MODES) {
			const skip = mode.skip();
			if (skip) {
				t.diagnostic(`${mode.label}: 跳过（${skip}）`);
				continue;
			}
			for (const { label, module } of await modules(t)) {
				resetStubLog(STUB_LOG);
				const { lines, logger } = collectLogger();

				const outcome = mode.invoke(module, ['--title', '路由取证 ③', '--file', MSG_FILE], {
					channel: 'opencode',
					logger,
					config: MISSING_CONFIG,
				});

				const log = lines.join('\n');
				t.diagnostic(
					`  [${mode.label}] ${label}: reason=${outcome.reason} 尝试 ${outcome.attempts.length} 次 curl 调用 ${readStubCalls(STUB_LOG).length} 次`,
				);

				assert.equal(outcome.reason, 'failed', `${mode.label} / ${label}: ${log}`);
				assert.equal(outcome.attempts.length, 1, `${mode.label} / ${label}: 缺配置不该重试`);
				assert.equal(tokensCalled().length, 0, `${mode.label} / ${label}: 没有任何地址可用时不得发出请求`);
				assert.ok(!existsSync(STUB_LOG), `${mode.label} / ${label}: curl 替身一次都不该被调用`);
				assert.match(log, /notify FAILED/);
				assert.match(log, /未配置飞书机器人 webhook|配置文件不存在/, `${mode.label} / ${label}: 日志要带上 CLI 的引导语`);
			}
		}
	});
});

// ---------------------------------------------------------------- 夹带检查

describe('两个"要发出去的东西"里都没有地址可以回退', () => {
	it('包内源文件里没有任何 hook 形状的地址（唯一的地址来源是用户配置）', () => {
		const hits = readFileSync(join(PACKAGE_ROOT, 'src', 'feishu-notify.ts'), 'utf8').match(/open-apis\/bot\/v2\/hook\/[A-Za-z0-9_%.-]{6,}/g) ?? [];
		// 只报数量：把命中内容放进断言消息，等于让"检测到泄漏"这件事自己去打印泄漏物
		assert.equal(hits.length, 0, `包内源文件里仍有 ${hits.length} 处地址`);
	});

	it('live 插件文件同样没有（已部署时才验；未部署由 live-gate 的 exit 2 语义覆盖）', (t) => {
		if (!existsSync(LIVE_PLUGIN)) return t.skip(`live 插件未部署（${LIVE_PLUGIN}）`);
		const hits = readFileSync(LIVE_PLUGIN, 'utf8').match(/open-apis\/bot\/v2\/hook\/[A-Za-z0-9_%.-]{6,}/g) ?? [];
		assert.equal(hits.length, 0, `live 文件里仍有 ${hits.length} 处地址`);
	});
});
