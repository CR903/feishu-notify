/**
 * tests/channel-fallback.test.mjs — 「channel 优先 + 失败降级到 activeChannel」的**决策**
 * （R1/R3，design §2.2；这是本包唯一真正新增的行为，所以测得最细）
 *
 * 三种配置状态（design §2.1 的表）必须分别是：
 *   1. 有该 channel        → 一次成功，argv 带 `--channel <name>`
 *   2. 只有 default        → 先带 `--channel` 失败（退出码 2 + "没有这个 channel"）→ 去掉 `--channel` 重试成功
 *   3. 什么都没配 / 其它失败 → **放弃本次发送**并记日志（绝不回退内置地址、绝不改投别的机器人）
 *
 * 用注入的 `run` 驱动：断言的是"实际传了什么 argv、发了几次"，不是"看起来像"。
 * 真实的发送端 + 假 curl 的联调在 routing.test.mjs（那一份证明打到的是哪个地址）。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';

import {
	DEFAULT_CHANNEL,
	buildNotifyArgs,
	channelFromOptions,
	feishuNotify,
	isChannelNotFoundStderr,
	sendWithChannelFallback,
} from '../src/feishu-notify.ts';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SIBLING_SENDER = resolve(PACKAGE_ROOT, '..', 'cli', 'bin', 'feishu-notify');
const SIBLING_CLI = resolve(PACKAGE_ROOT, '..', 'cli', 'bin', 'feishu-notify-cli');
const SIBLING = existsSync(SIBLING_SENDER) && existsSync(SIBLING_CLI);
const SIBLING_SKIP = '兄弟包 packages/cli 不在（这个仓库里应该总在；单独拷本包时才会缺）';

const TMP = mkdtempSync(join(tmpdir(), 'feishu-notify-oc-channel-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

/** 发送端（bash）在"配置里没有这个 channel"时的真实文案（照抄自 `feishu-notify-cli resolve`） */
const channelNotFoundStderr = (channel, available) =>
	[
		`配置里没有名为 "${channel}" 的 channel（已有：${available}）`,
		'  配置文件：/tmp/x/config.json',
		'  可用 npx feishu-notify-cli channel list 查看。',
		'❌ 未能解析 feishu webhook（见上方提示）。诊断：npx feishu-notify-cli doctor',
	].join('\n');

const missingConfigStderr = [
	'未配置飞书机器人 webhook。请运行：npx feishu-notify-cli init',
	'  配置文件不存在：/tmp/x/config.json',
	'❌ 未能解析 feishu webhook（见上方提示）。诊断：npx feishu-notify-cli doctor',
].join('\n');

const OK = { ok: true, status: 0, stderr: '', stdout: '✅ 飞书消息已发送\n' };
const failure = (status, stderr) => ({ ok: false, status, stderr, stdout: '' });

/** 按脚本返回结果的假 run：第 N 次调用用 steps[N-1]；多调用一次就报错（防"悄悄多试一次"） */
function scripted(steps) {
	const calls = [];
	return {
		calls,
		run(argv) {
			calls.push(argv);
			const step = steps[calls.length - 1];
			if (step === undefined) throw new Error(`出现了第 ${calls.length} 次调用，但脚本只给了 ${steps.length} 次`);
			return step;
		},
	};
}

// ---------------------------------------------------------------- channel 名从哪来

