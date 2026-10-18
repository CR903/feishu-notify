/**
 * dsh-feishu-notify — DSH（DeepSeek Harness / Cordis）适配器
 *
 * 把 DSH 的生命周期事件映射成飞书卡片，**发送走内核 CLI**：
 *   `feishu-notify --source dsh --channel <channel> --title <标题> <正文>`
 * webhook 从哪来：本插件**不持有任何地址**。它只传 channel **名字**，地址由
 * `feishu-notify`（内核 CLI）从用户自己的配置（`~/.config/feishu-notify/config.json`）解析。
 * 这与 opencode 侧、Claude Code 侧共用同一份配置与同一个发送端（本包不自己发 HTTP）。
 *
 * 通知时机（三类；其余见 README 的能力表）
 *   session/event          → turn/end         →  ✅/❌/⏸/🚫/⚠️ 分档 + 错误详情 + 指标
 *   session/event          → approval/asked   →  🔔 需要你决定
 *   session/event          → tool/result      →  ❌ 工具失败（默认**关**，config.toolFailures 打开）
 *   user-questions/request →（阻塞 waterfall）→  ❓ 需要你回答 / 📋 计划待批
 *
 * 事件名与字段一律取实测的 `.d.ts`（DSH 0.2.0-rc.2，逐条 file:line 见
 * `.trellis/tasks/10-18-feishu-notify-dsh/research/cordis-plugin-api.md`）：
 *   session/event            $RT/dsh-session/lib/types/index.d.ts:64  (emit, (session, event))
 *   SessionEvent             $RT/dsh-session/lib/types/types.d.ts:489 ({type, seq, time, data})
 *   turn/end                 $RT/dsh-session/lib/types/types.d.ts:273 ({turn, reason})
 *   TurnEndReasonMap         $RT/dsh-session/lib/types/types.d.ts:165（**判别联合对象**，取 .kind）
 *   assistant/message.usage  $RT/dsh-session/lib/types/types.d.ts:330 (TokenUsage)
 *   approval/asked           $RT/dsh-user-approval/lib/types/types.d.ts:37（log-only，非阻塞）
 *   tool/result              $RT/dsh-session/lib/types/types.d.ts:374 ({turn, step, message, error?})
 *   user-questions/request   $RT/dsh-user-questions/lib/types/types.d.ts:145
 *                            waterfall(this: Scoped<Agent>, request, next) → Promise<AskUserQuestionAnswer>
 *   AskUserQuestionRequestEvent / AskUserQuestionItem  同文件 :118 / :32（**实测形状见下**）
 *
 * 故意不做的事（都有据可依，见 README）
 *   1. 不注册 `agent/turn-stopping` 当「结束」：它是乐观的，别的 listener 可以 `agent.steer()` 续命
 *      （research §8.2.5），会发出假「已完成」。
 *   2. 「等待人工回答 / 计划待批」走的是**阻塞 waterfall** `user-questions/request`，**不是**
 *      `session/event` 的某个成员。设计稿里写的 `session/event → user-question-reply` 是错的：
 *      那个名字属于 `MessageSourceMap`（$RT/dsh-user-questions/lib/types/types.d.ts:104，即
 *      `user/message.source.kind`），照它注册**永远收不到事件**，而且它的载荷只有
 *      `{kind, callId, outcome}`，没有 `questions[]`。
 *      实现见 `createUserQuestionHandler`：fire-and-forget（绝不 await 发送）+ **必须** `next()` 委派。
 *   3. 不读 `sessionStats`（llmMs/toolMs/ttft）：它只在 `dsh-web-app` bundle 里挂载
 *      （$RT/dsh-web-app/cordis.patch.yml:102-103），非 web profile 没有 → 不假定其存在。
 *   4. 不声明任何 `@deepseek-ai/dsh-*` peerDependencies：兼容性检查会把 dsh-* peer 逐个对运行时核验
 *      （$RT/dsh-app-boot/lib/types/plugin-compatibility.d.ts），rc 版本参与范围匹配 = 地雷。
 *      运行时全部 duck-type（`ctx.sessionTitle` / `ctx.sessionProjections` 都按可选用）。
 *   5. 不用 `ctx.shell`：web profile 里它可能压根没挂载（research §9），直接用 `node:child_process`。
 *
 * 失败处理（本项目反复踩的坑：静默失败）
 *   - 发送端每次发送**重新解析**（`FEISHU_NOTIFY_BIN` → `~/.local/bin/feishu-notify` → PATH → 放弃）。
 *     解析不到就**不 spawn**，并写一条 ERROR 级日志。
 *   - 一切失败（找不到发送端 / spawn 报错 / 非零退出 / 超时）**无条件记 ERROR**，不受任何 DEBUG 开关控制。
 *   - 两个事件处理器各一层 try/catch：通知失败绝不影响这一轮对话。
 *   - `user-questions/request` 是**阻塞 waterfall**：**必须**把 `next()` 的返回值原样返回
 *     （不调 `next()` = 否决整条链），同时**绝不 await 发送** —— 见 `createUserQuestionHandler`。
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import Schema from '@deepseek-ai/schemastery';

// ---------------------------------------------------------------- 插件元信息（Cordis 契约）

export const name = 'dsh-feishu-notify';

/**
 * 需要 Cordis 保证就绪的服务：**空**。
 *
 * 本插件所有数据入口都是 duck-type 可选的（标题 / 投影 / 各服务都可能不存在，
 * 缺了就省略卡片上那一段）。若在这里写 `['sessionTitle']` 之类，某个 profile 没挂
 * 那个服务时 fiber 会停在 PENDING —— 结果是**一张卡片都收不到**，比"少一行标题"糟得多。
 */
