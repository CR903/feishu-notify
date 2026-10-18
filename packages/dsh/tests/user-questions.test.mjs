/**
 * `user-questions/request` —— DSH 里唯一真正的「需要你回答 / 计划待批」时机。
 *
 * 它是**阻塞 waterfall**（`$RT/dsh-user-questions/lib/types/types.d.ts:145`：
 * `'user-questions/request'(this: Scoped<Agent>, request, next) => Promise<AskUserQuestionAnswer>`），
 * 于是本档有两条硬约束，都在这份测试里钉住：
 *
 *   1. **fire-and-forget**：handler 绝不 await 发送（挂了外部进程就是给别人的延迟加码）；
 *   2. **必须委派 `next()`**：cordis 的 waterfall 里不调 `next()` = 否决整条链
 *      （`$RT/cordis/lib/index.js:317-331`），真正的答题 UI 会再也拿不到这个问题。
 *
 * `next()` 的 promise 是**必须**返回的（waterfall 协议），所以判「不阻塞」用的是
 * 「挂起的发送 promise」而不是「返回值不是 Promise」——见下面的「不阻塞」两条。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	classifyUserQuestions,
	createUserQuestionHandler,
	NOTIFY_SOURCE,
	PLAN_REVIEW_TITLE,
	QUESTION_MAX_ITEMS,
	QUESTION_TITLE,
} from '../lib/index.js';

// ---------------------------------------------------------------- 桩

function makeCtx({ title = undefined } = {}) {
	const logs = [];
	return {
		logs,
		ctx: {
			logger: { error: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)), info() {}, debug() {} },
			sessionTitle: { get: () => (title === undefined ? undefined : { title }) },
		},
	};
}

const noopNext = () => Promise.resolve({ answers: [] });

// ---------------------------------------------------------------- 纯映射

test('问题列表 → ❓ 需要你回答：header / question / 选项都在正文里', () => {
	const result = classifyUserQuestions({
		questions: [
			{ id: 'q1', header: '部署', question: '要部署到哪个环境？', options: [{ label: 'staging' }, { label: 'prod', description: '危险' }] },
			{ id: 'q2', question: '回滚窗口多长？' },
		],
	});

	assert.equal(result.kind, 'question');
	assert.equal(result.title, QUESTION_TITLE);
	assert.equal(result.questionCount, 2);
	assert.equal(result.planReviewCount, 0);
	assert.match(result.body, /\*\*部署\*\*: 要部署到哪个环境？/);
	assert.match(result.body, /\*\*问题 2\*\*: 回滚窗口多长？/, '没有 header 就用「问题 N」');
	assert.match(result.body, /选项: `staging` \/ `prod`/);
});

test('multiSelect: true 在选项行上标出来', () => {
	const result = classifyUserQuestions({ questions: [{ id: 'q', question: '要开哪几个？', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true }] });
	assert.match(result.body, /选项（可多选）: `A` \/ `B`/);
});

test('plan-review：标题可区分（仍是「需要你回答」），正文点名批准项，detail 被截断', () => {
	const longPlan = 'x'.repeat(500);
	const result = classifyUserQuestions({
		questions: [
			{
				id: 'plan',
				header: '计划',
				question: '批准这个计划吗？',
				detail: longPlan,
				options: [{ label: 'Approve' }, { label: 'Reject' }],
				intent: { kind: 'plan-review', approve: 'Approve' },
			},
		],
	});

	assert.equal(result.kind, 'plan-review');
	assert.equal(result.planReviewCount, 1);
	assert.equal(result.title, PLAN_REVIEW_TITLE);
	assert.ok(result.title.startsWith(QUESTION_TITLE), '计划待批仍然是「需要你回答」的一种');
	assert.match(result.body, /📋 \*\*计划待批\*\*（批准项：`Approve`）/);
	assert.ok(result.body.length < longPlan.length, 'detail 被截断（plan markdown 可能很长）');
	assert.match(result.body, /…/);
});

test('plan-review 缺 approve（畸形 intent）时照样分档，只是不写批准项', () => {
	const result = classifyUserQuestions({ questions: [{ id: 'p', question: '批准？', intent: { kind: 'plan-review' } }] });
	assert.equal(result.kind, 'plan-review');
	assert.match(result.body, /📋 \*\*计划待批\*\*$/m);
});

test('认不出的 intent.kind 当普通问题（上游可继续加 intent，不崩）', () => {
	const result = classifyUserQuestions({ questions: [{ id: 'q', question: 'Q', intent: { kind: 'some-future-intent' } }] });
	assert.equal(result.kind, 'question');
	assert.equal(result.title, QUESTION_TITLE);
});

test(`问题多于 ${QUESTION_MAX_ITEMS} 个：只列前 N 个并报总数（卡片不爆）`, () => {
	const result = classifyUserQuestions({ questions: Array.from({ length: 8 }, (_, index) => ({ id: `q${index}`, question: `Q${index}` })) });
	assert.equal(result.questionCount, 8);
	assert.match(result.body, /Q4/);
	assert.doesNotMatch(result.body, /Q5/);
	assert.match(result.body, /… 另有 3 个问题（共 8 个）/);
});

test('缺字段 / 畸形载荷：不崩，且正文**永不为空**（内核 CLI 对空正文 exit 1）', () => {
	const payloads = [
		undefined,
		null,
		{},
		'not-an-object',
		42,
		{ questions: null },
		{ questions: [] },
		{ questions: 'nope' },
		{ questions: ['nope', 42, null] },
		{ questions: [{}] },
		{ questions: [{ id: 'q', question: 7, options: 'nope', detail: {} }] },
	];
	for (const payload of payloads) {
		const result = classifyUserQuestions(payload);
		assert.equal(result.kind, 'question', JSON.stringify(payload));
		assert.equal(result.title, QUESTION_TITLE, JSON.stringify(payload));
		assert.notEqual(result.body.trim(), '', JSON.stringify(payload));
		assert.equal(typeof result.questionCount, 'number', JSON.stringify(payload));
	}
});

// ---------------------------------------------------------------- handler：argv

test('handler：argv 带 --source dsh / --channel <config.channel>，正文含问题与目录', () => {
	const { ctx } = makeCtx({ title: '部署窗口' });
	const sent = [];
	const handler = createUserQuestionHandler({ ctx, config: { channel: 'dsh' }, send: (argv) => sent.push(argv) });

	handler(
		{
			questions: [{ id: 'q1', question: '选哪个？' }],
			agent: { session: { id: 'ses_1', header: { cwd: '/tmp/proj' } } },
		},
		noopNext,
	);

	assert.equal(sent.length, 1);
	assert.deepEqual(sent[0].slice(0, 6), ['--source', NOTIFY_SOURCE, '--channel', 'dsh', '--title', `❓ 需要你回答 · 部署窗口`]);
	assert.match(sent[0][6], /\*\*问题 1\*\*: 选哪个？/);
	assert.match(sent[0][6], /\*\*目录\*\*: `\/tmp\/proj`/);
});

test('--channel 取 config.channel（自定义名字，不写死 dsh）', () => {
	const { ctx } = makeCtx();
	const sent = [];
	const handler = createUserQuestionHandler({ ctx, config: { channel: 'dsh-plan' }, send: (argv) => sent.push(argv) });

	handler({ questions: [{ id: 'q', question: 'Q' }] }, noopNext);

	assert.equal(sent[0][3], 'dsh-plan');
	assert.equal(sent[0][5], QUESTION_TITLE, '没有会话名时不加后缀');
});

test('没有 agent / session 时也照发，只是没有目录行（不造数）', () => {
	const { ctx } = makeCtx();
	const sent = [];
	const handler = createUserQuestionHandler({ ctx, config: {}, send: (argv) => sent.push(argv) });

	assert.doesNotThrow(() => handler({ questions: [{ id: 'q', question: 'Q' }] }, noopNext));
	assert.equal(sent.length, 1);
	assert.doesNotMatch(sent[0][6], /目录/);
});

// ---------------------------------------------------------------- handler：不阻塞

test('不阻塞 ①：发送端返回**挂起的 promise**也不阻塞 —— 同步返回、next() 已同步调用、返回值不是发送端的 promise', () => {
	const { ctx, logs } = makeCtx();
	const hang = new Promise(() => {}); // 永不 settle：模拟「外部进程一直没回来」
	const sent = [];
	const handler = createUserQuestionHandler({
		ctx,
		config: {},
		send: (argv) => {
			sent.push(argv);
			return hang;
		},
	});

	let nextCalls = 0;
	const delegated = Promise.resolve({ answers: [{ id: 'q1', selected: ['A'] }] });
	const returned = handler({ questions: [{ id: 'q1', question: 'Q' }] }, () => {
		nextCalls += 1;
		return delegated;
	});

	assert.equal(sent.length, 1, '发送已在**同步段**发起（fire-and-forget）');
	assert.equal(nextCalls, 1, 'next() 必须同步委派 —— waterfall 里不调 next() = 否决整条链');
	assert.equal(returned, delegated, '返回值必须是 next() 的 promise 本身；若接上发送端的挂起 promise，await 它就会阻塞这一轮');
	assert.equal(logs.length, 0, '不该有 ERROR 日志');
});

test('不阻塞 ②：挂起的发送不影响委派结果 —— 能立刻拿到答案', async () => {
	const { ctx } = makeCtx();
	const handler = createUserQuestionHandler({ ctx, config: {}, send: () => new Promise(() => {}) });
	const answer = { answers: [{ id: 'q1', selected: ['A'] }] };
	const returned = handler({ questions: [{ id: 'q1', question: 'Q' }] }, () => Promise.resolve(answer));

	assert.equal(await returned, answer, '答案与发送端无关，立即 settle');
});

test('阻塞对照：把发送 await 进链里就会先卡在发送上（证明上面两条断言真的能抓到回归）', async () => {
	// 这不是被测代码，是「反向对照」：说明 nextCalls===0 / returned!==delegated 确实会在
	// 一个 await 版实现上失败，而不是恒真断言。
	const hang = new Promise(() => {});
	let nextCalls = 0;
	const delegated = Promise.resolve({ answers: [] });
	const blocking = (request, next) => hang.then(() => {
		nextCalls += 1;
		return next();
	});

	const returned = blocking({}, () => delegated);
	assert.equal(nextCalls, 0, 'await 版：同步段结束时 next() 还没被调用');
	assert.notEqual(returned, delegated, 'await 版：返回值是发送链的 promise，不是 next() 的');
});

// ---------------------------------------------------------------- handler：失败不影响流程

test('发送端炸了：不抛、记 ERROR，且**照样**委派 next()（通知失败不能吃掉答题流程）', () => {
	const { ctx, logs } = makeCtx();
	const handler = createUserQuestionHandler({
		ctx,
		config: {},
		send: () => {
			throw new Error('boom');
		},
	});

	let nextCalls = 0;
	assert.doesNotThrow(() =>
		handler({ questions: [{ id: 'q', question: 'Q' }] }, () => {
			nextCalls += 1;
			return Promise.resolve({ answers: [] });
		}),
	);
	assert.equal(nextCalls, 1);
	assert.equal(logs.length, 1);
	assert.match(logs[0], /dsh-feishu-notify: 发送端抛异常/);
});

test('发送端 promise 被拒：记 ERROR，不影响委派', async () => {
	const { ctx, logs } = makeCtx();
	const handler = createUserQuestionHandler({ ctx, config: {}, send: () => Promise.reject(new Error('rejected')) });

	const returned = handler({ questions: [{ id: 'q', question: 'Q' }] }, noopNext);
	assert.deepEqual(await returned, { answers: [] });
	// 拒绝是在 microtask 里被收掉的
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(logs.length, 1);
	assert.match(logs[0], /发送端 promise 被拒/);
});

test('找不到发送端 → **不 spawn** + 无条件 ERROR（与 approval/asked 走同一条路）', () => {
	const logs = [];
	const spawnCalls = [];
	const ctx = { logger: { error: (m) => logs.push(String(m)), warn() {}, info() {}, debug() {} } };
	const handler = createUserQuestionHandler({
		ctx,
		config: {},
		senderOptions: {
			spawn: (...args) => {
				spawnCalls.push(args);
				return { pid: 1, stderr: { on() {} }, on() {}, kill() {} };
			},
			env: { HOME: '/tmp/definitely-not-here', PATH: '' },
		},
	});

	handler({ questions: [{ id: 'q', question: 'Q' }] }, noopNext);

	assert.equal(spawnCalls.length, 0, '解析不到发送端就绝不 spawn');
	assert.equal(logs.length, 1);
	assert.match(logs[0], /找不到发送端 feishu-notify/);
	assert.match(logs[0], /本次通知未发送/);
});

test('畸形 request：handler 不抛，next 照样被调用', () => {
	const { ctx } = makeCtx();
	const handler = createUserQuestionHandler({ ctx, config: {}, send: () => {} });

	for (const request of [undefined, null, {}, { questions: 'nope' }, { questions: [null] }, 42, 'nope']) {
		let nextCalls = 0;
		assert.doesNotThrow(
			() =>
				handler(request, () => {
					nextCalls += 1;
					return Promise.resolve({ answers: [] });
				}),
			JSON.stringify(request),
		);
		assert.equal(nextCalls, 1, JSON.stringify(request));
	}
});

test('next 缺失 / 不是函数：返回 undefined，不抛（防御性，不该发生）', () => {
	const { ctx } = makeCtx();
	const handler = createUserQuestionHandler({ ctx, config: {}, send: () => {} });
	assert.equal(handler({ questions: [] }, undefined), undefined);
	assert.equal(handler({ questions: [] }, 42), undefined);
});

test('next() 自己抛异常：**不吞**（那是真实答题链的错，不是我们的通知错）', () => {
	const { ctx, logs } = makeCtx();
	const handler = createUserQuestionHandler({ ctx, config: {}, send: () => {} });
	assert.throws(
		() =>
			handler({ questions: [{ id: 'q', question: 'Q' }] }, () => {
				throw new Error('answerer exploded');
			}),
		/answerer exploded/,
	);
	assert.equal(logs.length, 0, '不是我们的失败，不该记 ERROR 日志');
});
