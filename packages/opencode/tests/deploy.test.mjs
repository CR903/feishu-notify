/**
 * tests/deploy.test.mjs — `scripts/deploy.mjs` 的文件系统契约（逐条对应
 * `.trellis/spec/opencode-plugin/filesystem-truth.md` §6 的 "Tests Required"）
 *
 * 每条用例用一个**独立的临时目标**（`FEISHU_NOTIFY_OPENCODE_PLUGINS` 覆盖），
 * 绝不碰本机真实 live 文件 —— 真实 live 只由 live-gate.test.mjs 做只读比对。
 *
 * 覆盖：
 *   未部署(exit 2) · 部署 · 幂等（mtime 不变）· 漂移检测（--check 不写）· 修复 · 再幂等
 *   符号链接（读出来的是链接本身、绝不写穿；部署后换成真实副本 —— R11）
 *   备份只建一次 · 目标是目录则拒绝 · 不留 *.deploy-* 临时文件
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, lstatSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { BACKUP_SUFFIX, EXIT, SOURCE, checkSync, deploy, targetPath } from '../scripts/deploy.mjs';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEPLOY = join(PACKAGE_ROOT, 'scripts', 'deploy.mjs');
const TMP = mkdtempSync(join(tmpdir(), 'feishu-notify-oc-deploy-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const SOURCE_BYTES = readFileSync(SOURCE);
const SOURCE_HASH = createHash('sha256').update(SOURCE_BYTES).digest('hex');

/** 每个用例一个独立目标目录 */
function freshTarget(name) {
	const dir = join(TMP, name);
	mkdirSync(dir, { recursive: true });
	const target = join(dir, 'feishu-notify.ts');
	return { dir, target, env: { FEISHU_NOTIFY_OPENCODE_PLUGINS: target } };
}

const leftovers = (dir) => readdirSync(dir).filter((name) => name.includes('.deploy-'));

describe('targetPath：目标可覆盖（测试/非标准布局），默认 XDG', () => {
	it('FEISHU_NOTIFY_OPENCODE_PLUGINS 优先', () => {
		assert.equal(targetPath({ FEISHU_NOTIFY_OPENCODE_PLUGINS: '/tmp/x/p.ts' }), '/tmp/x/p.ts');
	});

	it('默认落在 $XDG_CONFIG_HOME/opencode/plugins（否则 $HOME/.config）', () => {
		assert.equal(targetPath({ HOME: '/home/u' }), join('/home/u', '.config', 'opencode', 'plugins', 'feishu-notify.ts'));
		assert.equal(targetPath({ HOME: '/home/u', XDG_CONFIG_HOME: '/xdg' }), join('/xdg', 'opencode', 'plugins', 'feishu-notify.ts'));
	});
});

describe('未部署 → 部署 → 幂等', () => {
	it('目标不存在：--check 报 not-deployed（exit 2），且什么都不建', () => {
		const { dir, target, env } = freshTarget('absent');
		const result = checkSync({ env });

		assert.equal(result.status, 'not-deployed');
		assert.equal(result.exit, EXIT.notDeployed);
		assert.equal(result.source.hash, SOURCE_HASH);
		assert.equal(existsSync(target), false, '--check 不得创建任何文件');
		assert.deepEqual(leftovers(dir), []);
	});

	it('部署：写出与包内**逐字节相同**的副本，且不留临时文件', () => {
		const { dir, target, env } = freshTarget('install');
		const result = deploy({ env });

		assert.equal(result.status, 'deployed');
		assert.equal(result.exit, EXIT.ok);
		assert.equal(readFileSync(target).equals(SOURCE_BYTES), true, 'live 副本必须与包内逐字节相同');
		assert.equal(checkSync({ env }).status, 'in-sync');
		assert.deepEqual(leftovers(dir), [], '不留 *.deploy-* 临时文件');
	});

	it('幂等：第二次部署是 no-op，且 mtime 不变（没被重写）', () => {
		const { target, env } = freshTarget('idempotent');
		deploy({ env });
		const before = lstatSync(target).mtimeMs;

		const second = deploy({ env });
		assert.equal(second.status, 'in-sync');
		assert.equal(lstatSync(target).mtimeMs, before, '内容相同就不该重写（mtime 变了说明写了一遍）');
	});
});

describe('漂移检测：--check 只读', () => {
	it('目标被改动：--check 报漂移（exit 1），且**一个字节都不写**', () => {
		const { target, env } = freshTarget('drift');
		deploy({ env });
		writeFileSync(target, `${readFileSync(target, 'utf8')}\n// 漂移\n`);
		const drifted = readFileSync(target);

		const result = checkSync({ env });
		assert.equal(result.status, 'drift');
		assert.equal(result.exit, EXIT.drift);
		assert.equal(result.target.hash === result.source.hash, false);
		assert.equal(readFileSync(target).equals(drifted), true, '--check 必须保持目标原样');
	});

	it('修一次就回到同步；再修一次是 no-op', () => {
		const { target, env } = freshTarget('repair');
		deploy({ env });
		writeFileSync(target, 'drift');

		assert.equal(deploy({ env }).status, 'deployed');
		assert.equal(readFileSync(target).equals(SOURCE_BYTES), true);
		assert.equal(deploy({ env }).status, 'in-sync');
	});
});