export const inject = [];

/** 插件配置：只有两个键。真正的 webhook/开关仍在内核 CLI 自己那份配置里（PRD R4）。 */
export const Config = Schema.object({
	/** 传给内核 CLI 的 `--channel <name>`（只是名字，不是地址） */
	channel: Schema.string().default('dsh'),
	/** 工具失败是否也推（默认关：一轮里可能有几十次） */
	toolFailures: Schema.boolean().default(false),
});

// ---------------------------------------------------------------- 常量

/** 默认 channel 名（`--channel` 的值；不是地址）。 */
export const DEFAULT_CHANNEL = 'dsh';
/** `--source`：卡片页脚里的「来源」，也是日志里区分调用方的标记。 */
export const NOTIFY_SOURCE = 'dsh';
/** 内核 CLI 的可执行文件名（在 PATH / ~/.local/bin 里找的就是它）。 */
export const NOTIFY_BIN = 'feishu-notify';
/** 显式指定发送端路径的 env（排障用；设了但不可执行时**报错**，不悄悄改用别的）。 */
export const NOTIFY_BIN_ENV = 'FEISHU_NOTIFY_BIN';
/** 发送超时：到点杀进程组（内核 CLI 是 bash 脚本，会再拉起 node，只杀直接子进程会留孤儿）。 */
export const NOTIFY_TIMEOUT_MS = 10_000;
/** 卡片正文上限（与 opencode 侧同口径）。 */
export const MSG_MAX_LEN = 2000;
/** 卡片标题里会话名的截断长度（DSH 用首条用户消息当标题，动辄上百字）。 */
export const TITLE_MAX = 40;

/** `reason.kind` 的五档（`$RT/dsh-session/lib/types/types.d.ts:165` 的 TurnEndReasonMap）。 */
const TURN_END_TITLES = {
	completed: '✅ 任务完成',
	error: '❌ 任务失败',
	aborted: '⏸ 任务已中断',
	blocked: '🚫 任务被拦下',
	'max-tokens': '⚠️ 已达 token 上限',
};
/** 认不出的 `reason.kind`（TurnEndReasonMap 可被别的插件合并扩展）一律落这一档，不崩。 */
export const UNKNOWN_TURN_END_TITLE = '❓ 未知状态';

/** 「需要你回答」卡片的标题前缀（`user-questions/request`）。 */
export const QUESTION_TITLE = '❓ 需要你回答';
/**
 * 其中一问带 `intent.kind === 'plan-review'` 时的标题前缀。
 *
 * 计划待批**仍然是**「需要你回答」，所以保留原前缀、再追加标记 —— 只看标题也分辨得出来。
 * `intent` 的形状见 `$RT/dsh-user-questions/lib/types/types.d.ts:19-30`：
 * `{ kind: 'plan-review', approve: string, callId?: ToolCallId }`，其中 `approve` 是
 * **批准选项的 label**（上游刻意用名字而不是位置，见该文件注释）。
 */
export const PLAN_REVIEW_TITLE = '❓ 需要你回答 · 计划待批';
/** 卡片上最多列几个问题（一轮 `ask_user_question` 通常 1~4 个；超出只报数量，避免长卡片）。 */
export const QUESTION_MAX_ITEMS = 5;
/** 单个 `detail` 在卡片上的截断长度（plan-review 的 `detail` 是整篇计划 markdown）。 */
export const QUESTION_DETAIL_MAX = 200;

// ---------------------------------------------------------------- 小工具

/** 能当对象用的才当对象：事件载荷是外部输入，别信它的形状。 */
function asObject(value) {
	return value !== null && typeof value === 'object' ? value : null;
}

function asNonEmptyString(value) {
	return typeof value === 'string' && value.trim() !== '' ? value.trim() : '';
}

/** 非空行才留下（缺数据就省略那一段，不写占位符） */
export function joinLines(lines) {
	return (Array.isArray(lines) ? lines : [])
		.filter((line) => typeof line === 'string' && line.length > 0)
		.join('\n');
}

function shorten(text) {
	const value = asNonEmptyString(text);
	if (value === '') return '';
	return value.length > TITLE_MAX ? `${value.slice(0, TITLE_MAX)}…` : value;
}

/** 折成一行并截断（卡片正文里的 `detail` 可能是整篇 markdown，含换行）。 */
function flatten(text, max) {
	const value = asNonEmptyString(text).replace(/\s+/g, ' ');
	if (value === '') return '';
	return value.length > max ? `${value.slice(0, max)}…` : value;
}

function fmtTok(n) {
	return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));
}

function fmtDur(ms) {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	return `${Math.floor(s / 60)}m${s % 60}s`;
}

// ---------------------------------------------------------------- 纯函数：一轮结束的分档

/**
 * `turn/end` 的载荷 → `{ kind, title, body }`。
 *
 * **坑**（实测，research §8.2.4）：`data.reason` 是**判别联合对象**，不是字符串；
 * 分档要看 `reason.kind`。即使真有人塞了字符串 `reason: 'completed'`，这里也只当
 * 「没给 kind」处理（落未知档），不猜、不崩。
 *
 * `kind` 归一成五档之一，或 `'unknown'`；未知档把原始 kind 原文写进 `body`（不吞信息）。
 *
 * @param data `turn/end` 事件 data：`{ turn, reason: TurnEndReason }`
 */
