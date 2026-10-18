/**
 * 纯映射：`turn/end` 的载荷 → `{ kind, title, body }`。
 *
 * 覆盖 `reason.kind` 五档 + 未知档 + research §8.2.4 的坑（**reason 是对象而非字符串**）
 * + 缺字段 / 形状畸形。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifyTurnEnd, UNKNOWN_TURN_END_TITLE } from '../lib/index.js';

const CASES = [
	{ kind: 'completed', title: '✅ 任务完成' },
	{ kind: 'error', title: '❌ 任务失败' },
	{ kind: 'aborted', title: '⏸ 任务已中断' },
	{ kind: 'blocked', title: '🚫 任务被拦下' },
	{ kind: 'max-tokens', title: '⚠️ 已达 token 上限' },
];

test('五档 reason.kind 各自映射到对应标题', () => {
	for (const { kind, title } of CASES) {
		const result = classifyTurnEnd({ turn: 3, reason: { kind } });
		assert.equal(result.kind, kind, `${kind}: kind 归一`);
		assert.equal(result.title, title, `${kind}: 标题`);
		assert.equal(typeof result.body, 'string', `${kind}: body 是字符串`);
	}
});

test('completed / blocked / max-tokens 不硬凑正文', () => {
	for (const kind of ['completed', 'blocked', 'max-tokens']) {
		assert.equal(classifyTurnEnd({ turn: 1, reason: { kind } }).body, '', kind);
	}
});

test('error 档带上 LlmFailure 的 message / code / status', () => {
	const result = classifyTurnEnd({
		turn: 1,
		reason: { kind: 'error', error: { message: 'upstream 503', code: 'PROVIDER_ERROR', status: 503 } },
	});
	assert.equal(result.kind, 'error');
	assert.match(result.body, /\*\*错误\*\*: upstream 503/);
	assert.match(result.body, /\*\*类型\*\*: `PROVIDER_ERROR`（HTTP 503）/);
});

test('error 档缺 LlmFailure 细节时也不空手（不崩、有占位）', () => {
	const result = classifyTurnEnd({ turn: 1, reason: { kind: 'error' } });
	assert.equal(result.kind, 'error');
	assert.match(result.body, /未提供错误详情/);
});

test('aborted 档取 TurnEndCancelCause 的 kind（对象），hook 档再带 reason', () => {
	const byUser = classifyTurnEnd({ turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } });
	assert.match(byUser.body, /\*\*原因\*\*: user/);

	const byHook = classifyTurnEnd({
		turn: 1,
		reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'permission denied' } },
	});
	assert.match(byHook.body, /\*\*原因\*\*: hook/);
	assert.match(byHook.body, /\*\*说明\*\*: permission denied/);

	// 形状畸形的 cause（不是对象也不是字符串）→ 不崩，正文写「未提供」
	const malformed = classifyTurnEnd({ turn: 1, reason: { kind: 'aborted', reason: 7 } });
	assert.equal(malformed.kind, 'aborted');
	assert.match(malformed.body, /\*\*原因\*\*: （未提供）/);
});

test('未知 reason.kind 落未知档，并把原始 kind 写进正文（不吞信息、不崩）', () => {
	// TurnEndReasonMap 实际有 7 档：interrupted / forked 也在这里（实测 types.d.ts:165）
	for (const raw of ['interrupted', 'forked', 'some-plugin-merged-kind']) {
		const result = classifyTurnEnd({ turn: 1, reason: { kind: raw } });
		assert.equal(result.kind, 'unknown', raw);
		assert.equal(result.title, UNKNOWN_TURN_END_TITLE);
		assert.match(result.body, new RegExp(`\`${raw}\``), `${raw}: 原文保留`);
	}
});

// research §8.2.4：`data.reason` 是判别联合**对象**，不是字符串。
test('坑：reason 是对象而非字符串 —— 字符串 reason 不当成 kind', () => {
	const asObject = classifyTurnEnd({ turn: 2, reason: { kind: 'completed' } });
	assert.equal(asObject.kind, 'completed', '对象形状：读 .kind');

	const asString = classifyTurnEnd({ turn: 2, reason: 'completed' });
	assert.equal(asString.kind, 'unknown', '字符串 reason 不认（文档形状是对象）');
	assert.equal(asString.title, UNKNOWN_TURN_END_TITLE);
	assert.match(asString.body, /没给 reason\.kind/);
});

test('缺字段 / 畸形载荷：全部落未知档且不抛', () => {
	const payloads = [
		undefined,
		null,
		{},
		{ turn: 1 },
		{ turn: 1, reason: null },
		{ turn: 1, reason: [] },
		{ turn: 1, reason: { kind: '' } },
		{ turn: 1, reason: { kind: 42 } },
		'not-an-object',
	];
	for (const payload of payloads) {
		const result = classifyTurnEnd(payload);
		assert.equal(result.kind, 'unknown', JSON.stringify(payload));
		assert.equal(result.title, UNKNOWN_TURN_END_TITLE, JSON.stringify(payload));
		assert.equal(typeof result.body, 'string', JSON.stringify(payload));
	}
});

test('LlmFailure 形状畸形时：kind 照样分档，正文不崩', () => {
	const result = classifyTurnEnd({ turn: 1, reason: { kind: 'error', error: 'not-an-object' } });
	assert.equal(result.kind, 'error');
	assert.match(result.body, /未提供错误详情/);
});

test('分档不看 turn 号（turn 缺失也照常分档）', () => {
	assert.equal(classifyTurnEnd({ reason: { kind: 'completed' } }).kind, 'completed');
});
