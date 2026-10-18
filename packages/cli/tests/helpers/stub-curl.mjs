/**
 * tests/helpers/stub-curl.mjs — 测试用的假 curl（被放进 PATH 最前面，**不联网**）
 *
 * init.test.mjs（CLI 侧 init/doctor 的测试卡片）与 sender-compat.test.mjs（bash 发送端）
 * 共用这一份替身，避免两处各写一遍、行为漂移。
 *
 * 契约（与真实 curl 的调用形状一致）：
 *   curl -sS -w '\n%{http_code}' -X POST <url> -H 'Content-Type: application/json' --data-binary <payload>
 * 替身行为：
 *   - 每次调用把 {"url","token"} 追加到 $FEISHU_STUB_LOG（调用方断言"打到了哪个地址"）
 *   - 把 payload 原样写到 ${FEISHU_STUB_LOG}.payload（逐字节，供比对）
 *   - token 命中 $FEISHU_STUB_FAIL_CODE → HTTP 200 + {"code":19001}（模拟飞书"HTTP 200 但业务失败"）
 *   - token 命中 $FEISHU_STUB_FAIL_500  → HTTP 500 + {"code":19002}
 *   - 其它 → HTTP 200 + {"code":0}
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const STUB_CURL_SOURCE = [
	"#!/bin/sh",
	"set -eu",
	'log=${FEISHU_STUB_LOG:?FEISHU_STUB_LOG not set}',
	'url=""',
	'payload=""',
	"want=0",
	'for arg in "$@"; do',
	'  if [ "$want" = "1" ]; then payload=$arg; want=0; continue; fi',
	"  case $arg in",
	"    -d|--data|--data-raw|--data-binary) want=1 ;;",
	"    http://*|https://*) url=$arg ;;",
	"  esac",
	"done",
	'token=$(printf \'%s\' "$url" | sed -E \'s#.*/##\')',
	"printf '{\"url\":\"%s\",\"token\":\"%s\"}\\n' \"$url\" \"$token\" >> \"$log\"",
	'printf \'%s\' "$payload" > "${log}.payload"',
	'case ",${FEISHU_STUB_FAIL_CODE:-}," in',
	"  *\",$token,\"*) printf '{\"code\":19001,\"msg\":\"token invalid\"}'; printf '\\n200\\n'; exit 0 ;;",
	"esac",
	'case ",${FEISHU_STUB_FAIL_500:-}," in',
	"  *\",$token,\"*) printf '{\"code\":19002,\"msg\":\"server error\"}'; printf '\\n500\\n'; exit 0 ;;",
	"esac",
	"printf '{\"code\":0,\"msg\":\"success\"}'",
	"printf '\\n200\\n'",
	"exit 0",
	"",
].join("\n");

/** 把假 curl 装到 dir/curl，返回它的路径（调用方把它前置进 PATH） */
export function installStubCurl(dir) {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "curl");
	writeFileSync(path, STUB_CURL_SOURCE, { mode: 0o755 });
	chmodSync(path, 0o755);
	return path;
}

export function resetStubLog(logPath) {
	rmSync(logPath, { force: true });
	rmSync(`${logPath}.payload`, { force: true });
}

/** 本次进程里对假 curl 的全部调用（按顺序） */
export function readStubCalls(logPath) {
	if (!existsSync(logPath)) return [];
	return readFileSync(logPath, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

export function readStubPayload(logPath) {
	return readFileSync(`${logPath}.payload`, "utf8");
}
