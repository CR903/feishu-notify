/**
 * `dsh-feishu-notify` 的类型（手写，无构建步骤）。
 *
 * 这里**不 import 任何 `@deepseek-ai/dsh-*` 类型**：本包运行时不依赖它们，全部靠
 * duck-type（只有 `@deepseek-ai/cordis` 与 `@deepseek-ai/schemastery` 是 peer）。
 * 形状按 DSH 0.2.0-rc.2 的实测 `.d.ts` 描述，能让调用方看懂我们碰了哪些字段。
 */

import type { Context } from '@deepseek-ai/cordis';
import type Schema from '@deepseek-ai/schemastery';

/** 插件名（Cordis `Plugin.Base.name`）。 */
export declare const name: 'dsh-feishu-notify';

/** 需要 Cordis 保证就绪的服务：空数组 —— 所有数据入口都是 duck-type 可选的。 */
export declare const inject: [];

/** 插件配置。真正会发到哪个机器人由内核 CLI 从用户自己的配置解析。 */
export declare const Config: Schema<{
	/** `--channel <name>`（名字，不是地址）。默认 `'dsh'`。 */
	channel: string;
	/** 工具失败是否也推（默认 `false`）。 */
	toolFailures: boolean;
}>;

/** Cordis 入口。**永不抛**：抛会让 fiber 变 FAILED。 */
export declare function apply(ctx: Context, config: { channel?: string; toolFailures?: boolean }): void;

// ------------------------------------------------------------------ 纯函数（导出的目的是可单测）

/** 归一后的分档：五档之一，或 `'unknown'`。 */
export type TurnEndKind = 'completed' | 'error' | 'aborted' | 'blocked' | 'max-tokens' | 'unknown';

export interface TurnEndClassification {
	kind: TurnEndKind;
	/** 卡片标题前缀，如 `'✅ 任务完成'`。 */
	title: string;
	/** 正文里那几行细节（可能为空串）。 */
	body: string;
}

/**
 * `turn/end` 的 `data` → 分档。
 *
 * 注意 `data.reason` 是**判别联合对象**，不是字符串：取 `reason.kind`。
 * 认不出的 kind（含 `interrupted` / `forked`，以及别的插件合并进来的档）落 `'unknown'`，不抛。
 */
export declare function classifyTurnEnd(data: { turn?: number; reason?: { kind?: string; error?: { message?: string; code?: string; status?: number } } } | undefined): TurnEndClassification;

/** `provider/model`；缺一个就用另一个；都没有返回 `''`。 */
export declare function modelLabel(requestContext: { provider?: string; model?: string } | undefined): string;

/** 把一轮里各步的 `assistant/message.usage` 累加；一步都没报过 → `undefined`。 */
export declare function foldUsages(usages: readonly unknown[] | undefined): Record<string, number> | undefined;

/** 指标行；`model` / `tokens` / `durationMs` 缺哪项就省略哪段；三项都缺 → `''`。 */
export declare function formatMetrics(metrics?: { model?: string; tokens?: Record<string, number> | undefined; durationMs?: number }): string;

/** `tokenUsage` 投影的 totals → `本会话累计 … tok`；拿不到 → `''`。 */
export declare function formatCumulativeTotals(totals: { outputTokens?: number } | undefined): string;

export interface BinCandidate {
	source: 'env' | 'home' | 'path';
	path: string;
	ok: boolean;
	detail: string;
}

export interface BinResolution {
	/** 可直接 spawn 的**绝对路径**；`null` = 一个都没找到 → **不发送** */
	path: string | null;
	source: 'env' | 'home' | 'path' | null;
	reason: 'env' | 'home' | 'path' | 'env-invalid' | 'not-found';
	candidates: BinCandidate[];
}

/** 发送端路径解析：`FEISHU_NOTIFY_BIN` → `~/.local/bin/feishu-notify` → PATH → 放弃。**不缓存**。 */
export declare function resolveNotifyBin(options?: { env?: Record<string, string | undefined>; isExecutable?: (path: string) => boolean }): BinResolution;

/** 解析失败 → 一句「下一步该干什么」。 */
export declare function describeBinFailure(resolution: BinResolution): string;

/** 组装发送端 argv（正文走位置参数，不经 shell）。 */
export declare function buildNotifyArgv(options?: { channel?: string; title?: string; body?: string; source?: string }): string[];

/** 无条件 ERROR 日志（走 `ctx.logger.error`，退到 stderr）。 */
export declare function logError(ctx: { logger?: { error?: (message: string) => void } } | undefined, message: string): void;

export interface Sender {
	(argv: string[]): unknown;
}

