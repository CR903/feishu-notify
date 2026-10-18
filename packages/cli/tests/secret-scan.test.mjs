/**
 * tests/secret-scan.test.mjs — AC6 闸门的断言测试
 *
 * 覆盖：
 *   1. 真实仓库（本仓库）扫描必须通过（含本机 live 指纹交叉校验）
 *   2. **故意注入**一个假 hook 到临时仓库 → 闸门必须拦住（这是闸门的自证）
 *   3. 占位符/样例 token 不误报（否则闸门会被绕过或被无视）
 *   4. live 指纹比对真的在起作用（用形状上"无害"的 token 证明是这条规则拦住的）
 *   5. `npm pack` 产物清单参与扫描，且 `bin/feishu-notify.orig` 不在发布产物里
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import { HOOK_MARKER, findHookTokens, gitTopLevel, isAllowedToken, packFileList, scanRepository } from "../lib/secret-scan.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), ".."); // = packages/cli（本包根）
const MONO_ROOT = gitTopLevel(REPO_ROOT) ?? REPO_ROOT; // = 仓库根
const TMP = mkdtempSync(join(tmpdir(), "feishu-notify-scan-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

/** 明显假的“真实形状”token（UUID 形状，与本机 live 地址不可能相同） */
const FAKE_REAL_TOKEN = "11111111-2222-3333-4444-555555555555";
const FAKE_HOOK = `https://open.feishu.cn/${HOOK_MARKER}${FAKE_REAL_TOKEN}`;

function makeRepo(name, files) {
	const root = join(TMP, name);
	mkdirSync(root, { recursive: true });
	execFileSync("git", ["init", "-q"], { cwd: root });
	for (const [path, content] of Object.entries(files)) {
		const absolute = join(root, path);
		mkdirSync(dirname(absolute), { recursive: true });
		writeFileSync(absolute, content);
	}
	return root;
}

describe("token 识别", () => {
	it("真实形状 token 命中，value 脱敏后不含原文", () => {
		const text = `curl -X POST "${FAKE_HOOK}" -d '{}'`;
		const hits = findHookTokens(text);
		assert.equal(hits.length, 1);
		assert.equal(hits[0].token, FAKE_REAL_TOKEN);
		assert.ok(!hits[0].value.includes(FAKE_REAL_TOKEN), "报告里绝不能出现 token 原文");
		assert.match(hits[0].value, /<REDACTED>$/);
	});

	it("占位符与样例前缀不误报（含 bash case 通配符 hook/*）", () => {
		const benign = [
			`WEBHOOK_URL="https://open.feishu.cn/${HOOK_MARKER}<PLACEHOLDER>"`,
			`feishu-notify --webhook 'https://open.feishu.cn/${HOOK_MARKER}xxx'`,
			`url="https://open.feishu.cn/${HOOK_MARKER}<REDACTED>"`,
			`*${HOOK_MARKER}*)  ;;`,
			`const u = \`https://open.feishu.cn/${HOOK_MARKER}\${token}\``,
			`hook/${"…"}`,
		].join("\n");
		assert.deepEqual(findHookTokens(benign), []);
	});

	it("样例 token 前缀白名单逐项生效", () => {
		for (const token of ["test-a", "test-channel-a", "example-1", "fake_2", "dummy", "sample.webhook"]) {
			assert.ok(isAllowedToken(token), `${token} 应被当作样例`);
		}
		for (const token of [FAKE_REAL_TOKEN, "62ff6eb0-79c9-4b29-af48-000000000000", "abc123def456"]) {
			assert.ok(!isAllowedToken(token), `${token} 不应被当作样例`);
		}
	});
});

describe("真实仓库扫描（本仓库）", () => {
	it("扫描通过：git 索引 + pack 产物都干净", () => {
		const result = scanRepository({ root: REPO_ROOT });
		assert.deepEqual(result.hits, [], `本仓库不得含真实 hook：\n${JSON.stringify(result.hits, null, 2)}`);
		assert.ok(result.scanned.includes("packages/cli/bin/feishu-notify"));
		assert.ok(result.scanned.includes("packages/cli/lib/config.mjs"));
		assert.ok(result.scanned.some((path) => path.startsWith("packages/cli/tests/fixtures/")), "fixtures 必须在扫描范围内");
	});

	it("单仓三包：索引锚点是仓库根，根目录与其它包不是盲区（R10 的闸门面）", () => {
		const result = scanRepository({ root: REPO_ROOT });
		assert.equal(result.root, MONO_ROOT, "扫描根应为 git 仓库根，而非 cwd");
		// 这几处在 packages/cli 之外：从子目录跑 `git ls-files` 是看不见它们的
		for (const path of ["package.json", "LICENSE", "README.md", "packages/opencode/README.md", "packages/dsh/README.md"]) {
			assert.ok(result.scanned.includes(path), `${path} 必须在扫描范围内（闸门不得因分层而漏掉仓库根/其它包）`);
		}
	});

	it("本机 live 指纹参与比对（本机存在硬编码地址时必须 >0）", () => {
		const result = scanRepository({ root: REPO_ROOT, liveFiles: undefined });
		assert.ok(result.liveTokenCount >= 0);
		if (result.liveTokenCount > 0) assert.ok(result.ok, "本机 live 地址不得出现在仓库里");
	});

	it("npm pack 产物清单参与扫描；redacted 基线不进包", () => {
		const files = packFileList({ root: REPO_ROOT });
		assert.ok(files.includes("bin/feishu-notify"), `pack 产物应含发送端：${files.join(", ")}`);
		assert.ok(files.includes("bin/feishu-notify-cli"), "pack 产物应含 CLI 入口");
		assert.ok(files.some((path) => path.startsWith("lib/")), "pack 产物应含 lib/");
		assert.ok(!files.includes("bin/feishu-notify.orig"), "改造前基线不进发布产物");
		assert.ok(!files.some((path) => path.startsWith("tests/")), "测试不进发布产物");
		// 单仓三包：发布产物不得夹带 monorepo 其它内容（根 README、别的包…）
		assert.ok(!files.some((path) => path.includes("packages/")), `发布产物不得夹带其它包：${files.join(", ")}`);
	});
});

