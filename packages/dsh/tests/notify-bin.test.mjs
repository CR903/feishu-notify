/**
 * 发送链路：发送端定位（G1 的教训）、spawn 姿势、失败**无条件**记日志。
 *
 * 最后一组是真实 spawn 的集成测试：用一个 stub 可执行文件代替内核 CLI，
 * 证明 argv 真的按内核 CLI 的契约传到了进程里，且不会因为 stdin 没关而挂住。
 */

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { apply, buildNotifyArgv, createSender, createSessionHandler, describeBinFailure, NOTIFY_BIN_ENV, resolveNotifyBin } from '../lib/index.js';

// ---------------------------------------------------------------- 发送端定位

function emptyEnv(home) {
	return { HOME: home, PATH: '' };
}

test('resolveNotifyBin：显式 env 优先，且指出不可执行时**报错而不是改找别的**', () => {
	const notExecutable = () => false;
	const resolution = resolveNotifyBin({ env: { ...emptyEnv('/tmp/none'), [NOTIFY_BIN_ENV]: '/opt/feishu-notify' }, isExecutable: notExecutable });
	assert.equal(resolution.path, null);
	assert.equal(resolution.reason, 'env-invalid');
	assert.equal(resolution.candidates[0].path, '/opt/feishu-notify');
	assert.match(describeBinFailure(resolution), /显式指定不会被忽略/);
});

test('resolveNotifyBin：~/.local/bin 命中就不再看 PATH', () => {
	const home = '/home/u';
	const resolution = resolveNotifyBin({ env: emptyEnv(home), isExecutable: (p) => p === join(home, '.local', 'bin', 'feishu-notify') });
	assert.equal(resolution.source, 'home');
	assert.equal(resolution.path, join(home, '.local', 'bin', 'feishu-notify'));
});

test('resolveNotifyBin：PATH 里找得到（nvm / Homebrew / pnpm 的 bin 目录都不一样）', () => {
	const resolution = resolveNotifyBin({
		env: { HOME: '/home/u', PATH: '/usr/bin:/opt/homebrew/bin' },
		isExecutable: (p) => p === join('/opt/homebrew/bin', 'feishu-notify'),
	});
	assert.equal(resolution.source, 'path');
	assert.equal(resolution.path, '/opt/homebrew/bin/feishu-notify');
});

test('resolveNotifyBin：都没有 → null，并把「找过哪些位置」原样留下', () => {
	const resolution = resolveNotifyBin({ env: { HOME: '/home/u', PATH: '/usr/bin:/bin' }, isExecutable: () => false });
	assert.equal(resolution.path, null);
	assert.equal(resolution.reason, 'not-found');
	const text = describeBinFailure(resolution);
	assert.match(text, /\/home\/u\/\.local\/bin\/feishu-notify/);
	assert.match(text, /PATH 的 2 个目录里都没有可执行的 feishu-notify/);
	assert.match(text, /npm i -g feishu-notify-cli/);
});

// ---------------------------------------------------------------- createSender 的姿势

function fakeChild(pid = 4_242) {
	const handlers = {};
	const child = {
		pid,
		killed: [],
		stderr: { on() {} },
		on(event, listener) {
			handlers[event] = listener;
			return child;
		},
		kill(signal) {
			child.killed.push(signal);
		},
	};
	return { child, handlers };
}

test('发送端不存在 → **不 spawn** 且无条件记 ERROR（走默认 onError → ctx.logger.error）', () => {
	const logs = [];
	const spawnCalls = [];
	const ctx = { logger: { error: (m) => logs.push(String(m)), warn() {}, info() {}, debug() {} } };
	const handler = createSessionHandler({
		ctx,
		config: { channel: 'dsh' },
		senderOptions: {
			spawn: (...args) => {
				spawnCalls.push(args);
				return fakeChild().child;
			},
			env: { HOME: '/tmp/definitely-not-here', PATH: '' },
		},
	});

	assert.doesNotThrow(() =>
		handler({ id: 's', header: {}, requestContext: () => undefined }, { type: 'turn/end', seq: 1, time: 5, data: { turn: 1, reason: { kind: 'completed' } } }),
	);
	assert.equal(spawnCalls.length, 0, '解析不到发送端就绝不 spawn');
	assert.equal(logs.length, 1, 'ERROR 日志有且只有一行');
	assert.match(logs[0], /dsh-feishu-notify: 找不到发送端 feishu-notify/);
	assert.match(logs[0], /\.local\/bin\/feishu-notify/);
	assert.match(logs[0], /本次通知未发送/);
});

test('spawn 姿势：stdin=ignore（否则内核脚本会 `cat -` 挂到超时）、shell=false、自成进程组', () => {
	const { child } = fakeChild();
	const seen = [];
	const send = createSender({
		spawn: (path, argv, options) => {
			seen.push({ path, argv, options });
			return child;
		},
		env: { [NOTIFY_BIN_ENV]: '/opt/feishu-notify' },
		isExecutable: () => true,
		onError: () => {},
	});

	send(buildNotifyArgv({ channel: 'dsh', title: 'T', body: 'B' }));

	assert.equal(seen.length, 1);
	assert.equal(seen[0].path, '/opt/feishu-notify', 'spawn 的是解析出来的绝对路径');
	assert.equal(seen[0].options.shell, false);
	assert.equal(seen[0].options.stdio[0], 'ignore');
	assert.equal(seen[0].options.detached, process.platform !== 'win32');
});

