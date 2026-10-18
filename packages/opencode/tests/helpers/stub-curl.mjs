/**
 * tests/helpers/stub-curl.mjs — 本包自己的假 curl（放进 PATH 最前面，**不联网**）
 *
 * 为什么不复用 `packages/cli/tests/helpers/stub-curl.mjs`：那是**另一个包的测试资产**
 * （不进它的发布产物，也不属于本包的接口）。两个包的测试各自独立，将来谁改自己的替身也不会
 * 弄坏对方。重复的只有这 30 行 shell。
 *
 * 契约（与真实 curl 的调用形状一致，照着发送端 `bin/feishu-notify` 的实际调用写）：
 *   curl -sS -w '\n%{http_code}' -X POST <url> -H 'Content-Type: application/json' -d "$PAYLOAD"
 *
 * 行为：
 *   - 每次调用把 {"url","token"} 追加到 $FEISHU_STUB_LOG（调用方据此断言"打到了哪个地址"）
 *   - payload 原样写到 ${FEISHU_STUB_LOG}.payload
 *   - 一律回 HTTP 200 + {"code":0}（本测试只关心**打到哪儿**，不模拟业务失败）
 *
 * token 不落盘到别处、也不打印：路由断言在内存里比对（真实 token 只出现在临时日志里，用完即删）。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const STUB_CURL_SOURCE = [
	'#!/bin/sh',
	'set -eu',
	'log=${FEISHU_STUB_LOG:?FEISHU_STUB_LOG not set}',
	'url=""',
	'payload=""',
	'want=0',
	'for arg in "$@"; do',
	'  if [ "$want" = "1" ]; then payload=$arg; want=0; continue; fi',
	'  case $arg in',
	'    -d|--data|--data-raw|--data-binary) want=1 ;;',
	'    http://*|https://*) url=$arg ;;',
	'  esac',
	'done',
	'token=$(printf \'%s\' "$url" | sed -E \'s#.*/##\')',
	'printf \'{"url":"%s","token":"%s"}\\n\' "$url" "$token" >> "$log"',
	'printf \'%s\' "$payload" > "${log}.payload"',
	'printf \'{"code":0,"msg":"success"}\'',
	'printf \'\\n200\\n\'',
	'exit 0',
	'',
].join('\n');

/** 把假 curl 装到 dir/curl，返回它的路径（调用方把它前置进 PATH） */
export function installStubCurl(dir) {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, 'curl');
	writeFileSync(path, STUB_CURL_SOURCE, { mode: 0o755 });
	chmodSync(path, 0o755);
	return path;
}

export function resetStubLog(logPath) {
	rmSync(logPath, { force: true });
	rmSync(`${logPath}.payload`, { force: true });
}

/** 本次运行对假 curl 的全部调用（按顺序） */
export function readStubCalls(logPath) {
	if (!existsSync(logPath)) return [];
	return readFileSync(logPath, 'utf8')
		.trim()
		.split('\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

export function readStubPayload(logPath) {
	return readFileSync(`${logPath}.payload`, 'utf8');
}

/** 只保留 scheme+host+路径前缀，token 一律打掉 —— 任何输出/断言失败信息里都不出现明文 */
export function maskUrl(url) {
	if (typeof url !== 'string' || url === '') return '<空>';
	return url.replace(/\/[^/]+$/, '/<REDACTED>');
}
