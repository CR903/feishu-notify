/**
 * tests/notify-bin.test.mjs — 发送端路径解析（G1）与两级日志
 *
 * G1 的原始缺陷：插件把发送端写死成 `${HOME}/.local/bin/feishu-notify`。
 * npm 的全局 bin 目录不一定是这里（nvm / Homebrew / pnpm 各有各的 prefix），
 * 于是**通知发不出去**，而失败只写在 DEBUG 日志里 —— 与 AC4 的"报错明确"直接冲突。
 *
 * 本文件钉住三件事：
 *   1. 解析顺序：`FEISHU_NOTIFY_BIN` → `~/.local/bin/…`（可执行才算）→ PATH → 都没有
 *   2. 都没有时**不 spawn**（用一个猜出来的路径去跑，只会把"缺依赖"伪装成别的错误）
 *   3. 日志分级：失败/降级**无条件落盘**且行首带 ` ERROR `；成功细节只在 FEISHU_NOTIFY_DEBUG=1 时写
 *
 * 全部用临时目录 + 注入的 `exec` / `run`，不联网、不碰真实 HOME（除非子进程显式换 HOME 到临时目录）。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';

import {
	NOTIFY_BIN_ENV,
	describeBinFailure,
	feishuNotify,
	resolveNotifyBin,
	runSender,
} from '../src/feishu-notify.ts';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODULE_URL = pathToFileURL(join(PACKAGE_ROOT, 'src', 'feishu-notify.ts')).href;

const TMP = mkdtempSync(join(tmpdir(), 'feishu-notify-oc-bin-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

let counter = 0;
const freshDir = (label) => {
	const dir = join(TMP, `${label}-${++counter}`);
	mkdirSync(dir, { recursive: true });
	return dir;
};

/** 造一个"可执行的发送端"（内容不重要，本文件只验路径解析） */
function makeExecutable(dir, name = 'feishu-notify') {
	const path = join(dir, name);
	writeFileSync(path, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
	chmodSync(path, 0o755);
	return path;
}

/** 造一个"存在但不可执行"的同名文件（最容易骗过 existsSync 的那种） */
function makeNonExecutable(dir, name = 'feishu-notify') {
	const path = join(dir, name);
	writeFileSync(path, 'not executable\n', { mode: 0o644 });
	chmodSync(path, 0o644);
	return path;
}

// ---------------------------------------------------------------- 解析顺序

describe('resolveNotifyBin：FEISHU_NOTIFY_BIN → ~/.local/bin → PATH → 都没有', () => {
	it('① FEISHU_NOTIFY_BIN 指定且可执行 → 用它（source=env）', () => {
		const explicitDir = freshDir('explicit');
		const explicit = makeExecutable(explicitDir);
		const home = freshDir('home-env');
		mkdirSync(join(home, '.local', 'bin'), { recursive: true });
		makeExecutable(join(home, '.local', 'bin'), 'feishu-notify'); // 默认位置也有，但 env 应当赢

		const resolution = resolveNotifyBin({ env: { [NOTIFY_BIN_ENV]: explicit, HOME: home, PATH: '' } });
		assert.equal(resolution.path, explicit);
		assert.equal(resolution.source, 'env');
		assert.equal(resolution.reason, 'env');
	});

	it('② FEISHU_NOTIFY_BIN 未设 → 用 ~/.local/bin/feishu-notify（source=home）', () => {
		const home = freshDir('home-only');
		const homeBin = join(home, '.local', 'bin');
		mkdirSync(homeBin, { recursive: true });
		const expected = makeExecutable(homeBin);
		const pathDir = freshDir('path-decoy');
		makeExecutable(pathDir); // PATH 里也有：home 优先

		const resolution = resolveNotifyBin({ env: { HOME: home, PATH: pathDir } });
		assert.equal(resolution.path, expected);
		assert.equal(resolution.source, 'home');
	});

	it('③ 默认位置没有/不可执行 → 落到 PATH 里第一个可执行的 feishu-notify（source=path）', () => {
		const home = freshDir('home-empty');
		mkdirSync(join(home, '.local', 'bin'), { recursive: true });
		makeNonExecutable(join(home, '.local', 'bin')); // 存在但没 x 位：不算数

		const decoy = freshDir('path-decoy-2');
		makeNonExecutable(decoy); // PATH 里第一个也是不可执行的：必须跳过
		const real = freshDir('path-real');
		const expected = makeExecutable(real);

		const resolution = resolveNotifyBin({ env: { HOME: home, PATH: `${decoy}:${real}:${freshDir('path-later')}` } });
		assert.equal(resolution.path, expected);
		assert.equal(resolution.source, 'path');
		assert.equal(resolution.reason, 'path');
	});

	it('④ 三处都没有 → path=null（调用方必须据此**不发送**）', () => {
		const home = freshDir('home-none');
		const emptyPath = freshDir('path-none');
		const resolution = resolveNotifyBin({ env: { HOME: home, PATH: emptyPath } });

		assert.equal(resolution.path, null);
		assert.equal(resolution.reason, 'not-found');
		assert.equal(resolution.candidates.at(-1).source, 'path');
		assert.match(describeBinFailure(resolution), /找不到发送端/);
		assert.match(describeBinFailure(resolution), /已找：/, '必须列出找过的位置');
	});

	it('⑤ 显式指定但不可执行 → **报错而不是改用别的**（reason=env-invalid）', () => {
		const home = freshDir('home-env-invalid');
		mkdirSync(join(home, '.local', 'bin'), { recursive: true });
		makeExecutable(join(home, '.local', 'bin')); // 明明有一个能用的
		const pathDir = freshDir('path-env-invalid');
		makeExecutable(pathDir); // PATH 里也有一个

		const bogus = join(freshDir('bogus'), 'feishu-notify'); // 不存在
		const resolution = resolveNotifyBin({ env: { [NOTIFY_BIN_ENV]: bogus, HOME: home, PATH: pathDir } });

		assert.equal(resolution.path, null, '显式指定即权威：不能悄悄改用另一个二进');
		assert.equal(resolution.reason, 'env-invalid');
		const message = describeBinFailure(resolution);
		assert.match(message, new RegExp(NOTIFY_BIN_ENV));
		assert.match(message, /不存在或不可执行/);
		assert.ok(message.includes(bogus), '报错要点名用户设置的那个路径');
	});
});

// ---------------------------------------------------------------- 真的不 spawn

describe('runSender：解析不出来就不 spawn', () => {
	it('解析成功 → exec 拿到解析出的绝对路径与 argv', () => {
		const dir = freshDir('exec-ok');
		const bin = makeExecutable(dir);
		const calls = [];
		const exec = (file, argv, options) => {
			calls.push({ file, argv, options });
			return '✅ 飞书消息已发送\n';
		};

		const result = runSender(['--title', 'T'], { env: { HOME: freshDir('h'), PATH: dir }, exec });
		assert.equal(result.ok, true);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].file, bin);
		assert.deepEqual(calls[0].argv, ['--title', 'T']);
		assert.equal(calls[0].options.timeout, 10_000);
	});

	it('三处都没有 → exec **一次都没被调用**，返回 status=-1 与安装指引', () => {
		let called = false;
		const exec = () => {
			called = true;
			throw new Error('不该被调用');
		};

		const result = runSender(['--title', 'T'], { env: { HOME: freshDir('h-missing'), PATH: freshDir('p-missing') }, exec });
		assert.equal(called, false, '没有任何可用路径时绝不能 spawn');
		assert.equal(result.ok, false);
		assert.equal(result.status, -1);
		assert.match(result.stderr, /找不到发送端/);
		assert.match(result.stderr, /feishu-notify-cli/, '要指向"去装 CLI"这个下一步');
	});

	it('解析到了但起不来（ENOENT）→ status=-1 且错误里带那个路径', () => {
		const dir = freshDir('exec-enoent');
		const bin = makeExecutable(dir);
		const exec = () => {
			throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT', status: null });
		};

		const result = runSender(['--title', 'T'], { env: { HOME: freshDir('h2'), PATH: dir }, exec });
		assert.equal(result.ok, false);
		assert.equal(result.status, -1);
		assert.ok(result.stderr.includes(bin), `错误里应带解析到的路径：${result.stderr}`);
	});

	it('发送端自己报错（有 stderr）→ 原样透出，code 保留', () => {
		const dir = freshDir('exec-fail');
		makeExecutable(dir);
		const exec = () => {
			throw Object.assign(new Error('exit 1'), { status: 1, stderr: '❌ 发送失败 (HTTP 500)' });
		};

		const result = runSender(['--title', 'T'], { env: { HOME: freshDir('h3'), PATH: dir }, exec });
		assert.equal(result.status, 1);
		assert.match(result.stderr, /HTTP 500/);
	});
});

