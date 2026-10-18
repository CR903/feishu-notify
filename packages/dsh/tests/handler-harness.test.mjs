/**
 * fake ctx harness：不启 DSH，只给最小桩，验证
 *   1. 到底注册了哪些事件名（**只允许 research 里列出过的**）
 *   2. 收到事件后调用的 argv（必须含 `--channel dsh`）
 *   3. 通知失败绝不影响这一轮对话（处理器不抛）
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { apply, createSessionHandler, DEFAULT_CHANNEL, NOTIFY_SOURCE } from '../lib/index.js';

/**
 * research 实测存在的事件名（`$RT` 各包的 lib/types），带出处。
 * 注册到别处 = 自创事件名（永远收不到），本测试专门拦住这种事。
 */
const RESEARCH_EVENT_NAMES = new Set([
	// $RT/dsh-session/lib/types/index.d.ts:64 —— 一轮结束/审批/工具失败都从它来
	'session/event',
	// $RT/dsh-user-questions/lib/types/types.d.ts:145 —— 「需要你回答 / 计划待批」的**阻塞 waterfall**
	// （不是 SessionEventMap 成员；设计稿里写的 `user-question-reply` 属于 MessageSourceMap，收不到）
	'user-questions/request',
	// 明确**不注册**但确实存在的候选（留着是为了让"允许集合"如实反映 research）
	'agent/turn-stopping', // $RT/dsh-agent/lib/types/runtime-types.d.ts:387（乐观结束：别的 listener 可 steer 续命）
	'agent/created', // $RT/dsh-agent/lib/types/runtime-types.d.ts:227
	'session/created', // $RT/dsh-session/lib/types/index.d.ts:42
	'approval/request', // $RT/dsh-user-approval/lib/types/types.d.ts:81（阻塞 waterfall；我们走非阻塞的 approval/asked）
	'tools/result', // $RT/dsh-tools/lib/types/index.d.ts:92
	'session-telemetry/record', // $RT/dsh-session-telemetry/lib/types/index.d.ts:41
]);

function makeCtx({ title = undefined, totals = undefined, loggerBroken = false } = {}) {
	const registered = [];
	const handlers = new Map();
	const logs = [];
	const ctx = {
		on(event, listener) {
			registered.push(event);
			handlers.set(event, listener);
			return () => handlers.delete(event);
		},
		logger: loggerBroken
			? null
			: {
					error: (message) => logs.push(String(message)),
					warn: (message) => logs.push(String(message)),
					info() {},
					debug() {},
				},
		sessionTitle: { get: () => (title === undefined ? undefined : { title }) },
		sessionProjections: { stateOf: () => (totals === undefined ? undefined : { totals }) },
	};
	return { ctx, registered, handlers, logs };
}

function makeSession({ id = 'ses_abc', cwd = '/Users/x/project', model = { provider: 'deepseek', model: 'deepseek-chat' } } = {}) {
	return {
		id,
		header: { cwd },
		requestContext: () => model,
	};
}

// ---------------------------------------------------------------- 注册了哪些事件

test('注册的事件名只有这两个，且都在 research 的允许集合里', () => {
	const { ctx, registered } = makeCtx();
	apply(ctx, { channel: 'dsh' });

	// 每个时机一个钩子：session/event（非阻塞 emit）+ user-questions/request（阻塞 waterfall）
	assert.deepEqual(registered, ['session/event', 'user-questions/request']);
	for (const event of registered) {
		assert.ok(RESEARCH_EVENT_NAMES.has(event), `自创事件名（research 里没有）：${event}`);
	}
});

test('apply 永不抛：ctx.on 炸了也只记日志（否则 fiber 变 FAILED）', () => {
	const logs = [];
	assert.doesNotThrow(() => {
		apply(
			{
				on() {
					throw new Error('boom');
				},
				logger: { error: (m) => logs.push(String(m)), warn() {}, info() {}, debug() {} },
			},
			{ channel: 'dsh' },
		);
	});
	// 两个时机各自一层 try/catch：一个注册失败不连累另一个，日志按事件名分得清
	assert.equal(logs.length, 2);
	assert.match(logs[0], /插件加载失败（session\/event）/);
	assert.match(logs[1], /插件加载失败（user-questions\/request）/);
});

test('apply 在 ctx 没有 logger 时退到 stderr，仍然不抛', () => {
	const original = console.error;
	const lines = [];
	console.error = (line) => lines.push(String(line));
	try {
		assert.doesNotThrow(() => {
			apply(
				{
					on() {
						throw new Error('boom');
					},
				},
				{ channel: 'dsh' },
			);
		});
	} finally {
		console.error = original;
	}
	assert.equal(lines.length, 2, '没有 ctx.logger 时也必须留下证据（不是静默）');
	assert.match(lines[0], /插件加载失败/);
});