describe('channelFromOptions：只解析"名字"，永远不返回地址', () => {
	const cases = [
		[{ channel: 'opencode' }, 'opencode', '正常配置'],
		[{ channel: '  team-a  ' }, 'team-a', '两侧空白被 trim'],
		[{ channel: 'claude' }, 'claude', '任意名字都接受（校验在配置侧）'],
		[{}, DEFAULT_CHANNEL, 'options 里没有 channel → 默认 opencode'],
		[{ channel: '' }, DEFAULT_CHANNEL, '空串 → 默认'],
		[{ channel: '   ' }, DEFAULT_CHANNEL, '纯空白 → 默认'],
		[{ channel: 42 }, DEFAULT_CHANNEL, '非字符串 → 默认（不抛：插件不该因为配置写错就崩）'],
		[{ channel: null }, DEFAULT_CHANNEL, 'null → 默认'],
		[undefined, DEFAULT_CHANNEL, 'options 整体缺失（裸字符串声明形态）'],
		[null, DEFAULT_CHANNEL, 'options 是 null'],
	];

	for (const [options, expected, why] of cases) {
		it(`${why} → ${JSON.stringify(expected)}`, () => {
			const got = channelFromOptions(options);
			assert.equal(got, expected);
			assert.ok(!/^https?:/.test(got), '返回的必须是名字，不是地址');
		});
	}
});

// ---------------------------------------------------------------- argv 组装