// ---------------------------------------------------------------- 日志分级（注入 logger）

describe('feishuNotify：失败/降级写 error 级，成功只写 debug 级', () => {
	const collect = () => {
		const lines = [];
		return { lines, logger: (msg, level) => lines.push({ msg, level }) };
	};
	const OK = { ok: true, status: 0, stderr: '', stdout: '✅ 飞书消息已发送\n' };
	const failure = (status, stderr) => ({ ok: false, status, stderr, stdout: '' });
	const notFoundStderr = '配置里没有名为 "opencode" 的 channel（已有：default）';

	it('成功 → level=debug（细节追踪，不落盘）', () => {
		const { lines, logger } = collect();
		feishuNotify(['--title', 'T'], { run: () => OK, logger });
		assert.equal(lines.length, 1);
		assert.equal(lines[0].level, 'debug');
		assert.match(lines[0].msg, /notify ok:/);
	});

	it('降级成功 → level=error（**必须可见**，哪怕用户没开 DEBUG）', () => {
		const { lines, logger } = collect();
		let calls = 0;
		const run = () => (++calls === 1 ? failure(2, notFoundStderr) : OK);
		feishuNotify(['--title', 'T'], { run, logger });
		assert.equal(lines.length, 1);
		assert.equal(lines[0].level, 'error');
		assert.match(lines[0].msg, /notify DEGRADED/);
	});

	it('失败 → level=error', () => {
		const { lines, logger } = collect();
		feishuNotify(['--title', 'T'], { run: () => failure(1, '❌ 发送失败'), logger });
		assert.equal(lines.length, 1);
		assert.equal(lines[0].level, 'error');
		assert.match(lines[0].msg, /notify FAILED/);
	});
});