// ---------------------------------------------------------------- 收到事件后的 argv

test('turn/end → argv 含 --channel dsh 与 --source dsh，标题与正文按分档', () => {
	const { ctx } = makeCtx({ title: '修一下登录超时', totals: { outputTokens: 12_345 } });
	const sent = [];
	const handler = createSessionHandler({ ctx, config: { channel: 'dsh' }, send: (argv) => sent.push(argv) });

	handler(makeSession(), { type: 'turn/start', seq: 1, time: 1_000, data: { turn: 1 } });
	handler(makeSession(), {
		type: 'assistant/message',
		seq: 2,
		time: 1_500,
		data: { turn: 1, step: 1, message: {}, stream: [], usage: { inputTokens: 10, outputTokens: 1_270, cacheReadTokens: 2_048 } },
	});
	handler(makeSession(), { type: 'turn/end', seq: 3, time: 42_400, data: { turn: 1, reason: { kind: 'completed' } } });

	assert.equal(sent.length, 1);
	const argv = sent[0];
	assert.deepEqual(argv.slice(0, 6), ['--source', NOTIFY_SOURCE, '--channel', DEFAULT_CHANNEL, '--title', '✅ 任务完成 · 修一下登录超时']);
	const body = argv[6];
	assert.match(body, /\*\*目录\*\*: `\/Users\/x\/project`/);
	assert.match(body, /\*\*🤖 deepseek\/deepseek-chat\*\*/);
	assert.match(body, /输出 1\.3k tok · 缓存读 2\.0k tok · 耗时 41s/);
	assert.match(body, /本会话累计 12\.3k tok/);
});

test('turn/end（失败档）带错误详情；正文永不为空（内核 CLI 对空正文 exit 1）', () => {
	const { ctx } = makeCtx(); // 没有标题、没有投影、没有 requestContext.model
	const sent = [];
	const handler = createSessionHandler({
		ctx,
		config: {},
		send: (argv) => sent.push(argv),
	});
	const session = { id: 'ses_x', header: {}, requestContext: () => undefined };

	handler(session, {
		type: 'turn/end',
		seq: 1,
		time: 10,
		data: { turn: 1, reason: { kind: 'error', error: { message: 'upstream 503', code: 'PROVIDER_ERROR' } } },
	});

	assert.equal(sent.length, 1);
	const [, , , channel, , title, body] = sent[0];
	assert.equal(channel, 'dsh', '未配置 channel 时用默认 dsh');
	assert.equal(title, '❌ 任务失败', '没有会话标题时不加后缀');
	assert.equal(typeof body, 'string');
	assert.match(body, /upstream 503/);
	assert.notEqual(body.trim(), '', '正文非空');
});

test('approval/asked → 🔔 需要你决定（工具名 / 说明 / 目录）', () => {
	const { ctx } = makeCtx({ title: 'T' });
	const sent = [];
	const handler = createSessionHandler({ ctx, config: { channel: 'dsh' }, send: (argv) => sent.push(argv) });

	handler(makeSession(), {
		type: 'approval/asked',
		seq: 9,
		time: 5,
		data: { id: 'ap_1', toolName: 'bash', callId: 'c1', reason: 'rm -rf build' },
	});

	assert.equal(sent.length, 1);
	assert.equal(sent[0][5], '🔔 需要你决定 · T');
	assert.match(sent[0][6], /\*\*工具\*\*: `bash`/);
	assert.match(sent[0][6], /\*\*说明\*\*: rm -rf build/);
});

test('一次 turn 只发一条；turn 结束后基线清掉（第二轮重新计时）', () => {
	const { ctx } = makeCtx();
	const sent = [];
	const handler = createSessionHandler({ ctx, config: { channel: 'dsh' }, send: (argv) => sent.push(argv) });
	// 没有 cwd / 没有模型 / 没有标题 → 第二轮的正文里什么都不剩（正好用来证明基线已清）
	const session = { id: 'ses_abc', header: {}, requestContext: () => undefined };

	handler(session, { type: 'turn/start', seq: 1, time: 1_000, data: { turn: 1 } });
	handler(session, { type: 'turn/end', seq: 2, time: 2_000, data: { turn: 1, reason: { kind: 'completed' } } });
	assert.match(sent[0][6], /耗时 1s/, '第一轮有耗时基线');

	// 重复投递同一个 turn/end（实测存在同一事件被投多次的情况）→ 仍各发一条，但基线已经清掉
	handler(session, { type: 'turn/end', seq: 2, time: 2_000, data: { turn: 1, reason: { kind: 'completed' } } });
	assert.equal(sent.length, 2, '每个 turn/end 事件各一条（去重不在本层）');
	assert.equal(sent[1][6], '（没有更多细节）', '基线已清 → 无耗时可写');
});