describe('buildNotifyArgs：只传名字 / 什么都不传，永不传地址', () => {
	it('withChannel=true → `--channel <name>`（首次尝试）', () => {
		assert.deepEqual(buildNotifyArgs({ channel: 'opencode', args: ['--title', 'T'] }), [
			'--source',
			'opencode',
			'--channel',
			'opencode',
			'--title',
			'T',
		]);
	});

	it('withChannel=false → 不带 --channel（降级重试，走 activeChannel）', () => {
		assert.deepEqual(buildNotifyArgs({ channel: 'opencode', withChannel: false, args: ['--title', 'T'] }), [
			'--source',
			'opencode',
			'--title',
			'T',
		]);
	});

	it('默认参数：不传 channel 时用 DEFAULT_CHANNEL', () => {
		assert.deepEqual(buildNotifyArgs(), ['--source', 'opencode', '--channel', DEFAULT_CHANNEL]);
	});

	it('任何组合下都不出现 --webhook / URL（安全底线：插件不持有地址）', () => {
		for (const withChannel of [true, false]) {
			const argv = buildNotifyArgs({ channel: 'opencode', withChannel, args: ['--title', 'T', '--file', '/tmp/f'] });
			assert.ok(!argv.includes('--webhook'), '绝不再传 --webhook');
			assert.ok(
				!argv.some((arg) => /^https?:\/\//.test(arg) || arg.includes('open-apis')),
				`argv 里不得出现任何地址：${argv.join(' ')}`,
			);
		}
	});
});

// ---------------------------------------------------------------- 降级判据

describe('isChannelNotFoundStderr：判据刻意很窄', () => {
	it('真实文案（照抄发送端 stderr）→ 命中', () => {
		assert.equal(isChannelNotFoundStderr(channelNotFoundStderr('opencode', 'default'), 'opencode'), true);
	});

	it('名字不匹配 → 不命中（避免"别的 channel 的问题"触发无意义重试）', () => {
		assert.equal(isChannelNotFoundStderr(channelNotFoundStderr('team', 'default'), 'opencode'), false);
	});

	it('缺配置的引导语 → 不命中（降级解决不了，只会多发一次）', () => {
		assert.equal(isChannelNotFoundStderr(missingConfigStderr, 'opencode'), false);
	});

	it('空 / 非字符串 stderr → 不命中', () => {
		assert.equal(isChannelNotFoundStderr('', 'opencode'), false);
		assert.equal(isChannelNotFoundStderr(undefined, 'opencode'), false);
	});

	it('真实链条（兄弟包的发送端 + 真 CLI）产出的 stderr 必须命中 —— 文案改了这里就会红', (t) => {
		if (!SIBLING) return t.skip(SIBLING_SKIP);
		const config = join(TMP, 'one-channel.json');
		writeFileSync(
			config,
			`${JSON.stringify({ version: 1, activeChannel: 'default', channels: { default: { webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/test-only-default' } } })}\n`,
		);
		const msg = join(TMP, 'msg.txt');
		writeFileSync(msg, 'stderr 取证\n');

		const result = spawnSync('bash', [SIBLING_SENDER, '--channel', 'opencode', '--title', 'T', '--file', msg], {
			encoding: 'utf8',
			env: { ...process.env, FEISHU_NOTIFY_CONFIG: config, FEISHU_NOTIFY_CLI: SIBLING_CLI },
		});

		assert.equal(result.status, 2, `缺 channel 必须 exit 2：\n${result.stdout}\n${result.stderr}`);
		assert.equal(isChannelNotFoundStderr(result.stderr, 'opencode'), true, `真实 stderr 未被判据接受：\n${result.stderr}`);
		assert.equal(isChannelNotFoundStderr(result.stderr, 'claude'), false, '换个名字就不该命中');
		assert.match(result.stderr, /没有名为 "opencode" 的 channel/, '真实文案的形状（判据依赖它，变了要一起改）');
	});
});

// ---------------------------------------------------------------- 三态决策表

describe('sendWithChannelFallback：三态（有该 channel / 只有 default / 全无）', () => {
	it('① 有该 channel → 一次成功，argv 带 --channel', () => {
		const runner = scripted([OK]);
		const outcome = sendWithChannelFallback({ channel: 'opencode', args: ['--title', 'T'], run: runner.run });

		assert.equal(outcome.reason, 'sent');
		assert.equal(outcome.ok, true);
		assert.equal(runner.calls.length, 1, '不该有第二次尝试');
		assert.ok(runner.calls[0].includes('--channel'), '第一次必须带 --channel');
	});

	it('② 只有 default → 第一次 exit 2（没有这个 channel）→ 去掉 --channel 重试成功', () => {
		const runner = scripted([failure(2, channelNotFoundStderr('opencode', 'default')), OK]);
		const outcome = sendWithChannelFallback({ channel: 'opencode', args: ['--title', 'T'], run: runner.run });

		assert.equal(outcome.reason, 'sent-degraded');
		assert.equal(outcome.ok, true);
		assert.equal(runner.calls.length, 2);
		assert.ok(runner.calls[0].includes('--channel'), '第一次带 --channel');
		assert.ok(!runner.calls[1].includes('--channel'), '重试必须去掉 --channel（走 activeChannel）');
		assert.equal(outcome.attempts[1].withChannel, false);
	});

	it('③ 降级后仍失败 → 放弃（不再有第三次尝试）', () => {
		const runner = scripted([failure(2, channelNotFoundStderr('opencode', 'default')), failure(1, '❌ 发送失败 (HTTP 500)')]);
		const outcome = sendWithChannelFallback({ channel: 'opencode', args: ['--title', 'T'], run: runner.run });

		assert.equal(outcome.ok, false);
		assert.equal(outcome.reason, 'gave-up-after-degrade');
		assert.equal(runner.calls.length, 2);
	});

	it('③-变体：完全没配（exit 2 + init 引导）→ **不重试**，直接放弃', () => {
		const runner = scripted([failure(2, missingConfigStderr)]);
		const outcome = sendWithChannelFallback({ channel: 'opencode', args: ['--title', 'T'], run: runner.run });

		assert.equal(outcome.reason, 'failed');
		assert.equal(runner.calls.length, 1, '缺配置不是 channel 问题，重试没有意义');
	});

	it('非 2 的退出码（发送失败 / 超时 / 找不到发送端）→ 不重试', () => {
		for (const status of [1, 124, -1]) {
			const runner = scripted([failure(status, '❌ 发送失败')]);
			const outcome = sendWithChannelFallback({ channel: 'opencode', args: ['--title', 'T'], run: runner.run });
			assert.equal(outcome.reason, 'failed', `exit=${status} 不该触发降级`);
			assert.equal(runner.calls.length, 1);
		}
	});

	it('退出码 2 但 stderr 表明的是**别的** channel 名 → 不重试（判据不放过宽）', () => {
		const runner = scripted([failure(2, channelNotFoundStderr('team', 'default'))]);
		const outcome = sendWithChannelFallback({ channel: 'opencode', args: ['--title', 'T'], run: runner.run });
		assert.equal(outcome.reason, 'failed');
		assert.equal(runner.calls.length, 1);
	});
});

// ---------------------------------------------------------------- 降级必须被记录

describe('feishuNotify：降级/放弃都写日志（可观测，不静默）', () => {
	const collect = () => {
		const lines = [];
		return { lines, logger: (msg) => lines.push(msg) };
	};

	it('成功 → 记 ok，且不出现 DEGRADED', () => {
		const { lines, logger } = collect();
		const runner = scripted([OK]);
		const outcome = feishuNotify(['--title', 'T'], { channel: 'opencode', run: runner.run, logger });

		assert.equal(outcome.reason, 'sent');
		assert.equal(lines.length, 1);
		assert.match(lines[0], /notify ok:/);
		assert.ok(!lines[0].includes('DEGRADED'));
	});

	it('降级成功 → 日志里写明"没有 channel X"与"改走 activeChannel"（不是悄悄换机器人）', () => {
		const { lines, logger } = collect();
		const runner = scripted([failure(2, channelNotFoundStderr('opencode', 'default')), OK]);
		const outcome = feishuNotify(['--title', 'T'], { channel: 'opencode', run: runner.run, logger });

		assert.equal(outcome.reason, 'sent-degraded');
		assert.equal(lines.length, 1);
		assert.match(lines[0], /notify DEGRADED/);
		assert.match(lines[0], /opencode/, '要写明是哪个 channel 缺席');
		assert.match(lines[0], /activeChannel/, '要写明降级去了哪里（由配置决定）');
		assert.match(lines[0], /没有任何内置地址/, '要明确否定"回退到内置地址"');
	});

	it('放弃 → 日志里写明尝试次数、退出码与 stderr 摘要', () => {
		const { lines, logger } = collect();
		const runner = scripted([failure(2, channelNotFoundStderr('opencode', 'default')), failure(1, '❌ 发送失败 (HTTP 500): {"code":19002}')]);
		const outcome = feishuNotify(['--title', 'T'], { channel: 'opencode', run: runner.run, logger });

		assert.equal(outcome.ok, false);
		assert.equal(lines.length, 1);
		assert.match(lines[0], /notify FAILED \(gave-up-after-degrade, 尝试 2 次, exit=1\)/);
		assert.match(lines[0], /HTTP 500/);
	});

	it('找不到发送端（ENOENT）→ 放弃并写明"需先安装 feishu-notify-cli"', () => {
		// `NOTIFY_BIN` 在**模块加载时**由 $HOME 算出，所以必须在子进程里换 HOME 才能真正走到这条路径
		// （也顺带证明真实的 execFileSync 分支确实产出自解释的 stderr，而不是一句 ENOENT）。
		const src = pathToFileURL(join(PACKAGE_ROOT, 'src', 'feishu-notify.ts')).href;
		const code = `
			import { feishuNotify } from ${JSON.stringify(src)};
			const outcome = feishuNotify(['--title', 'T'], { channel: 'opencode', logger: (m) => console.log('LOG ' + m) });
			console.log('REASON ' + outcome.reason + ' STATUS ' + outcome.attempts[0].status);
		`;
		const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
			encoding: 'utf8',
			env: { ...process.env, HOME: join(TMP, 'no-such-home') },
		});

		assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
		assert.match(child.stdout, /REASON failed STATUS -1/, '进程起不来时 status=-1，不会触发降级');
		assert.match(child.stdout, /LOG notify FAILED \(failed, 尝试 1 次, exit=-1\)/);
		assert.match(child.stdout, /找不到发送端/);
		assert.match(child.stdout, /feishu-notify-cli/, '要指向"去装 CLI"这个下一步');
	});
});
