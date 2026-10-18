/**
 * tests/fixtures.test.mjs — AC4 黄金样例的可重复性断言
 *
 * 1. 重新捕获一遍（stub curl），必须与提交的 fixtures 逐字节一致
 * 2. 提交的 fixtures 自身必须自洽：payload 是合法 JSON、时间戳已归一化、URL 全脱敏、5 组齐全
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { findHookTokens } from "../lib/secret-scan.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(REPO_ROOT, "tests", "fixtures");
const CASES = ["idle", "done", "title-file", "text", "bare"];

describe("AC4 黄金样例：改造前基线可重复生成", () => {
	it("sh tests/capture-fixtures.sh 与提交的 fixtures 逐字节一致", () => {
		const output = execFileSync("sh", [join("tests", "capture-fixtures.sh")], { cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env } });
		assert.match(output, /逐字节一致/);
		for (const name of CASES) assert.match(output, new RegExp(`${name}\\s+exit=0`), `${name} 应捕获成功且退出码 0`);
	});

	it("5 组 fixtures 齐全，payload 是合法 JSON 且时间戳已归一化", () => {
		const files = readdirSync(FIXTURES);
		for (const name of CASES) {
			assert.ok(files.includes(`${name}.payload.json`), `缺 fixture: ${name}.payload.json`);
			assert.ok(files.includes(`${name}.url.txt`), `缺 fixture: ${name}.url.txt`);
			assert.ok(files.includes(`${name}.stdout.txt`), `缺 fixture: ${name}.stdout.txt`);
			assert.ok(files.includes(`${name}.stderr.txt`), `缺 fixture: ${name}.stderr.txt`);

			const raw = readFileSync(join(FIXTURES, `${name}.payload.json`), "utf8");
			const payload = JSON.parse(raw); // 必须能解析
			assert.doesNotMatch(raw, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/, `${name}: 不得残留真实时间戳`);
			assert.doesNotMatch(raw, /hook\//, `${name}: payload 不该出现 hook 地址`);

			if (payload.msg_type === "text") {
				// text 模式没有 footer，本来就没有时间戳（这是改造前行为的一部分）
				assert.equal(name, "text");
				assert.equal(payload.content.text, "纯文本");
			} else {
				assert.ok(raw.includes("<TIMESTAMP>"), `${name}: 卡片模式必须含归一化时间戳`);
				assert.equal(payload.msg_type, "interactive");
			}
		}
	});

	it("退出码矩阵：5 组成功路径全部 exit 0 / http 200", () => {
		const summary = JSON.parse(readFileSync(join(FIXTURES, "exit-codes.json"), "utf8"));
		assert.deepEqual(Object.keys(summary.cases).sort(), [...CASES].sort());
		for (const [name, entry] of Object.entries(summary.cases)) {
			assert.equal(entry.exit, 0, `${name} 退出码`);
			assert.equal(entry.httpCode, 200, `${name} http 状态`);
			assert.match(entry.payloadSha256, /^[0-9a-f]{64}$/, `${name} payload 指纹`);
		}
	});

	it("fixtures 里没有任何真实 hook token（含 URL、stderr 与 JSON 汇总文件）", () => {
		for (const file of readdirSync(FIXTURES)) {
			const hits = findHookTokens(readFileSync(join(FIXTURES, file), "utf8"));
			assert.deepEqual(hits, [], `${file} 含疑似真实 hook：${JSON.stringify(hits)}`);
		}
	});

	it("Step 2 之后的捕获锚定在 env（source=env），不随本机配置漂移", () => {
		// 改造前脚本内置地址；改造后靠 feishu-notify-cli resolve。若 harness 忘了钉住解析输入，
		// 捕获会读本机 ~/.config/feishu-notify/config.json，fixtures 就会随机器变化 —— 这条锁住它。
		for (const name of CASES) {
			const stderr = readFileSync(join(FIXTURES, `${name}.stderr.txt`), "utf8");
			assert.match(stderr, /^source=env webhook=https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/<REDACTED>$/m, `${name}: 应走 env 解析`);
			assert.match(stderr, /stub-curl: got payload/, `${name}: 应记录 stub 收到的字节数`);
			assert.ok(!stderr.includes("source=activeChannel"), `${name}: 不得依赖本机 activeChannel`);
		}
	});

	it("footer 默认中性：4 组卡片 fixture 的 note 是 `feishu-notify · <TIMESTAMP>`（R9 的有意更新）", () => {
		// harness 把 FEISHU_NOTIFY_CONFIG 钉在"中性 footer"的固定配置上（见 capture-fixtures.sh），
		// 因此这里必须出现中性默认值。若哪天有人把它改回 Smarterlab（或忘了钉住），这条会失败。
		for (const name of ["idle", "done", "title-file", "bare"]) {
			const payload = JSON.parse(readFileSync(join(FIXTURES, `${name}.payload.json`), "utf8"));
			const note = payload.card.elements.find((element) => element.tag === "note");
			assert.equal(note.elements[0].content, "feishu-notify · <TIMESTAMP>", `${name}: footer 应为中性默认`);
			assert.ok(!JSON.stringify(payload).includes("Smarterlab"), `${name}: 不得把作者/公司标识烧进 fixture`);
		}
	});
});