export function classifyTurnEnd(data) {
	const reason = asObject(asObject(data)?.reason);
	const rawKind = asNonEmptyString(reason?.kind);
	const known = rawKind !== '' && Object.prototype.hasOwnProperty.call(TURN_END_TITLES, rawKind);
	return {
		kind: known ? rawKind : 'unknown',
		title: known ? TURN_END_TITLES[rawKind] : UNKNOWN_TURN_END_TITLE,
		body: turnEndBody({ kind: known ? rawKind : 'unknown', reason, rawKind }),
	};
}

function turnEndBody({ kind, reason, rawKind }) {
	if (kind === 'error') {
		const failure = asObject(reason?.error);
		const message = asNonEmptyString(failure?.message);
		const code = asNonEmptyString(failure?.code);
		const status = typeof failure?.status === 'number' ? failure.status : null;
		return joinLines([
			message ? `**错误**: ${message}` : '**错误**: （未提供错误详情）',
			code ? `**类型**: \`${code}\`${status === null ? '' : `（HTTP ${status}）`}` : status === null ? '' : `**状态码**: ${status}`,
		]);
	}
	if (kind === 'aborted') {
		// TurnEndCancelCause 也是判别联合对象（'user' / 'parent' / 'hook'{reason} / 'disposed' / 'legacy'）
		const cause = reason?.reason;
		const causeKind = asNonEmptyString(asObject(cause)?.kind) || asNonEmptyString(cause);
		const hookReason = asNonEmptyString(asObject(cause)?.reason);
		return joinLines([
			`**原因**: ${causeKind === '' ? '（未提供）' : causeKind}`,
			hookReason ? `**说明**: ${hookReason}` : '',
		]);
	}
	if (kind === 'unknown') {
		return `**状态**: ${rawKind === '' ? '`（事件没给 reason.kind）`' : `\`${rawKind}\``}`;
	}
	// completed / blocked / max-tokens：标题已经说清了，不硬凑正文
	return '';
}

// ---------------------------------------------------------------- 纯函数：需要你回答 / 计划待批

/**
 * `user-questions/request` 的载荷 → `{ kind, title, body, questionCount, planReviewCount }`。
 *
 * **实测形状**（`$RT/dsh-user-questions/lib/types/types.d.ts`，DSH 0.2.0-rc.2）：
 * ```ts
 * interface AskUserQuestionRequestEvent {            // :118
 *   questions: AskUserQuestionItem[];                // :120
 *   agent?: Agent; signal?: AbortSignal;
 *   wait?: { callId: ToolCallId; timed?: boolean };  // :129-134
 * }
 * interface AskUserQuestionItem {                    // :32
 *   id: string; question: string;                    // :34/:36
 *   detail?: string; header?: string;                // :38/:40
 *   options?: { label: string; description?: string }[];
 *   multiSelect?: boolean;
 *   intent?: { kind: 'plan-review'; approve: string; callId?: ToolCallId };  // :19-30
 * }
 * ```
 * 与 research 的描述一致（它写的是「`questions[]`（含 `question`/`options`/`intent`）、`agent?`、`wait?`」）；
 * 唯一 research 没写、而 `.d.ts` 有的是 **`wait` 里的 `timed?: boolean`** 与 **`intent.approve`**
 * （批准选项的 label）—— 卡片把 `approve` 打出来，用户看得懂"哪个按钮算批准"。
 *
 * 认不出的 `intent.kind`（上游可继续加）一律当普通问题，不崩。
 *
 * @param request `AskUserQuestionRequestEvent`
 */
export function classifyUserQuestions(request) {
	const rawQuestions = asObject(request)?.questions;
	const questions = (Array.isArray(rawQuestions) ? rawQuestions : []).map((item) => asObject(item)).filter((item) => item !== null);
	const planReviews = questions.filter((question) => asNonEmptyString(asObject(question.intent)?.kind) === 'plan-review');
	const kind = planReviews.length > 0 ? 'plan-review' : 'question';
	return {
		kind,
		title: kind === 'plan-review' ? PLAN_REVIEW_TITLE : QUESTION_TITLE,
		body: userQuestionsBody({ questions, planReviews }),
		questionCount: questions.length,
		planReviewCount: planReviews.length,
	};
}

function userQuestionsBody({ questions, planReviews }) {
	const lines = [];

	if (planReviews.length > 0) {
		const approve = asNonEmptyString(asObject(planReviews[0].intent)?.approve);
		lines.push(`📋 **计划待批**${approve === '' ? '' : `（批准项：\`${approve}\`）`}`);
	}

	const shown = questions.slice(0, QUESTION_MAX_ITEMS);
	shown.forEach((question, index) => {
		const header = asNonEmptyString(question.header);
		const text = asNonEmptyString(question.question);
		lines.push(`**${header === '' ? `问题 ${index + 1}` : header}**: ${text === '' ? '（未提供问题文本）' : text}`);

		const detail = flatten(question.detail, QUESTION_DETAIL_MAX);
		if (detail !== '') lines.push(detail);

		const labels = (Array.isArray(question.options) ? question.options : [])
			.map((option) => asNonEmptyString(asObject(option)?.label))
			.filter((label) => label !== '');
		if (labels.length > 0) {
			lines.push(`${question.multiSelect === true ? '选项（可多选）' : '选项'}: ${labels.map((label) => `\`${label}\``).join(' / ')}`);
		}
	});

	if (questions.length > shown.length) {
		lines.push(`… 另有 ${questions.length - shown.length} 个问题（共 ${questions.length} 个）`);
	}
	if (lines.length === 0) {
		// 正文不能为空：内核 CLI 对空正文会打用法并 exit 1
		lines.push('（事件没带 questions[]）');
	}
	return joinLines(lines);
}

// ---------------------------------------------------------------- 纯函数：指标排版

/**
 * 模型标识：`provider/model`（缺一个就用另一个，都没有就空串 → 卡片上省略这段）。
 *
 * 来源 `session.requestContext()`（`$RT/dsh-session/lib/types/types.d.ts:230` 的 RequestContext），
 * 而不是 `agent.options` —— 事件里只有 session，而 requestContext 是同步可取的。
 */
export function modelLabel(requestContext) {
	const ctx = asObject(requestContext);
	const provider = asNonEmptyString(ctx?.provider);
	const model = asNonEmptyString(ctx?.model);
	if (provider !== '' && model !== '') return `${provider}/${model}`;
	return model || provider || '';
}

/**
 * 把一轮里各步的 `TokenUsage` 累加成一个数（缺字段不加、不补零）。
 *
 * `assistant/message.usage` 是**单步**用量（`$RT/dsh-session/lib/types/types.d.ts:330`）；
 * 单轮 = 该轮各步之和。`reasoningTokens` 按上游注释已含在 `outputTokens` 里
 * （`$RT/dsh-token-meter/lib/types/usage-projection.d.ts` 顶部注释），**不要再加一遍**。
 *
 * @returns 一个 `TokenUsage` 形状的对象；一步都没报过用量时 `undefined`（调用方据此省略该段）
 */
export function foldUsages(usages) {
	const list = Array.isArray(usages) ? usages : [];
	const keys = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'];
	const sums = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
	const seen = new Set();
	for (const usage of list) {
		const item = asObject(usage);
		if (item === null) continue;
		for (const key of keys) {
			if (typeof item[key] === 'number' && Number.isFinite(item[key])) {
				sums[key] += item[key];
				seen.add(key);
			}
		}
	}
	if (seen.size === 0) return undefined;
	const folded = {};
	for (const key of keys) {
		if (seen.has(key)) folded[key] = sums[key];
	}
	return folded;
}

/**
 * 指标行（模型单独一行加粗，其余在第二行）。
 *
 * **缺哪项就省略哪段，不造数**：没拿到模型就不写模型行，没 token 就不写 token，
 * 没耗时就不写耗时；三项都没有 → 返回 `''`（调用方整段不拼）。
 *
 * 刻意**没有 TPS**：opencode 侧能算 tok/s 是因为它累加了 step 的生成窗口；
 * DSH 侧拿到的耗时是整轮墙钟（含工具等待），用它除 token 数会得到一个没有意义的数
 * —— 宁可没有，也不编一个。
 *
 * @param p.model 模型标识（来自 `modelLabel`）
 * @param p.tokens 本轮折叠后的用量（来自 `foldUsages`），可缺
 * @param p.durationMs 整轮墙钟耗时（`turn/start.time` → `turn/end.time`），可缺
 */
export function formatMetrics({ model, tokens, durationMs } = {}) {
	const head = [];
	const sub = [];

	const label = asNonEmptyString(model);
	if (label !== '') head.push(`**🤖 ${label}**`);

	const usage = asObject(tokens);
	const out = typeof usage?.outputTokens === 'number' && Number.isFinite(usage.outputTokens) ? usage.outputTokens : null;
	if (out !== null && out > 0) sub.push(`输出 ${fmtTok(out)} tok`);
	const cacheRead = typeof usage?.cacheReadTokens === 'number' && Number.isFinite(usage.cacheReadTokens) ? usage.cacheReadTokens : null;
	if (cacheRead !== null && cacheRead > 0) sub.push(`缓存读 ${fmtTok(cacheRead)} tok`);

	if (typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs > 0) {
		sub.push(`耗时 ${fmtDur(durationMs)}`);
	}

	return joinLines([head.join(''), sub.join(' · ')]);
}

/**
 * 本 session 的累计用量（`ctx.sessionProjections.stateOf(session, 'tokenUsage').totals`，
 * 见 `$RT/dsh-token-meter/lib/types/usage-projection.d.ts`）。
 *
 * **可能整个不存在**：`tokenUsage` 投影由 `dsh-token-meter` 提供，非 web profile 下不保证挂载
 * → 拿不到就返回 `''`（这段整段省略，不造数）。
 */
export function formatCumulativeTotals(totals) {
	const value = asObject(totals);
	const out = typeof value?.outputTokens === 'number' && Number.isFinite(value.outputTokens) ? value.outputTokens : null;
	if (out === null || out <= 0) return '';
	return `本会话累计 ${fmtTok(out)} tok`;
}

// ---------------------------------------------------------------- 发送端定位（G1 的教训）

/** 可执行文件探测：是普通文件（跟随符号链接）+ 有 x 位。 */
export function isExecutableFile(path, { stat = statSync, access = accessSync } = {}) {
	try {
		if (!stat(path).isFile()) return false;
		access(path, fsConstants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * 发送端路径的解析顺序（**不缓存**：发通知是低频操作，几次 stat 的代价远小于
 * 「刚 `npm i -g` 完却因为缓存还指向旧路径」这种排查成本 —— opencode 侧踩过）：
 *
 *   1. `FEISHU_NOTIFY_BIN`（显式指定；设了但不可执行 → **报错**，不悄悄改用别的）
 *   2. `~/.local/bin/feishu-notify`（可执行才算）
 *   3. PATH 里的 `feishu-notify`（nvm / Homebrew / pnpm 的全局 bin 目录各不一样）
 *   4. 都没有 → `path: null`，调用方**不得 spawn**
 */
export function resolveNotifyBin({ env = process.env, isExecutable = isExecutableFile } = {}) {
	const candidates = [];
	const explicit = asNonEmptyString(env?.[NOTIFY_BIN_ENV]);

	if (explicit !== '') {
		const ok = isExecutable(explicit);
		candidates.push({
			source: 'env',
			path: explicit,
			ok,
			detail: ok ? `${NOTIFY_BIN_ENV} 指定` : `${NOTIFY_BIN_ENV} 指向的文件不存在或不可执行`,
		});
		return ok
			? { path: explicit, source: 'env', reason: 'env', candidates }
			: { path: null, source: null, reason: 'env-invalid', candidates };
	}

	const home = asNonEmptyString(env?.HOME) || homedir();
	const homeBin = join(home, '.local', 'bin', NOTIFY_BIN);
	const homeOk = isExecutable(homeBin);
	candidates.push({
		source: 'home',
		path: homeBin,
		ok: homeOk,
		detail: homeOk ? '默认位置' : '不存在或不可执行（全局 bin 目录不一定在这里）',
	});
	if (homeOk) return { path: homeBin, source: 'home', reason: 'home', candidates };

	const dirs = String(env?.PATH ?? '')
		.split(process.platform === 'win32' ? ';' : ':')
		.map((dir) => dir.trim())
		.filter(Boolean);
	for (const dir of dirs) {
		const candidate = join(dir, NOTIFY_BIN);
		if (isExecutable(candidate)) {
			candidates.push({ source: 'path', path: candidate, ok: true, detail: 'PATH 命中' });
			return { path: candidate, source: 'path', reason: 'path', candidates };
		}
	}

	candidates.push({
		source: 'path',
		path: NOTIFY_BIN,
		ok: false,
		detail: `PATH 的 ${dirs.length} 个目录里都没有可执行的 ${NOTIFY_BIN}`,
	});
	return { path: null, source: null, reason: 'not-found', candidates };
}

/** 把解析失败翻译成「下一步该干什么」，供 ERROR 日志用。 */
export function describeBinFailure(resolution) {
	if (resolution?.reason === 'env-invalid') {
		const first = resolution.candidates?.[0];
		return (
			`找不到发送端：${NOTIFY_BIN_ENV}=${first?.path ?? '<空>'} 不存在或不可执行。` +
			`显式指定不会被忽略（否则会出现「改了设置却没效果」），请修正它或删掉这个 env`
		);
	}
	const searched = (resolution?.candidates ?? [])
		.map((candidate) => `${candidate.path}（${candidate.detail}）`)
		.join('；');
	return `找不到发送端 ${NOTIFY_BIN}。已找：${searched}。先安装内核 CLI（npm i -g feishu-notify-cli），或用 ${NOTIFY_BIN_ENV} 指定路径`;
}

/**
 * 组装发送端 argv（**纯函数**，可单测）。
 *
 * 正文走**位置参数**（内核 CLI 的用法示例就是 `feishu-notify --title 'T' <正文>`），
 * 不落临时文件：`spawn` 是异步的，写文件再在 `finally` 里删会与子进程读文件赛跑。
 * 参数是数组、`shell: false`，换行/引号都原样传过去（不经 shell）。
 */
export function buildNotifyArgv({ channel = DEFAULT_CHANNEL, title = '', body = '', source = NOTIFY_SOURCE } = {}) {
	const argv = ['--source', String(source), '--channel', String(channel), '--title', String(title)];
	const text = typeof body === 'string' ? body.slice(0, MSG_MAX_LEN) : '';
	if (text !== '') argv.push(text);
	return argv;
}

// ---------------------------------------------------------------- 日志（无条件）

/**
 * ERROR 级日志：**无条件写**，不受任何 DEBUG 开关控制。
 *
 * 「通知发不出去」正是本项目反复踩的静默失败（R11 的悬空链接、opencode 侧写死 bin 路径
 * 都是同一类）。退出 DSH 自己的 logger 里，排障第一步 grep 得到。
 */
export function logError(ctx, message) {
	const text = `${name}: ${message}`;
	try {
		const logger = ctx?.logger;
		if (logger !== null && typeof logger === 'object' && typeof logger.error === 'function') {
			logger.error(text);
			return;
		}
	} catch {
		// logger 自己坏了：退到 stderr
	}
	try {
		console.error(`[${name}] ${message}`);
	} catch {
		// 连 stderr 都没有（极罕见）：放弃，但绝不影响这一轮对话
	}
}

// ---------------------------------------------------------------- 卡片标题 / 正文（两个处理器共用）

/** `前缀 · 会话名`；没有会话名就只留前缀（不写占位符）。 */
function cardTitle(prefix, title) {
	const suffix = shorten(title);
	return suffix === '' ? prefix : `${prefix} · ${suffix}`;
}

/** 目录行；拿不到 cwd 就返回空串（调用方按空行过滤掉）。 */
function cwdLine(session) {
	const cwd = sessionCwd(session);
	return cwd === '' ? '' : `**目录**: \`${cwd}\``;
}