// ---------------------------------------------------------------- 日志分级（默认 logger 真的落盘）

describe('默认 logger：logError 无条件落盘，log 受 FEISHU_NOTIFY_DEBUG 控制', () => {
	/** 在子进程里跑（LOG_FILE 在模块加载时由 HOME 决定；同一进程改 HOME 没用） */
	function runInChild(home, body) {
		const env = { ...process.env, HOME: home };
		delete env.FEISHU_NOTIFY_DEBUG;
		delete env[NOTIFY_BIN_ENV];
		const code = `import { feishuNotify } from ${JSON.stringify(MODULE_URL)};\n${body}`;
		const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env });
		assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
		return join(home, '.local', 'share', 'opencode', 'feishu-notify.log');
	}

	it('发送失败：FEISHU_NOTIFY_DEBUG 未设置，日志文件里仍有 ` ERROR ` 行', () => {
		const home = freshDir('log-error');
		const file = runInChild(
			home,
			`feishuNotify(['--title', 'T'], { run: () => ({ ok: false, status: 1, stderr: 'boom', stdout: '' }) });`,
		);

		assert.equal(existsSync(file), true, `失败必须落盘，但日志文件不存在：${file}`);
		const text = readFileSync(file, 'utf8');
		assert.match(text, / ERROR notify FAILED \(failed, 尝试 1 次, exit=1\)/, text);
		assert.match(text, /boom/, '失败原因要写进去，否则只知道失败了');
	});

	it('发送成功：同一开关下**不写**日志（细节只在 DEBUG 时出现）', () => {
		const home = freshDir('log-debug-off');
		const file = runInChild(
			home,
			`feishuNotify(['--title', 'T'], { run: () => ({ ok: true, status: 0, stderr: '', stdout: 'ok' }) });`,
		);
		assert.equal(existsSync(file), false, `成功细节不该在未开 DEBUG 时落盘：${file}`);
	});

	it('找不到发送端：默认路径（不注入 run）也会留下 ` ERROR ` 行', () => {
		const home = freshDir('log-missing-bin');
		const emptyBin = freshDir('log-missing-bin-path');
		const env = { ...process.env, HOME: home, PATH: emptyBin };
		delete env.FEISHU_NOTIFY_DEBUG;
		delete env[NOTIFY_BIN_ENV];
		const code = `import { feishuNotify } from ${JSON.stringify(MODULE_URL)};\nfeishuNotify(['--title', 'T']);`;
		const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env });
		assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);

		const file = join(home, '.local', 'share', 'opencode', 'feishu-notify.log');
		assert.equal(existsSync(file), true, `找不到发送端必须落盘，但日志文件不存在：${file}`);
		const text = readFileSync(file, 'utf8');
		assert.match(text, / ERROR notify FAILED/);
		assert.match(text, /找不到发送端/);
		assert.match(text, /feishu-notify-cli/);
	});
});
