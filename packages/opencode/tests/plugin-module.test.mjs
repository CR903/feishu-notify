/**
 * tests/plugin-module.test.mjs — 插件模块级冒烟 + `looksLikeQuestion` 用例表 + `bun build`
 *
 * 这个包此前**没有任何测试**（插件只在本机 live 目录里跑过）。本轮补的债里，
 * 这里放的是"不需要注入任何东西就能真证"的三件：
 *   1. 模块能 import，默认导出就是那个插件（`id` 正确）
 *   2. `looksLikeQuestion` 的启发式：11 条模式逐条命中 + 反例（宁漏不误）
 *   3. `bun build` 能解析（语法/依赖解析；opencode 用 bun 加载 TS 插件，这条最接近真实加载路径）
 *
 * **不做**：mock 整个 opencode 事件流（收益低、易假通过，见 design §5）。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import plugin from '../src/feishu-notify.ts';
import { looksLikeQuestion } from '../src/feishu-notify.ts';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = mkdtempSync(join(tmpdir(), 'feishu-notify-oc-build-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

describe("模块冒烟：默认导出就是插件", () => {
	it("default.id === 'feishu.notify'，且 setup 是可调用的", () => {
		assert.equal(plugin.id, 'feishu.notify');
		assert.equal(typeof plugin.setup, 'function');
	});

	it('导出面包含本轮抽出的纯函数（测试接缝就是"给个变量就能验"）', async () => {
		const module = await import('../src/feishu-notify.ts');
		for (const name of [
			'channelFromOptions',
			'buildNotifyArgs',
			'isChannelNotFoundStderr',
			'sendWithChannelFallback',
			'feishuNotify',
			'looksLikeQuestion',
			'isExecutableFile',
			'resolveNotifyBin',
			'describeBinFailure',
			'runSender',
		]) {
			assert.equal(typeof module[name], 'function', `${name} 应为导出函数`);
		}
	});
});

/**
 * 用例表：正例逐条覆盖 `QUESTION_PATTERNS` 的 11 条模式，
 * 反例覆盖"中文陈述句结尾"（呢/吧/了/。这些不该被判成提问）与边界（空串、纯空白、240 字符窗口）。
 *
 * 原插件注释提到过一份"13 项断言"的临时脚本，但它不在仓库里（一次性脚本，已丢）。
 * 所以这张表是按模式清单重新推导的，覆盖不少于那 13 项。
 */
const CASES = [
	// ---- 正例：末尾问号（允许尾部引号/括号）
	['这个目录要删除吗？', true, '末尾?（中文问号）'],
	['Ready to proceed?', true, '末尾?（半角）'],
	['要覆盖这个文件吗？"', true, '末尾问号 + 尾部半角引号'],
	['（需要我继续吗？）', true, '尾部括号内的问号'],
	// ---- 正例：全角右引号收尾（G4 修复：AI 常写「……吗”」）
	['这是你要的最终版本吗”', true, '句末「吗」+ 全角右双引号'],
	['要覆盖这个文件吗？”', true, '末尾问号 + 全角右双引号'],
	['要先跑测试吗？』', true, '末尾问号 + CJK 右双书名号'],
	['要发版吗’', true, '句末「吗」+ 全角右单引号'],
	// ---- 正例：是否 / 要不要
	['是否允许执行 npm install？', true, '是否'],
	['要不要我把这个分支合进 main', true, '要不要'],
	// ---- 正例：需要你 / 请你X
	['这一步需要你确认后才能继续。', true, '需要你'],
	['请你确认一下部署窗口。', true, '请你确认'],
	['请你决定用哪个方案。', true, '请你决定'],
	['请你选择要保留的字段。', true, '请你选择'],
	['请你授权访问该目录。', true, '请你授权'],
	['请你批准这次发布。', true, '请你批准'],
	// ---- 正例：请确认
	['请确认是否删除这三个文件。', true, '请确认'],
	// ---- 正例：你来确认 / 你决定 / 你选择
	['剩下的你来确认。', true, '你来确认'],
	['后续步骤由你决定。', true, '你决定'],
	['哪个可用由你选择。', true, '你选择'],
	// ---- 正例：可以吗 / 好吗 / 行吗 / 对吗
	['我改成这样，可以吗', true, '可以吗'],
	['改成两列，好吗', true, '好吗'],
	['先跑测试，行吗', true, '行吗'],
	['这个理解，对吗', true, '对吗'],
	// ---- 正例：句末「吗」
	['这是你要的最终版本吗', true, '句末吗'],
	// ---- 正例：有没有问题吗 / 有问题吗 / 有异议吗 / 有意见吗
	['上面的取舍有没有问题吗', true, '有没有…吗'],
	['这样安排有问题吗', true, '有问题吗'],
	['对方案有异议吗', true, '有异议吗'],
	['对命名有意见吗', true, '有意见吗'],
	// ---- 正例：要我做 / 要我继续做 …
	['要我继续做下去', true, '要我继续做'],
	['要我执行发布', true, '要我执行'],
	['要我做这个改动', true, '要我做'],
	['要我接着改配置', true, '要我接着改'],
	['要我创建这个文件', true, '要我创建'],
	['要我删除旧分支', true, '要我删除'],
	// ---- 反例：陈述性收尾（这就是"宁可漏判也不要误判"的那一侧）
	['任务已完成。', false, '句末句号'],
	['已经改好了呢', false, '句末「呢」能收陈述句'],
	['就先这样吧', false, '句末「吧」能收陈述句'],
	['改动已经提交了。', false, '完成陈述'],
	['我把三个文件都更新了', false, '完成陈述（无问号）'],
	['这个方案看起来更稳妥。', false, '陈述'],
	['测试全绿：129 pass / 0 fail。', false, '陈述（含斜杠与数字）'],
	// ---- 反例：边界
	['', false, '空串'],
	['   ', false, '纯空白'],
	['？', true, '只有一个问号（末尾问号规则）'],
];