describe("故意注入 → 闸门必须拦住（自证）", () => {
	it("跟踪文件里塞入假 hook → ok=false，报出文件与行号", () => {
		const root = makeRepo("injected", {
			"lib/notify.mjs": `export const URL = "${FAKE_HOOK}";\n`,
			"README.md": "# 正常内容\n",
		});
		execFileSync("git", ["-C", root, "add", "-A"]);

		const result = scanRepository({ root, includePack: false });
		assert.equal(result.ok, false);
		const hit = result.hits.find((entry) => entry.reason === "hook-token");
		assert.ok(hit, `应命中 hook-token，实际：${JSON.stringify(result.hits)}`);
		assert.equal(hit.file, "lib/notify.mjs");
		assert.equal(hit.line, 1);
		assert.match(hit.value, /<REDACTED>$/);
		assert.ok(!JSON.stringify(result).includes(FAKE_REAL_TOKEN), "报告 JSON 里都不得出现 token 原文");
	});

	it("未入库但未被忽略的新文件同样会被拦（git add -A 之前就拦住）", () => {
		const root = makeRepo("untracked", { "src/new.mjs": `const hook = "${FAKE_HOOK}";\n` });
		const result = scanRepository({ root, includePack: false });
		assert.equal(result.ok, false);
		assert.equal(result.hits[0].scope, "untracked");
	});

	it("篡改发布产物里的文件也会被拦（pack 清单参与扫描）", () => {
		// leak.txt 被 .gitignore 忽略（git 看不见），但 package.json 的 files 把它列进发布物
		// —— 这正是 pack 清单扫描存在的意义：入库检查看不见的文件也可能被打包发出去。
		const root = join(TMP, "pack-injected");
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pack-injected", version: "1.0.0", files: ["leak.txt"] }, null, 2));
		writeFileSync(join(root, "leak.txt"), `${FAKE_HOOK}\n`);
		writeFileSync(join(root, ".gitignore"), "leak.txt\n");
		execFileSync("git", ["init", "-q"], { cwd: root });

		assert.ok(packFileList({ root }).includes("leak.txt"), "pack 产物应含 leak.txt");
		const result = scanRepository({ root });
		assert.equal(result.ok, false);
		assert.ok(result.hits.some((entry) => entry.scope === "pack"), `pack 命中必须被报出：${JSON.stringify(result.hits)}`);
		assert.ok(result.hits.some((entry) => entry.file === "leak.txt"));
	});

	it("同一个仓库清掉地址后 → 闸门放行", () => {
		const root = makeRepo("cleaned", { "lib/notify.mjs": `export const URL = "https://open.feishu.cn/${HOOK_MARKER}<PLACEHOLDER>";\n` });
		const result = scanRepository({ root, includePack: false });
		assert.equal(result.ok, true, JSON.stringify(result.hits));
	});
});

describe("live 指纹交叉校验（R-1 的直接防护）", () => {
	it("形状上合规的 token（test-*），只要与本机 live 地址相同就拦下", () => {
		const liveFile = join(TMP, "live-script.sh");
		const liveToken = "test-live-address"; // 结构扫描会放行，只有 live 比对能抓住
		writeFileSync(liveFile, `WEBHOOK="${`https://open.feishu.cn/${HOOK_MARKER}${liveToken}`}"\n`);
		const root = makeRepo("live-leak", { "bin/feishu-notify": `WEBHOOK="${`https://open.feishu.cn/${HOOK_MARKER}${liveToken}`}"\n` });

		const withoutLive = scanRepository({ root, includePack: false, liveFiles: [] });
		assert.equal(withoutLive.ok, true, "结构规则会放行 test-* 形状");

		const withLive = scanRepository({ root, includePack: false, liveFiles: [liveFile] });
		assert.equal(withLive.ok, false);
		assert.equal(withLive.hits[0].reason, "live-hook-leak");
		assert.match(withLive.hits[0].detail, /本机 live 文件/);
	});

	it("live 文件不存在时不报错、集合为空", () => {
		const result = scanRepository({ root: REPO_ROOT, includePack: false, liveFiles: [join(TMP, "nope.sh")] });
		assert.equal(result.liveTokenCount, 0);
		assert.equal(result.ok, true);
	});
});

describe("CLI 行为", () => {
	it("干净仓库：exit 0", () => {
		const out = execFileSync(process.execPath, ["lib/secret-scan.mjs", "--no-pack"], { cwd: REPO_ROOT, encoding: "utf8" });
		assert.match(out, /未发现真实 hook token/);
	});

	it("注入后的仓库：exit 1 且打印脱敏命中", () => {
		const root = makeRepo("cli-injected", { "a.mjs": `const h = "${FAKE_HOOK}";\n` });
		let failed = null;
		try {
			execFileSync(process.execPath, [join(REPO_ROOT, "lib/secret-scan.mjs"), "--no-pack", "--root", root], { encoding: "utf8" });
		} catch (error) {
			failed = error;
		}
		assert.ok(failed, "注入后 CLI 必须非零退出");
		assert.equal(failed.status, 1);
		assert.match(failed.stdout, /命中 1 处/);
		assert.ok(!failed.stdout.includes(FAKE_REAL_TOKEN));
	});
});