test('退出码非 0 → ERROR（含 exit 与 stderr 首行）；退出码 0 → 不报错', () => {
	for (const [code, expectError] of [
		[1, true],
		[2, true],
		[0, false],
	]) {
		const { child, handlers } = fakeChild();
		const errors = [];
		const send = createSender({
			spawn: () => child,
			env: { [NOTIFY_BIN_ENV]: '/opt/feishu-notify' },
			isExecutable: () => true,
			onError: (message) => errors.push(message),
		});

		send(buildNotifyArgv({ channel: 'dsh', title: 'T', body: 'B' }));
		handlers.close(code);

		assert.equal(errors.length, expectError ? 1 : 0, `exit=${code}`);
		if (expectError) assert.match(errors[0], new RegExp(`发送失败（exit=${code}）`));
	}
});

test(
	'超时 → 杀**整个进程组**（只杀 bash 会留下它拉起的 node 孤儿）',
	{ skip: process.platform === 'win32' },
	async () => {
		const { child } = fakeChild(4_242);
		const errors = [];
		const originalKill = process.kill;
		const kills = [];
		process.kill = (pid, signal) => {
			kills.push([pid, signal]);
		};
		try {
			const send = createSender({
				spawn: () => child,
				env: { [NOTIFY_BIN_ENV]: '/opt/feishu-notify' },
				isExecutable: () => true,
				onError: (message) => errors.push(message),
				timeoutMs: 20,
			});
			send(buildNotifyArgv({ channel: 'dsh', title: 'T', body: 'B' }));
			await new Promise((resolve) => setTimeout(resolve, 80));
		} finally {
			process.kill = originalKill;
		}

		assert.deepEqual(kills, [[-4_242, 'SIGTERM']], '负 pid = 进程组');
		assert.equal(errors.length, 1);
		assert.match(errors[0], /超时/);
	},
);

test('spawn 自身抛异常（ENOENT 之类）→ ERROR，不抛到调用方', () => {
	const errors = [];
	const send = createSender({
		spawn: () => {
			throw new Error('EACCES');
		},
		env: { [NOTIFY_BIN_ENV]: '/opt/feishu-notify' },
		isExecutable: () => true,
		onError: (message) => errors.push(message),
	});
	assert.doesNotThrow(() => send(buildNotifyArgv({ channel: 'dsh', title: 'T', body: 'B' })));
	assert.equal(errors.length, 1);
	assert.match(errors[0], /spawn 发送端失败/);
});

// ---------------------------------------------------------------- 真实 spawn（stub 二进制）

const STUB = `#!/bin/sh
# 模拟内核 CLI 的 stdin 行为：stdin 不是一个已关闭的流就会一直等（原来的坑）
cat - >/dev/null 2>&1 || true
: > "$FEISHU_STUB_RECORD"
for a in "$@"; do printf '%s\\n' "$a" >> "$FEISHU_STUB_RECORD"; done
exit 0
`;

async function waitForFile(file, deadlineMs = 5_000) {
	const started = Date.now();
	while (Date.now() - started < deadlineMs) {
		if (existsSync(file)) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return existsSync(file);
}

test('端到端（不启 DSH）：apply 注册的 listener 真把 argv 送进了一个进程', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'dsh-feishu-notify-'));
	const bin = join(dir, 'feishu-notify');
	const record = join(dir, 'argv.txt');
	writeFileSync(bin, STUB, 'utf8');
	chmodSync(bin, 0o755);

	const registered = [];
	const logs = [];
	const ctx = {
		on(event, listener) {
			registered.push({ event, listener });
			return () => {};
		},
		logger: { error: (m) => logs.push(String(m)), warn() {}, info() {}, debug() {} },
		sessionTitle: { get: () => ({ title: '真实 spawn' }) },
		sessionProjections: { stateOf: () => undefined },
	};

	const previousBin = process.env[NOTIFY_BIN_ENV];
	const previousRecord = process.env.FEISHU_STUB_RECORD;
	process.env[NOTIFY_BIN_ENV] = bin;
	process.env.FEISHU_STUB_RECORD = record;
	try {
		apply(ctx, { channel: 'dsh' });
		assert.deepEqual(
			registered.map((entry) => entry.event),
			['session/event'],
		);

		registered[0].listener(
			{ id: 'ses_e2e', header: { cwd: '/tmp/proj' }, requestContext: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) },
			{ type: 'turn/end', seq: 1, time: 100, data: { turn: 1, reason: { kind: 'completed' } } },
		);

		assert.ok(await waitForFile(record), '子进程没有读到已关闭的 stdin（否则这里会超时）');
		const argv = readFileSync(record, 'utf8').split('\n').filter((line) => line !== '');
		assert.deepEqual(argv.slice(0, 4), ['--source', 'dsh', '--channel', 'dsh']);
		assert.equal(argv[5], '✅ 任务完成 · 真实 spawn');
		assert.match(argv[6], /\*\*目录\*\*: `\/tmp\/proj`/);
		assert.equal(logs.length, 0, `不该有 ERROR 日志（收到：${logs.join(' | ')}）`);
	} finally {
		if (previousBin === undefined) delete process.env[NOTIFY_BIN_ENV];
		else process.env[NOTIFY_BIN_ENV] = previousBin;
		if (previousRecord === undefined) delete process.env.FEISHU_STUB_RECORD;
		else process.env.FEISHU_STUB_RECORD = previousRecord;
		rmSync(dir, { recursive: true, force: true });
	}
});