// ---------------------------------------------------------------- 工具失败开关

test('工具失败默认**不推**', () => {
	const { ctx } = makeCtx();
	const sent = [];
	const handler = createSessionHandler({ ctx, config: {}, send: (argv) => sent.push(argv) });

	handler(makeSession(), { type: 'tool/call', seq: 1, time: 1, data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' } });
	handler(makeSession(), { type: 'tool/result', seq: 2, time: 2, data: { turn: 1, step: 1, message: { toolCallId: 'c1', isError: true }, error: { name: 'ToolError', code: 'E_BASH' } } });

	assert.equal(sent.length, 0);
});

test('toolFailures: true → 只推失败的，且带上工具名（从 tool/call 配对）', () => {
	const { ctx } = makeCtx();
	const sent = [];
	const handler = createSessionHandler({ ctx, config: { channel: 'dsh', toolFailures: true }, send: (argv) => sent.push(argv) });

	handler(makeSession(), { type: 'tool/call', seq: 1, time: 1, data: { turn: 1, step: 1, callId: 'ok1', name: 'read', arguments: '{}' } });
	handler(makeSession(), { type: 'tool/result', seq: 2, time: 2, data: { turn: 1, step: 1, message: { toolCallId: 'ok1', isError: false } } });
	handler(makeSession(), { type: 'tool/call', seq: 3, time: 3, data: { turn: 1, step: 2, callId: 'bad1', name: 'bash', arguments: '{}' } });
	handler(makeSession(), { type: 'tool/result', seq: 4, time: 4, data: { turn: 1, step: 2, message: { toolCallId: 'bad1', isError: true }, error: { name: 'ToolError', code: 'E_BASH', reason: 'exit 1' } } });

	assert.equal(sent.length, 1, '成功的不推');
	assert.equal(sent[0][5], '❌ 工具失败');
	assert.match(sent[0][6], /\*\*工具\*\*: `bash`/);
	assert.match(sent[0][6], /\*\*错误\*\*: `ToolError`（E_BASH）/);
	assert.match(sent[0][6], /\*\*说明\*\*: exit 1/);
});

// ---------------------------------------------------------------- 不崩

test('畸形事件一律不抛（通知失败绝不能影响这一轮对话）', () => {
	const { ctx, logs } = makeCtx();
	const handler = createSessionHandler({ ctx, config: { channel: 'dsh' }, send: () => {} });

	const payloads = [
		[undefined, undefined],
		[{}, {}],
		[null, null],
		[{ id: 's' }, { type: 'turn/end' }],
		[{ id: 's' }, { type: 'turn/end', data: null }],
		[{ id: 's' }, { type: 'approval/asked', data: 'nope' }],
		[{ id: 's' }, { type: 'tool/result', data: { message: null } }],
		[{ id: 's' }, { type: 'assistant/message', data: { usage: 'not-an-object' } }],
		[{ id: 's' }, { type: '未知/事件', data: {} }],
	];
	for (const [session, event] of payloads) {
		assert.doesNotThrow(() => handler(session, event), JSON.stringify(event));
	}
	assert.ok(logs.length === 0, `不该有 ERROR 日志（收到：${logs.join(' | ')}）`);
});

test('标题与投影取不到时：省略那一段，而不是抛', () => {
	const { ctx } = makeCtx();
	const broken = {
		on() {},
		logger: null,
		sessionTitle: {
			get() {
				throw new Error('title service exploded');
			},
		},
		sessionProjections: {
			stateOf() {
				throw new Error('projection exploded');
			},
		},
	};
	const sent = [];
	const handler = createSessionHandler({ ctx: broken, config: { channel: 'dsh' }, send: (argv) => sent.push(argv) });

	assert.doesNotThrow(() =>
		handler(
			{
				id: 's',
				header: {},
				requestContext() {
					throw new Error('requestContext exploded');
				},
			},
			{ type: 'turn/end', seq: 1, time: 5, data: { turn: 1, reason: { kind: 'completed' } } },
		),
	);
	assert.equal(sent.length, 1, '拿不到细节也照发');
	assert.equal(sent[0][5], '✅ 任务完成');
	assert.equal(sent[0][6], '（没有更多细节）');
});