describe('looksLikeQuestion：11 条模式逐条 + 反例（宁可漏判也不要误判）', () => {
	for (const [text, expected, why] of CASES) {
		it(`${expected ? '命中' : '不命中'} · ${why} · ${JSON.stringify(text.slice(0, 30))}`, () => {
			assert.equal(looksLikeQuestion(text), expected);
		});
	}

	it('只看结尾 240 字符窗口：更早的"是否"不算数（这是有意的近似）', () => {
		const far = `是否${'铺'.repeat(300)}`;
		assert.ok(far.length > 240);
		assert.equal(looksLikeQuestion(far), false, '窗口外的疑问信号不该触发 —— 只看收尾');
	});

	it('窗口内的"是否"仍然命中（上一条的对照）', () => {
		const near = `${'铺'.repeat(300)}是否要现在发版？`;
		assert.equal(looksLikeQuestion(near), true);
	});
});

/**
 * G4（本轮修复）：`QUESTION_PATTERNS` 的句末规则原先只认半角 `"` / `'` 与 CJK 括号
 * （`）)」』`），不认全角右引号 `”`。于是 `…吗”`（AI 用引号收尾的常见写法）会被判成
 * "任务完成" —— 与用户抱怨的标题错位是同一类错误。
 *
 * 修复方式：把 `”` 与 `’` 加进**两条**句末规则的收尾字符集
 * （末尾问号规则 + 句末「吗」规则；后者原先连半角引号都不允许）。
 * 下面这组断言就是当时的缺口用例，现在翻转为"必须命中"。
 */
describe('G4 已修复：全角右引号收尾不再被判成"任务完成"', () => {
	it('全角右引号跟在「吗」/问号之后 → 判为"等你决定"', () => {
		assert.equal(looksLikeQuestion('这是你要的最终版本吗”'), true);
		assert.equal(looksLikeQuestion('要覆盖这个文件吗？”'), true);
	});

	it('半角引号与全角引号行为一致（缺口只在字符集，不在规则本身）', () => {
		assert.equal(looksLikeQuestion('要覆盖这个文件吗？"'), true);
		assert.equal(looksLikeQuestion('要覆盖这个文件吗？”'), true);
		assert.equal(looksLikeQuestion('要我继续做吗”'), true, '"要我…做" 这条模式与尾部字符无关，仍然命中');
	});

	it('全角引号收尾的**陈述句**仍然不命中（修复没有放过反例）', () => {
		assert.equal(looksLikeQuestion('任务已完成。”'), false);
		assert.equal(looksLikeQuestion('就按这个方案来。’'), false);
	});
});

describe('bun build：语法与依赖解析', () => {
	it('bun build 通过（产物落临时目录，不污染仓库）', (t) => {
		const probe = spawnSync('bun', ['--version'], { encoding: 'utf8' });
		if (probe.error || probe.status !== 0) return t.skip('本机没有 bun（opencode 用它加载 TS 插件）');

		const outdir = join(TMP, 'dist');
		const result = spawnSync('bun', ['build', 'src/feishu-notify.ts', '--target', 'node', '--outdir', outdir], {
			cwd: PACKAGE_ROOT,
			encoding: 'utf8',
		});
		assert.equal(result.status, 0, `bun build 失败：\n${result.stdout}\n${result.stderr}`);
		assert.ok(result.stdout.includes('feishu-notify'), `产物清单里应有主入口：${result.stdout}`);
	});
});
