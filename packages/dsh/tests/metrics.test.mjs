/**
 * 纯函数：指标排版与用量折叠。
 *
 * 核心断言：**缺哪项就省略哪段，不造数**（research §8.2.3/§3）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { foldUsages, formatCumulativeTotals, formatMetrics, modelLabel } from '../lib/index.js';

// ---------------------------------------------------------------- modelLabel

test('modelLabel：provider/model；缺一个用另一个；都没有 → 空串', () => {
	assert.equal(modelLabel({ provider: 'deepseek', model: 'deepseek-chat' }), 'deepseek/deepseek-chat');
	assert.equal(modelLabel({ model: 'deepseek-chat' }), 'deepseek-chat');
	assert.equal(modelLabel({ provider: 'deepseek' }), 'deepseek');
	assert.equal(modelLabel({}), '');
	assert.equal(modelLabel(undefined), '');
	assert.equal(modelLabel({ provider: '  ', model: '' }), '');
	assert.equal(modelLabel('deepseek-chat'), '', '非对象不当模型名');
});

// ---------------------------------------------------------------- foldUsages

test('foldUsages：各步用量相加；reasoning 不重复计入 output', () => {
	const folded = foldUsages([
		{ inputTokens: 100, outputTokens: 200, cacheReadTokens: 1000, reasoningTokens: 50 },
		{ inputTokens: 10, outputTokens: 20, cacheReadTokens: 5, reasoningTokens: 7 },
	]);
	assert.deepEqual(folded, {
		inputTokens: 110,
		outputTokens: 220,
		cacheReadTokens: 1005,
		reasoningTokens: 57,
	});
});

test('foldUsages：适配器没报过的字段不出现（不补零）', () => {
	const folded = foldUsages([{ inputTokens: 1, outputTokens: 2 }]);
	assert.deepEqual(folded, { inputTokens: 1, outputTokens: 2 });
	assert.equal('cacheReadTokens' in folded, false);
	assert.equal('cacheWriteTokens' in folded, false);
	assert.equal('reasoningTokens' in folded, false);
});

test('foldUsages：一步都没报 → undefined', () => {
	assert.equal(foldUsages([]), undefined);
	assert.equal(foldUsages(undefined), undefined);
	assert.equal(foldUsages([undefined, null, 'x', 7, {}]), undefined);
});

test('foldUsages：非数值字段忽略（NaN / 字符串不算用量）', () => {
	assert.deepEqual(foldUsages([{ outputTokens: 5 }, { outputTokens: NaN }, { outputTokens: '9' }]), { outputTokens: 5 });
});

// ---------------------------------------------------------------- formatMetrics

test('formatMetrics：三项齐全时，模型独占一行、其余在第二行', () => {
	const text = formatMetrics({
		model: 'deepseek/deepseek-chat',
		tokens: { outputTokens: 1270, cacheReadTokens: 2048 },
		durationMs: 42_400,
	});
	assert.equal(text, ['**🤖 deepseek/deepseek-chat**', '输出 1.3k tok · 缓存读 2.0k tok · 耗时 42s'].join('\n'));
});

test('formatMetrics：缺哪项就省略哪段（不造数）', () => {
	assert.equal(formatMetrics({ model: 'm' }), '**🤖 m**');
	assert.equal(formatMetrics({ tokens: { outputTokens: 100 } }), '输出 100 tok');
	assert.equal(formatMetrics({ durationMs: 65_000 }), '耗时 1m5s');
	assert.equal(formatMetrics({ model: 'm', durationMs: 5_000 }), '**🤖 m**\n耗时 5s');
});

test('formatMetrics：全缺 / 畸形 → 空串（调用方整段不拼）', () => {
	assert.equal(formatMetrics(), '');
	assert.equal(formatMetrics({}), '');
	assert.equal(formatMetrics({ model: '', tokens: {}, durationMs: 0 }), '');
	assert.equal(formatMetrics({ model: 7, tokens: 'x', durationMs: NaN }), '');
	assert.equal(formatMetrics({ tokens: { outputTokens: 0 }, durationMs: -1 }), '');
});

test('formatMetrics：**没有 TPS** —— DSH 只有整轮墙钟，除出来没有意义', () => {
	const text = formatMetrics({ model: 'm', tokens: { outputTokens: 1270 }, durationMs: 42_400 });
	assert.equal(/tok\/s|t\/s/.test(text), false, '不该出现 TPS');
});

// ---------------------------------------------------------------- formatCumulativeTotals

test('formatCumulativeTotals：拿得到才写一行', () => {
	assert.equal(formatCumulativeTotals({ outputTokens: 12_345 }), '本会话累计 12.3k tok');
	assert.equal(formatCumulativeTotals({ outputTokens: 999 }), '本会话累计 999 tok');
});

test('formatCumulativeTotals：投影缺失（非 web profile）→ 空串', () => {
	assert.equal(formatCumulativeTotals(undefined), '');
	assert.equal(formatCumulativeTotals(null), '');
	assert.equal(formatCumulativeTotals({}), '');
	assert.equal(formatCumulativeTotals({ outputTokens: 0 }), '');
	assert.equal(formatCumulativeTotals({ outputTokens: 'x' }), '');
});