/** 造一个 fire-and-forget 发送函数；永不抛、永不 await。 */
export declare function createSender(options?: {
	spawn?: (...args: any[]) => any;
	env?: Record<string, string | undefined>;
	isExecutable?: (path: string) => boolean;
	onError?: (message: string) => void;
	timeoutMs?: number;
}): Sender;

/** 造 `(session, event) => void`（注册给 `session/event` 的那个 listener）。 */
export declare function createSessionHandler(options?: {
	ctx?: unknown;
	config?: { channel?: string; toolFailures?: boolean };
	send?: (argv: string[]) => unknown;
	now?: () => number;
	/** 透传给 `createSender`（测试用来注入 spawn / env） */
	senderOptions?: Record<string, unknown>;
}): (session: unknown, event: unknown) => void;

export declare function joinLines(lines: readonly (string | undefined)[]): string;
export declare function isExecutableFile(path: string, deps?: { stat?: unknown; access?: unknown }): boolean;

// ---------------------------------------------------- 需要你回答 / 计划待批（阻塞 waterfall）

/**
 * DSH 那边 `AskUserQuestionItem` 的最小子集（`$RT/dsh-user-questions/lib/types/types.d.ts:32`）。
 * 只列我们真读的字段 —— 其余（`id` / `signal` / `wait`）我们不用，故意不进类型。
 */
export interface DshUserQuestionItem {
	/** 问题正文（`.d.ts:36`）。 */
	question?: string;
	/** 短标题 / 分组名（`.d.ts:40`）；没有就用「问题 N」。 */
	header?: string;
	/** 补充细节（`.d.ts:38`）；plan-review 时是整篇计划 markdown，卡片上会截断。 */
	detail?: string;
	/** 可选项（`.d.ts:42`），只取 `label`。 */
	options?: readonly { label?: string }[];
	/** 是否多选（`.d.ts:44`）。 */
	multiSelect?: boolean;
	/** 表现意图（`.d.ts:46`）；`kind === 'plan-review'` 即「计划待批」，`approve` 是批准项的 label。 */
	intent?: { kind?: string; approve?: string };
}

/** `user-questions/request` 的载荷（`AskUserQuestionRequestEvent`，`.d.ts:118`）。 */
export interface DshUserQuestionRequest {
	questions?: readonly DshUserQuestionItem[];
	/** 只有它带 session（`request.agent.session`），用于取会话名与 cwd。 */
	agent?: { session?: unknown };
}

export interface UserQuestionsClassification {
	/** `'plan-review'` 只要有一问声明了该 intent；否则 `'question'`。 */
	kind: 'question' | 'plan-review';
	/** 卡片标题前缀（plan-review 会追加 `· 计划待批`，仍以 `❓ 需要你回答` 开头）。 */
	title: string;
	/** 正文（永不为空）。 */
	body: string;
	/** 载荷里**形状合法**（是对象）的问题数。 */
	questionCount: number;
	/** 其中 plan-review 的数量。 */
	planReviewCount: number;
}

/**
 * `user-questions/request` 的 request → 卡片内容。畸形载荷不抛。
 *
 * 注意 `intent` 认不出的 `kind` 一律当普通问题（上游可以继续加 intent）。
 */
export declare function classifyUserQuestions(request: DshUserQuestionRequest | undefined | null): UserQuestionsClassification;

/**
 * 造 `(request, next) => Promise<…>`，注册给**阻塞 waterfall** `user-questions/request`。
 *
 * 保证：通知 fire-and-forget（**不 await** 发送）；返回值**就是** `next()` 的 promise
 * —— waterfall 里不调 `next()` 会否决整条链，答题 UI 会拿不到问题。
 */
export declare function createUserQuestionHandler(options?: {
	ctx?: unknown;
	config?: { channel?: string; toolFailures?: boolean };
	send?: (argv: string[]) => unknown;
	/** 透传给 `createSender`（测试用来注入 spawn / env） */
	senderOptions?: Record<string, unknown>;
}): (request: DshUserQuestionRequest | undefined, next?: unknown) => unknown;

export declare const QUESTION_TITLE: '❓ 需要你回答';
export declare const PLAN_REVIEW_TITLE: '❓ 需要你回答 · 计划待批';
export declare const QUESTION_MAX_ITEMS: number;
export declare const QUESTION_DETAIL_MAX: number;

export declare const DEFAULT_CHANNEL: 'dsh';
export declare const NOTIFY_SOURCE: 'dsh';
export declare const NOTIFY_BIN: 'feishu-notify';
export declare const NOTIFY_BIN_ENV: 'FEISHU_NOTIFY_BIN';
export declare const NOTIFY_TIMEOUT_MS: number;
export declare const MSG_MAX_LEN: number;
export declare const TITLE_MAX: number;
export declare const UNKNOWN_TURN_END_TITLE: string;
