/**
 * tests/live.test.mjs — 真实发送的联调测试（**默认跳过**）
 *
 * 为什么单独一个文件：其它测试用 PATH 前置的假 curl 跑，永远不联网（CI 安全）。
 * 这一组要真的打飞书接口，因此由 `FEISHU_NOTIFY_LIVE=1` 显式开启：
 *
 *   FEISHU_NOTIFY_LIVE=1 node --test tests/live.test.mjs
 *
 * 它读的是**本机真实配置**（~/.config/feishu-notify/config.json），会真实发出卡片 ——
 * 这是"改了配置解析之后本机通知还通不通"的最终证据。输出只打印掩码。
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { maskWebhook, readConfig, resolveWebhook } from "../lib/config.mjs";
import { sendTestCard } from "../lib/sender.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPO_ROOT, "bin", "feishu-notify-cli");
const LIVE = process.env.FEISHU_NOTIFY_LIVE === "1";
const SKIP_REASON = "未设置 FEISHU_NOTIFY_LIVE=1（CI 默认不发外网）";

describe("live 联调：真实配置 + 真实网络", () => {
	it("resolve 能给出本机配置里的地址，且真能发出去一张卡片", (t) => {
		if (!LIVE) return t.skip(SKIP_REASON);

		const loaded = readConfig();
		assert.equal(loaded.ok, true, `读不到本机配置（先跑 feishu-notify-cli init）：${loaded.message ?? ""}`);

		const resolved = resolveWebhook({});
		console.error(`  → 解析结果（掩码）：${maskWebhook(resolved.webhook)}  source=${resolved.source} channel=${resolved.channelName ?? "-"}`);
		assert.match(resolved.webhook, /^https:\/\//, "解析结果必须是 https 地址");

		const result = sendTestCard({ webhook: resolved.webhook, channelName: resolved.channelName ?? resolved.source });
		console.error(`  → 发送结果：${result.message}（${result.elapsedMs}ms）`);
		assert.equal(result.ok, true, `真实发送失败：${result.message}${result.body ? ` ${result.body}` : ""}`);
	});

	it("doctor 走真实网络：逐 channel 实测并给出退出码", (t) => {
		if (!LIVE) return t.skip(SKIP_REASON);

		const result = spawnSync(process.execPath, [CLI, "doctor"], { encoding: "utf8", env: { ...process.env } });
		console.error(result.stdout.trim());
		if (result.stderr.trim()) console.error(result.stderr.trim());

		assert.ok([0, 1].includes(result.status), `doctor 退出码应为 0（全通）或 1（有不重的）：${result.status}`);
		assert.match(result.stdout, /结论：\d+\/\d+ 通/);
		assert.ok(!/hook\/[A-Za-z0-9_-]{8,}/.test(result.stdout), "doctor 输出不得含明文 token");
	});
});
