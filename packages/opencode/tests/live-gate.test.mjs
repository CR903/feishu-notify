/**
 * tests/live-gate.test.mjs — **漂移闸门**：本机 live 插件与包内文件必须逐字节相同
 * （implement.md Step 3.4；R11 的教训是"链接/副本一旦漂移，故障是静默的"）
 *
 * 为什么是"复制式部署 + 哈希闸门"：本包刻意不用符号链接（仓库移动会让链接悬空，而悬空不报错）。
 * 复制换来了"可能忘记部署"这一新失败模式，这条测试就是为它存在的。
 *
 * 三种结果：
 *   0 → 通过（并顺带断言 live 里**没有**任何 hook 地址、且它不是符号链接）
 *   2 → **跳过**：本机从未部署过这个插件（`live` 文件不存在）。"没部署"不是漂移
 *       —— 否则任何一台干净机器上 `npm test` 都会红，闸门会被当成噪音而被无视
 *   1 → 失败：真的漂移了，附上修法
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { SOURCE, targetPath } from '../scripts/deploy.mjs';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEPLOY = join(PACKAGE_ROOT, 'scripts', 'deploy.mjs');

describe('漂移闸门：live 插件 == 包内源文件', () => {
	it("`deploy --check` 通过（exit 0），或明确报告本机未部署（exit 2 → skip）", (t) => {
		const result = spawnSync(process.execPath, [DEPLOY, '--check'], { cwd: PACKAGE_ROOT, encoding: 'utf8' });
		const output = `${result.stdout}${result.stderr}`;

		if (result.status === 2) {
			const live = targetPath();
			assert.equal(existsSync(live), false, `exit 2 的语义是"live 不存在"，但它存在：${live}`);
			return t.skip(`本机未部署（${live} 不存在）—— "没部署"不是漂移，部署：node scripts/deploy.mjs`);
		}

		assert.equal(
			result.status,
			0,
			`live 插件与包内文件漂移（exit ${result.status}）。修法：node scripts/deploy.mjs\n${output}`,
		);
		assert.match(output, /in-sync/);
	});

	it('live 是**真实文件**而不是符号链接（R11：链接会随仓库移动而悬空，且悬空不报错）', (t) => {
		const live = targetPath();
		if (!existsSync(live)) return t.skip('本机未部署（live 不存在）');
		assert.equal(lstatSync(live).isSymbolicLink(), false, `live 是符号链接，请跑 node scripts/deploy.mjs 换成真实副本：${live}`);
	});

	it('live 与包内**逐字节相同**', (t) => {
		const live = targetPath();
		if (!existsSync(live)) return t.skip('本机未部署（live 不存在）');
		assert.equal(readFileSync(live).equals(readFileSync(SOURCE)), true, `live 与 ${SOURCE} 不一致：跑 node scripts/deploy.mjs`);
	});

	it('live 里没有任何 hook 地址（部署出去的那份自己也不持有地址）', (t) => {
		const live = targetPath();
		if (!existsSync(live)) return t.skip('本机未部署（live 不存在）');
		const hits = readFileSync(live, 'utf8').match(/open-apis\/bot\/v2\/hook\/[A-Za-z0-9_%.-]{6,}/g) ?? [];
		// 只报数量：命中内容就是真实地址，绝不能进入断言消息（那等于让检测器打印泄漏物）
		assert.equal(hits.length, 0, `live 里仍有 ${hits.length} 处硬编码地址 —— 正是 R-1 要清掉的东西`);
	});
});