describe('备份：*.pre-package.bak 只建一次（回滚点不能被自己的部署吃掉）', () => {
	it('首次部署一个已存在的目标 → 备份内容是**迁移前**那份', () => {
		const { target, env } = freshTarget('backup-first');
		writeFileSync(target, '迁移前的内容\n');

		deploy({ env });
		assert.equal(readFileSync(`${target}${BACKUP_SUFFIX}`, 'utf8'), '迁移前的内容\n');
	});

	it('第二次部署（目标又漂移了）→ 备份**不被覆盖**，仍是迁移前那份', () => {
		const { target, env } = freshTarget('backup-kept');
		writeFileSync(target, '迁移前的内容\n');
		deploy({ env });

		writeFileSync(target, '部署之后又被改坏的内容\n');
		const second = deploy({ env });

		assert.equal(readFileSync(`${target}${BACKUP_SUFFIX}`, 'utf8'), '迁移前的内容\n', '回滚点必须保持最初那份');
		assert.match(second.notes.join('\n'), /备份已存在/);
	});
});

describe('符号链接（R11：仓库一动就悬空，且悬空不报错）', () => {
	it('live 是符号链接 → --check 报漂移（即使它指向的内容一致）', () => {
		const { dir, target, env } = freshTarget('symlink-check');
		const repoCopy = join(dir, 'repo-copy.ts');
		writeFileSync(repoCopy, SOURCE_BYTES);
		symlinkSync(repoCopy, target);

		const result = checkSync({ env });
		assert.equal(result.status, 'drift');
		assert.equal(result.target.kind, 'symlink');
		assert.match(result.detail, /符号链接/);
	});

	it('部署：替换**链接本身**为真实副本，绝不给被指向的文件写穿', () => {
		const { dir, target, env } = freshTarget('symlink-deploy');
		const repoCopy = join(dir, 'repo-copy.ts');
		writeFileSync(repoCopy, '别人仓库里的原文件（绝不能被改）\n');
		symlinkSync(repoCopy, target);

		const result = deploy({ env });
		assert.equal(result.status, 'deployed');
		assert.equal(lstatSync(target).isSymbolicLink(), false, 'live 必须是真实文件（复制式部署）');
		assert.equal(readFileSync(target).equals(SOURCE_BYTES), true);
		assert.equal(readFileSync(repoCopy, 'utf8'), '别人仓库里的原文件（绝不能被改）\n', '被指向的文件必须原样');
		assert.match(result.notes.join('\n'), /符号链接：已替换为真实副本/);
	});
});

describe('拒绝与清理', () => {
	it('目标是目录 → 拒绝（exit 1），且不递归、不删除', () => {
		const { dir, env } = freshTarget('dir-refuse');
		const target = join(dir, 'feishu-notify.ts');
		mkdirSync(target);
		writeFileSync(join(target, 'inner.txt'), 'x');

		const check = checkSync({ env: { FEISHU_NOTIFY_OPENCODE_PLUGINS: target } });
		assert.equal(check.status, 'refuse');
		assert.equal(check.exit, EXIT.drift);

		const write = deploy({ env: { FEISHU_NOTIFY_OPENCODE_PLUGINS: target } });
		assert.equal(write.status, 'refuse');
		assert.equal(lstatSync(target).isDirectory(), true, '目录必须还在');
		assert.equal(existsSync(join(target, 'inner.txt')), true, '目录内容不得被删');
		assert.deepEqual(leftovers(dir), []);
	});

	it('--dry-run：只打印计划，不写任何文件', () => {
		const { dir, target, env } = freshTarget('dry-run');
		const result = deploy({ env, dryRun: true });

		assert.equal(result.dryRun, true);
		assert.equal(existsSync(target), false);
		assert.deepEqual(leftovers(dir), []);
	});
});

describe('CLI 退出码（spawn 真实进程）', () => {
	const run = (dir, args) =>
		spawnSync(process.execPath, [DEPLOY, ...args], {
			cwd: PACKAGE_ROOT,
			encoding: 'utf8',
			env: { ...process.env, FEISHU_NOTIFY_OPENCODE_PLUGINS: join(dir, 'feishu-notify.ts') },
		});

	it('未部署 → exit 2（与"漂移 exit 1"区分，测试据此判断本机是否部署过）', () => {
		const { dir } = freshTarget('cli-absent');
		const result = run(dir, ['--check']);
		assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
		assert.match(result.stderr, /从未部署/);
	});

	it('部署后 --check → exit 0 并打印两边哈希', () => {
		const { dir } = freshTarget('cli-ok');
		assert.equal(run(dir, []).status, 0);
		const result = run(dir, ['--check']);

		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.match(result.stdout, new RegExp(SOURCE_HASH));
		assert.match(result.stdout, /in-sync/);
	});

	it('漂移 → exit 1 + 修法提示', () => {
		const { dir } = freshTarget('cli-drift');
		run(dir, []);
		writeFileSync(join(dir, 'feishu-notify.ts'), 'broken');

		const result = run(dir, ['--check']);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /修法：node scripts\/deploy\.mjs/);
	});

	it('未知参数 → exit 1 + 用法', () => {
		const { dir } = freshTarget('cli-usage');
		const result = run(dir, ['--nope']);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /未知参数/);
	});
});