/**
 * `user-questions/request` 的载荷里没有 session，只有 `agent`（:122）→ 从 `agent.session` 取。
 * 全部 duck-type：`agent` / `session` 缺失或形状不对都当没有。
 */
function agentSession(request) {
	try {
		return asObject(asObject(request)?.agent)?.session;
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------- 发送（spawn，fire-and-forget）

/**
 * 造一个发送函数 `(argv) => void`：**永不抛、永不 await**（事件是 emit 模式，不能阻塞）。
 *
 * 超时用 SIGTERM 杀**进程组**：内核 `feishu-notify` 是 bash 脚本，里面还会拉起 node
 * （`feishu-notify-cli resolve`）。只杀直接子进程会留下持锁的孤儿 —— 见
 * `.trellis/spec/opencode-plugin/subprocess-supervision.md`。
 *
 * @param p.spawn 可注入（测试据此断言「真的没 spawn」或「spawn 的是解析出的那个路径」）
 * @param p.onError 失败通道（无条件 ERROR 日志）
 */
export function createSender({ spawn = nodeSpawn, env = process.env, isExecutable = isExecutableFile, onError = () => {}, timeoutMs = NOTIFY_TIMEOUT_MS } = {}) {
	return function send(argv) {
		const bin = resolveNotifyBin({ env, isExecutable });
		if (!bin.path) {
			onError(`${describeBinFailure(bin)}（本次通知未发送）`);
			return { ok: false, status: -1, reason: 'no-bin' };
		}

		let child;
		try {
			child = spawn(bin.path, argv, {
				// stdin 必须是 ignore：内核脚本 `[ ! -t 0 ]` 时会 `cat -` 读 stdin，
				// 给 pipe 又不写数据就会一直挂到超时。
				stdio: ['ignore', 'pipe', 'pipe'],
				shell: false,
				windowsHide: true,
				// 自成进程组，超时才能连 node 子进程一起收掉
				detached: process.platform !== 'win32',
			});
		} catch (error) {
			onError(`spawn 发送端失败（${bin.path}）：${String(error)}`);
			return { ok: false, status: -1, reason: 'spawn-failed' };
		}

		const stderrChunks = [];
		let settled = false;
		let timer = null;

		const finish = (result) => {
			if (settled) return result;
			settled = true;
			if (timer !== null) clearTimeout(timer);
			return result;
		};
		const killTree = () => {
			try {
				if (process.platform !== 'win32' && typeof child.pid === 'number') {
					process.kill(-child.pid, 'SIGTERM'); // 负号 = 整个进程组
					return;
				}
			} catch {
				// 进程组已经没了：下面退到只杀直接子进程
			}
			try {
				child.kill('SIGTERM');
			} catch {
				// 已经退出了
			}
		};

		timer = setTimeout(() => {
			if (settled) return;
			finish({ ok: false, status: -1, reason: 'timeout' });
			onError(`发送端超时（${timeoutMs}ms）已终止：${bin.path} ${argv.join(' ').slice(0, 160)}`);
			// 进程组一起收：只杀直接子进程会把内核脚本拉起的 node 留成孤儿
			killTree();
		}, timeoutMs);
		timer.unref?.();

		child.stderr?.on?.('data', (chunk) => {
			if (stderrChunks.length < 20) stderrChunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
		});
		// 子进程的流报错不能变成未处理异常（那会打断这一轮对话）
		child.stderr?.on?.('error', () => {});
		child.on?.('error', (error) => {
			const result = finish({ ok: false, status: -1, reason: 'child-error' });
			if (result.reason !== 'timeout') onError(`发送端起不来（${bin.path}）：${String(error)}`);
		});
		child.on?.('close', (code) => {
			const status = typeof code === 'number' ? code : -1;
			const result = finish({ ok: status === 0, status, reason: status === 0 ? 'sent' : 'exit-nonzero' });
			if (!result.ok && result.reason !== 'timeout') {
				const detail = stderrChunks.join('').trim().split('\n')[0]?.slice(0, 300) ?? '';
				onError(`发送失败（exit=${status}）：${bin.path} ${argv.join(' ').slice(0, 160)} -> ${detail}`);
			}
		});

		// fire-and-forget：这里只能表示「已经交给子进程了」，成败经 onError 才可见
		return { status: null, reason: 'pending', child };
	};
}

/**
 * 两个事件处理器共用的「卡片通道」：归一配置 + 一个永不抛的 `sendCard`。
 *
 * `sendCard` 同步发起发送（fire-and-forget），**永不抛、永不 await** —— 它是
 * `session/event`（emit）与 `user-questions/request`（阻塞 waterfall）两条路上的公共出口，
 * 后者的硬约束就是「绝不让外部进程的往返变成别人的延迟」。
 */
function createCardChannel({ ctx = {}, config = undefined, send = undefined, senderOptions = undefined } = {}) {
	const cfg = normalizeConfig(config);
	const sender =
		typeof send === 'function'
			? send
			: createSender({ ...(asObject(senderOptions) ?? {}), onError: (message) => logError(ctx, message) });

	function fire(argv) {
		try {
			const result = sender(argv);
			if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
				result.catch((error) => logError(ctx, `发送端 promise 被拒：${String(error)}`));
			}
		} catch (error) {
			logError(ctx, `发送端抛异常：${String(error)}`);
		}
	}

	/** 组标题 + 正文并投递；正文永不为空（内核 CLI 对空正文会打用法并 exit 1）。 */
	function sendCard(session, prefix, detailLines) {
		const title = cardTitle(prefix, safeSessionTitle(ctx, session));
		const body = joinLines(detailLines) || '（没有更多细节）';
		fire(buildNotifyArgv({ channel: cfg.channel, title, body }));
	}

	return { cfg, sendCard };
}

// ---------------------------------------------------------------- 事件处理

function normalizeConfig(config) {
	const source = asObject(config) ?? {};
	const channel = asNonEmptyString(source.channel);
	return {
		channel: channel === '' ? DEFAULT_CHANNEL : channel,
		toolFailures: source.toolFailures === true,
	};
}

function safeSessionTitle(ctx, session) {
	try {
		const snapshot = ctx?.sessionTitle?.get?.(session);
		return asNonEmptyString(snapshot?.title);
	} catch {
		return ''; // 标题拿不到就不写（不造数）
	}
}

function safeRequestContext(session) {
	try {
		return typeof session?.requestContext === 'function' ? session.requestContext() : undefined;
	} catch {
		return undefined;
	}
}

function safeCumulativeTotals(ctx, session) {
	try {
		const state = ctx?.sessionProjections?.stateOf?.(session, 'tokenUsage');
		return asObject(state)?.totals;
	} catch {
		return undefined; // 投影可能压根没挂载（非 web profile）
	}
}

function sessionCwd(session) {
	try {
		return asNonEmptyString(session?.header?.cwd) || asNonEmptyString(session?.cwd);
	} catch {
		return '';
	}
}

function sessionId(session) {
	try {
		return asNonEmptyString(session?.id) || asNonEmptyString(session?.header?.id);
	} catch {
		return '';
	}
}

/**
 * 造一个 `(session, event) => void` 处理器（也就是注册给 `session/event` 的那个 listener）。
 *
 * 单个 try/catch 包住整体：**通知失败绝不能影响这一轮对话**。
 * listener 本身是同步的（`session/event` 是 emit 模式，不等 promise）——发送是 fire-and-forget。
 *
 * @param p.send 可注入的发送函数 `(argv) => void`（测试据此断言 argv）
 */
export function createSessionHandler({ ctx = {}, config = undefined, send = undefined, now = () => Date.now(), senderOptions = undefined } = {}) {
	const { cfg, sendCard } = createCardChannel({ ctx, config, send, senderOptions });

	// sessionId → { turn, startTime, usages[] }：算耗时与单轮 token 用，turn/end 时清掉
	const turns = new Map();
	// sessionId → Map<callId, name>：tool/result 只有 callId，工具名在 tool/call 里
	const toolCalls = new Map();

	// ---------------- 一轮结束

	function onTurnStart(session, event) {
		const id = sessionId(session);
		if (id === '') return;
		turns.set(id, {
			turn: asObject(event?.data)?.turn,
			startTime: typeof event?.time === 'number' ? event.time : now(),
			usages: [],
		});
	}

	function onAssistantMessage(session, event) {
		const id = sessionId(session);
		if (id === '') return;
		const turn = turns.get(id);
		if (!turn) return;
		const data = asObject(event?.data);
		if (data === null || data.usage === undefined) return;
		// 只认落在本轮的消息：跨轮的迟到事件不该把用量算到这一轮头上
		if (typeof turn.turn === 'number' && typeof data.turn === 'number' && data.turn !== turn.turn) return;
		turn.usages.push(data.usage);
	}

	function onTurnEnd(session, event) {
		const id = sessionId(session);
		const turn = id === '' ? undefined : turns.get(id);
		if (id !== '') {
			turns.delete(id);
			toolCalls.delete(id);
		}

		const classified = classifyTurnEnd(event?.data);
		const startedAt = typeof turn?.startTime === 'number' ? turn.startTime : null;
		const endedAt = typeof event?.time === 'number' ? event.time : null;
		const durationMs = startedAt !== null && endedAt !== null ? endedAt - startedAt : undefined;

		sendCard(session, classified.title, [
			classified.body,
			cwdLine(session),
			'',
			formatMetrics({
				model: modelLabel(safeRequestContext(session)),
				tokens: foldUsages(turn?.usages),
				durationMs,
			}),
			formatCumulativeTotals(safeCumulativeTotals(ctx, session)),
		]);
	}

	// ---------------- 需要你决定（审批）

	function onApprovalAsked(session, event) {
		const data = asObject(event?.data) ?? {};
		sendCard(session, '🔔 需要你决定', [
			`**工具**: \`${asNonEmptyString(data.toolName) || '（未提供）'}\``,
			asNonEmptyString(data.reason) ? `**说明**: ${asNonEmptyString(data.reason)}` : '',
			cwdLine(session),
		]);
	}

	// ---------------- 工具失败（默认关）

	function onToolCall(session, event) {
		if (!cfg.toolFailures) return;
		const id = sessionId(session);
		const data = asObject(event?.data);
		const callId = asNonEmptyString(data?.callId);
		if (id === '' || callId === '') return;
		let calls = toolCalls.get(id);
		if (!calls) {
			calls = new Map();
			toolCalls.set(id, calls);
		}
		if (calls.size > 200) calls.clear(); // 兜底：turn/end 之前别无限涨
		calls.set(callId, asNonEmptyString(data?.name));
	}

	function onToolResult(session, event) {
		if (!cfg.toolFailures) return;
		const data = asObject(event?.data) ?? {};
		const message = asObject(data.message) ?? {};
		const failure = asObject(data.error);
		if (message.isError !== true && failure === null) return;

		const id = sessionId(session);
		const callId = asNonEmptyString(message.toolCallId);
		let name = '';
		if (id !== '' && callId !== '') {
			const calls = toolCalls.get(id);
			name = calls?.get(callId) ?? '';
			calls?.delete(callId);
		}
		sendCard(session, '❌ 工具失败', [
			name !== '' ? `**工具**: \`${name}\`` : '',
			asNonEmptyString(failure?.name) ? `**错误**: \`${asNonEmptyString(failure.name)}\`${asNonEmptyString(failure.code) ? `（${asNonEmptyString(failure.code)}）` : ''}` : '',
			asNonEmptyString(failure?.reason) ? `**说明**: ${asNonEmptyString(failure.reason)}` : '',
			cwdLine(session),
		]);
	}

	// ---------------- 分发

	return function handle(session, event) {
		try {
			const type = asNonEmptyString(event?.type);
			switch (type) {
				case 'turn/start':
					onTurnStart(session, event);
					break;
				case 'assistant/message':
					onAssistantMessage(session, event);
					break;
				case 'turn/end':
					onTurnEnd(session, event);
					break;
				case 'approval/asked':
					onApprovalAsked(session, event);
					break;
				case 'tool/call':
					onToolCall(session, event);
					break;
				case 'tool/result':
					onToolResult(session, event);
					break;
				default:
					break;
			}
		} catch (error) {
			// 通知失败绝不影响这一轮对话；但也不能静默（否则"没通知"永远查不出来）
			logError(ctx, `session/event 处理失败（type=${String(event?.type)}）：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
		}
	};
}

// ---------------------------------------------------------------- 需要你回答 / 计划待批（阻塞 waterfall）

/**
 * 造一个 `(request, next) => Promise<…>` 处理器，注册给 **waterfall** `user-questions/request`
 * （`$RT/dsh-user-questions/lib/types/types.d.ts:145`）。
 *
 * 两件事，顺序固定：
 *
 * 1. **fire-and-forget 投递**：`sendCard` 同步发起 `spawn`，**绝不 await**。
 *    这是 waterfall 阻塞点：在这里 `await` 一次外部进程往返（还可能撞上 10s 超时）就等于
 *    给「用户看到问题弹窗」和「模型拿到答案」加上我们的网络延迟。通知插件没有这个资格。
 * 2. **透明委派 `next()`**：cordis 的 waterfall 里 **不调 `next()` = 否决整条链**
 *    （`$RT/cordis/lib/index.js:317-331`：*"a listener that does not call `next()` vetoes the rest
 *    of the chain, including the built-in behavior"*）。`ask()` 会 `await` 这条链的结果
 *    （`$RT/dsh-user-questions/lib/index.js:681`）—— 所以**必须**把 `next()` 的 promise 原样返回，
 *    否则真正的答题 UI 再也拿不到这个问题，模型会收到一个 `undefined`「答案」。
 *
 * 于是「不阻塞」的准确含义是：**不 await 发送**；而返回值仍然是 `next()` 的 promise
 * （waterfall 协议要求，不是我们在等我们的进程）。测试用「挂起的发送 promise」证明这一点：
 * handler 同步返回、`next()` 已同步调用、返回值**就是** `next()` 那个 promise。
 */
export function createUserQuestionHandler({ ctx = {}, config = undefined, send = undefined, senderOptions = undefined } = {}) {
	const { sendCard } = createCardChannel({ ctx, config, send, senderOptions });

	return function handleUserQuestionRequest(request, next) {
		try {
			const classified = classifyUserQuestions(request);
			const session = agentSession(request);
			sendCard(session, classified.title, [classified.body, cwdLine(session)]);
		} catch (error) {
			// 通知失败绝不影响这一轮；但也不能静默
			logError(ctx, `user-questions/request 通知失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
		}

		// 委派必须在 try 之外：`next()` 的异常属于真实答题链，吞掉它等于伪造一个"答案"。
		return typeof next === 'function' ? next() : undefined;
	};
}

// ---------------------------------------------------------------- 插件入口

/**
 * 注册一个事件处理器；**永不抛**（`apply` 抛会让这条 entry 的 fiber 变 FAILED，见下）。
 *
 * 每个事件各一层 try/catch：注册 `session/event` 失败不该连带把 `user-questions/request`
 * 也一起丢掉 —— 两个时机的可用性互相独立，日志里也按事件名分得清。
 */
function registerHandler(ctx, config, event, factory) {
	try {
		ctx.on(event, factory({ ctx, config })); // 返回的 disposer 随 fiber 卸载自动注销
	} catch (error) {
		logError(ctx, `插件加载失败（${event}）：${error instanceof Error ? (error.stack ?? error.message) : String(error)}——该时机的通知将不可用`);
	}
}

/**
 * Cordis 插件入口（`Plugin.Object`：`apply(ctx, config)`）。
 *
 * 这里**绝不抛异常**：`apply` 抛会让这条 entry 的 fiber 变 FAILED
 * （`$RT/cordis/lib/types/fiber.d.ts:60-73`）。通知插件哪有资格拦下别人的启动。
 */
export function apply(ctx, config) {
	registerHandler(ctx, config, 'session/event', createSessionHandler);
	registerHandler(ctx, config, 'user-questions/request', createUserQuestionHandler);
}
