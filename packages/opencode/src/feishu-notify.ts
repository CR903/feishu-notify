/**
 * Feishu Notification Plugin for OpenCode V2 (runtime 2.0.32)
 *
 * 通知时机（只保留「需要你介入」和「执行结束」两类）
 *   permission.asked               → 🔔 需要你决定（授权命令 / 工具）
 *   form.created                   → ❓ 需要你回答（AI 提问 / 表单）
 *   session.execution.succeeded    → ✅ 任务完成（正文像在提问时改标题，见下）
 *   session.execution.failed       → ❌ 任务失败
 *   session.execution.interrupted  → ⏸ 任务已中断
 *   session.text.ended             → 只累积 AI 最终文本，不触发发送
 *   session.idle                   → 静默兜底：2.0.32 从不派发，仅当某版本停了 execution.* 才接手
 *
 * webhook 从哪来（打包发布版：插件**不持有任何地址**）
 *   发送时只传 `--channel <name>`，由 `feishu-notify`（内核 CLI）从**用户自己的配置**解析地址。
 *   channel 名取自插件 options（`opencode.json` 里
 *   `{"package":"opencode-feishu-notify","options":{"channel":"opencode"}}`），默认 "opencode"。
 *   配置里没有这个 channel 时（单机器人用户只有 "default"）→ **显式降级**：去掉 `--channel` 重试一次
 *   （即走配置的 activeChannel），并在 DEBUG 日志里写明降级发生了；仍失败 → 放弃本次发送并记日志。
 *   **任何情况下都不回退到内置地址、也不改投别的机器人** —— 这是本包的安全底线。
 *
 * 两条踩过的坑（均实测）
 *   1) 机器人分流：插件曾一直传 --webhook，而脚本参数解析缺这个分支 → 通知全发到 Claude Code 那个
 *      机器人（"没用 Claude Code 还收到 Claude 机器人消息"）。现在两侧都走各自的 channel 名，
 *      由配置决定地址，不再有"某个文件里写死的地址"可以掺和进来。
 *   2) 文字提问不产生任何事件：AI 在正文里问"是否允许…"时，回合结束只有 execution.succeeded +
 *      最后文本。故从文本尾部启发式判定，命中 → ❓ 等你决定，否则 → ✅ 任务完成。
 *
 * 本轮指标（卡片正文：模型单独一行加粗，其余在第二行）
 *   模型 ← ctx.session.get().model（含 variant）；输出 tokens ← 会话累计值在回合内的差值；
 *   耗时（生成）← 各 step.started→step.ended 窗口累加（排除工具等待）；TPS ← 输出 ÷ 生成耗时。
 *   口径已三方对平（累计差值 / 每步累加 / session_message 逐条均 1270，累计值与 session_v2 一致）。
 *   回合基线落盘 feishu-turn/，热重载后接得回来；此时生成耗时无法重建，TPS 标「平均，含工具等待」。
 *
 * 事件载荷（实测，与 schema 一致）
 *   execution.succeeded    { id, created, type, durable:{aggregateID,seq,version}, data:{ sessionID } }
 *   execution.failed       data: { sessionID, error: { type, message, status? } }
 *   execution.interrupted  data: { sessionID, reason }
 *   text.ended             data: { sessionID, assistantMessageID, ordinal, text, state? }
 *   permission.asked       data: { sessionID, action, resources[], message?, id }
 *   form.created           data: { form: { id, sessionID, title, fields[] } }
 *   ⚠️ permission.asked 仍未实测到达（与 form.* 同为 ephemeral，结构上应当可达）
 *
 * 调试：FEISHU_NOTIFY_DEBUG=1 → ~/.local/share/opencode/feishu-notify.log
 *   （env 是进程级的，opencode server 常驻，改后需重启 server 才生效）
 *   降级（有 channel → 没有 channel）与放弃发送都在这个日志里，不会静默。
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { Plugin } from '@opencode/plugin';

const NOTIFY_BIN = `${process.env.HOME}/.local/bin/feishu-notify`;
const MSG_MAX_LEN = 2000;

/** 发送端默认 channel（`options.channel` 可覆盖）。这里只是**名字**，不是地址。 */
export const DEFAULT_CHANNEL = 'opencode';
/** `--source`：卡片标题里的"来源"，也是日志里区分调用方的标记 */
export const NOTIFY_SOURCE = 'opencode';
/** CLI 约定：退出码 2 = 配置问题（缺配置 / 坏配置 / **没有这个 channel**） */
export const CONFIG_ERROR_EXIT = 2;
/** 发送端（bash）超时；超时不算配置问题，不触发降级 */
export const NOTIFY_TIMEOUT_MS = 10_000;
// 同一通知在窗口内只发一次，且必须跨插件实例生效。
// 实测（2026-10-18）：同一条 session.execution.succeeded（同一个 evt_ id）被投递了 5 次
// （08:22:59.614/.617/.618/.619/.619，间隔几毫秒），即当时有 5 个插件实例各订阅了一条事件流。
// 因此去重不能只用内存 Map，必须用文件级原子抢占，否则一张卡片会发 5 条。
// 「任务完成」组（execution.succeeded/failed/interrupted + idle 兜底）共用同一个键，
// 保证一轮只出一条；窗口比普通去抖长，因为 idle 可能晚于 execution 事件若干秒
const DONE_DEDUPE_MS = 8000;
const PERMISSION_DEDUPE_MS = 10_000;
const TITLE_TTL_MS = 5 * 60 * 1000;
const LOG_FILE = `${process.env.HOME}/.local/share/opencode/feishu-notify.log`;
const CLAIM_DIR = `${process.env.HOME}/.local/share/opencode/feishu-claims`;
// 回合基线落盘目录：热重载后新实例能把基线接回来（否则整轮 耗时/tokens 都算不出来）
const TURN_DIR = `${process.env.HOME}/.local/share/opencode/feishu-turn`;
const TURN_TTL_MS = 6 * 60 * 60 * 1000;
// 需要抓原始事件载荷做验证的时机（DEBUG 时打印一次完整 JSON 片段）
const TRIGGER_TYPES = new Set([
  'permission.asked',
  'form.created',
  'session.execution.succeeded',
  'session.execution.failed',
  'session.execution.interrupted',
]);

// 调试开关（默认关）。注意 env 是进程级的：opencode server 常驻，
// 打开后需要重启 server 才生效；临时排查也可直接把这里改成 true（文件改动会触发热重载）。
const DEBUG = process.env.FEISHU_NOTIFY_DEBUG === '1';

interface PermissionData {
  sessionID?: string;
  action?: string;
  resources?: string[];
  message?: string;
  id?: string;
}

interface FormField {
  key?: string;
  title?: string;
  options?: Array<{ value?: string; label?: string }>;
}

interface FormData {
  form?: { id?: string; sessionID?: string; title?: string; fields?: FormField[] };
}

interface ExecutionData {
  sessionID?: string;
  reason?: string;
  error?: { type?: string; message?: string };
}

type Ctx = Plugin.Context;

function log(msg: string): void {
  if (!DEBUG) return;
  try {
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    // 日志失败不影响通知
  }
}

// ---------------------------------------------------------------- channel（R1/R3）

/**
 * channel 名从插件 options 来。`ctx.options` 就是 opencode.json 里那条声明带的 `options`
 * （`@opencode/plugin` 的 `Plugin.Context.options: PluginOptions`）。
 *
 * 认不出的形状（未配 / 空串 / 非字符串）一律落到 `DEFAULT_CHANNEL` ——
 * 这里只决定"向配置要哪个名字"，**永远不返回地址**。
 */
export function channelFromOptions(options: unknown): string {
  if (options !== null && typeof options === 'object') {
    const raw = (options as { channel?: unknown }).channel;
    if (typeof raw === 'string' && raw.trim() !== '') return raw.trim();
  }
  return DEFAULT_CHANNEL;
}

/**
 * 组装发送端 argv（**纯函数**，可单测）。
 *
 * - `withChannel: true`  → `--channel <name>`（首次尝试）
 * - `withChannel: false` → 不带 `--channel`，即让发送端走配置的 activeChannel（**降级重试**）
 *
 * 两种情况都只传"名字/什么都不传"，没有任何地址参与。
 */
export function buildNotifyArgs({
  channel = DEFAULT_CHANNEL,
  withChannel = true,
  args = [],
}: { channel?: string; withChannel?: boolean; args?: string[] } = {}): string[] {
  const head = ['--source', NOTIFY_SOURCE];
  if (withChannel) head.push('--channel', channel);
  return [...head, ...args];
}

/**
 * "配置里没有这个 channel" 的 stderr 特征。
 *
 * 发送端会把解析器（`feishu-notify-cli resolve`）的 ConfigError 原文透到 stderr，形如：
 *   配置里没有名为 "opencode" 的 channel（已有：default）
 * 这里按**形状**匹配，并把捕获到的名字与本次请求的名字核对 —— 否则别的 channel 名不一致的
 * 消息（将来的文案变化、doctor 的同类消息）会误触发一次没意义的重试。
 *
 * 判据刻意定得很窄：只有"退出码 2 **且** stderr 命中这条形状"才降级。
 * 缺配置 / 坏 JSON / 非 https / 网络失败都不降级（降级也解决不了，只会多发一次）。
 */
export function isChannelNotFoundStderr(stderr: string, channel: string): boolean {
  const match = /没有名为\s*"([^"]+)"\s*的\s*channel/.exec(typeof stderr === 'string' ? stderr : '');
  return match !== null && match[1] === channel;
}

export interface NotifyRunResult {
  ok: boolean;
  /** 进程退出码；进程起不来（ENOENT 等）时为 -1 */
  status: number;
  stderr: string;
  stdout: string;
}

export type NotifyRunner = (argv: string[]) => NotifyRunResult;

export interface NotifyAttempt extends NotifyRunResult {
  argv: string[];
  withChannel: boolean;
}

export type NotifyReason =
  | 'sent' // 第一次（带 --channel）就成功
  | 'sent-degraded' // 配置里没有该 channel → 去掉 --channel 重试成功（走 activeChannel）
  | 'failed' // 与 channel 无关的失败：不重试（网络、缺配置、退出码 1…）
  | 'gave-up-after-degrade'; // 降级重试也失败 → 放弃本次发送

export interface NotifyOutcome {
  ok: boolean;
  reason: NotifyReason;
  attempts: NotifyAttempt[];
}

/**
 * 带降级的发送**决策**（纯函数：IO 由 `run` 注入，日志由调用方负责）。
 *
 * 1) 先按 `--channel <name>` 调用
 * 2) 退出码 2 且 stderr 表明"没有这个 channel" → 去掉 `--channel` 重试一次（走 activeChannel）
 * 3) 仍失败 → 放弃本次发送（**绝不**回退到内置地址、**绝不**改投别的机器人）
 */
export function sendWithChannelFallback({
  channel,
  args,
  run,
}: {
  channel: string;
  args: string[];
  run: NotifyRunner;
}): NotifyOutcome {
  const attemptOnce = (withChannel: boolean): NotifyAttempt => {
    const argv = buildNotifyArgs({ channel, withChannel, args });
    return { argv, withChannel, ...run(argv) };
  };

  const first = attemptOnce(true);
  if (first.ok) return { ok: true, reason: 'sent', attempts: [first] };
  if (first.status !== CONFIG_ERROR_EXIT || !isChannelNotFoundStderr(first.stderr, channel)) {
    return { ok: false, reason: 'failed', attempts: [first] };
  }

  const second = attemptOnce(false);
  if (second.ok) return { ok: true, reason: 'sent-degraded', attempts: [first, second] };
  return { ok: false, reason: 'gave-up-after-degrade', attempts: [first, second] };
}

/**
 * 真实发送：execFileSync + 参数数组（标题里的引号不会被 shell 吃掉；旧版拼字符串有注入/截断风险）。
 * 永不抛：一切失败都变成返回值，交给决策与日志。
 */
function runSender(argv: string[]): NotifyRunResult {
  try {
    const stdout = execFileSync(NOTIFY_BIN, argv, {
      timeout: NOTIFY_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, status: 0, stderr: '', stdout: String(stdout) };
  } catch (e) {
    const err = e as { status?: number | null; code?: string; stderr?: unknown; stdout?: unknown; message?: string };
    const text = (value: unknown): string =>
      typeof value === 'string' ? value : Buffer.isBuffer(value) ? value.toString('utf8') : '';
    const stderr =
      text(err.stderr) ||
      text(err.stdout) ||
      (err.code === 'ENOENT' ? `找不到发送端：${NOTIFY_BIN}（需先安装 feishu-notify-cli）` : String(err.message ?? e));
    return { ok: false, status: typeof err.status === 'number' ? err.status : -1, stderr, stdout: '' };
  }
}

/**
 * 发一条通知，并把结果写进 DEBUG 日志。降级与放弃都是**显式的、被记录的行为**。
 *
 * `run` / `logger` 可注入：测试据此断言"实际传了什么 argv"与"日志里有没有写明降级"，无需真的发卡。
 */
export function feishuNotify(
  args: string[],
  { channel = DEFAULT_CHANNEL, run = runSender, logger = log }: { channel?: string; run?: NotifyRunner; logger?: (msg: string) => void } = {},
): NotifyOutcome {
  const outcome = sendWithChannelFallback({ channel, args, run });
  const tail = args.join(' ').slice(0, 80);

  if (outcome.ok && outcome.reason === 'sent-degraded') {
    const first = outcome.attempts[0];
    logger(
      `notify DEGRADED: 配置里没有 channel "${channel}"（原样：${first.stderr.trim().split('\n')[0].slice(0, 120)}）` +
        ` → 已去掉 --channel 重试并成功（走配置的 activeChannel；仍然没有任何内置地址）：${tail}`,
    );
  } else if (outcome.ok) {
    logger(`notify ok: ${tail} -> ${outcome.attempts[0].stdout.trim().slice(0, 60)}`);
  } else {
    const last = outcome.attempts[outcome.attempts.length - 1];
    logger(
      `notify FAILED (${outcome.reason}, 尝试 ${outcome.attempts.length} 次, exit=${last.status}): ${tail}` +
        ` -> ${last.stderr.trim().slice(0, 300)}`,
    );
  }
  return outcome;
}

// 标题 + 正文文件；正文永远非空（调用方保证），不出现裸的兜底文案
function notifyCard(title: string, body: string, channel: string): void {
  const tmp = `${process.env.HOME}/.local/share/opencode/feishu-msg-${process.pid}-${Date.now()}.txt`;
  try {
    writeFileSync(tmp, body.slice(0, MSG_MAX_LEN), 'utf8');
    feishuNotify(['--title', title, '--file', tmp], { channel });
  } catch (e) {
    log('write msg file failed: ' + String(e));
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // 忽略清理失败
    }
  }
}

function joinLines(lines: Array<string | undefined>): string {
  return lines.filter((l): l is string => typeof l === 'string' && l.length > 0).join('\n');
}

function fmtTok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));
}

function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

// 一轮（execution.started → execution.succeeded）的指标采集。
// tokens 用**会话累计值的差值**算，语义无歧义（session.updated.1 实测：连续快照 10095→10233→10692 单调递增）；
// genMs 由 step.started → step.ended 的墙钟窗口累加，作为 TPS 的分母（排除步骤之间的工具执行时间）。
interface TurnMetrics {
  t0: number;
  outTokens0: number;
  genMs: number;
  stepStart: number | null;
  outTokensStep: number; // 每步 tokens 累加，仅用于和差值互相印证（写日志）
}

// 卡片标题里的会话名截断：opencode 会拿首条用户消息当会话标题，动辄上百字，
// 直接塞进卡片 header 会把标题撑成一整段话（实测踩到）
const TITLE_MAX = 40;
function shorten(text: string): string {
  return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX)}…` : text;
}

// 「这轮是在问我」的启发式判定。只认强信号，宁可漏判也不要误判：
// 把正常的收尾总结标成"等你决定"同样让人困惑。
const QUESTION_PATTERNS = [
  /[?？]["'）)」』]*\s*$/, // 末尾问号（允许尾部引号/括号）
  /是否/,
  /要不要/,
  /需要你/,
  /请你(确认|决定|选择|授权|批准)/,
  /请确认/,
  /你(来)?(确认|决定|选择)/,
  /(可以|好|行|对)吗/,
  /吗\s*$/, // 句末「吗」在中文里只能结疑问句（注意别加「呢/吧」，它们能收陈述句）
  /(有没有|有)(问题|异议|意见)吗/,
  /要我(继续|接着)?(做|执行|创建|改|删)/,
];

// 导出以便单测（插件运行时只关心 default 导出，额外命名导出无副作用）
export function looksLikeQuestion(text: string): boolean {
  if (!text) return false;
  const tail = text.trim().slice(-240);
  if (!tail) return false;
  return QUESTION_PATTERNS.some((re) => re.test(tail));
}

/**
 * 回合基线的跨实例持久化（只存 t0 与进入本轮时的会话累计 output tokens，两个数）。
 * 为什么只存这两个：耗时和本论输出 tokens 都能精确恢复；而"生成耗时"是逐 step 累积的
 * 时间窗，无法跨实例重建 → 恢复后 TPS 会退化为"含工具等待的平均值"，卡片上会明确标注。
 * 这三个函数提到模块级是为了可单测（见同目录外的临时测试脚本）。
 */
export function saveTurnBaseline(sessionID: string, t0: number, outTokens0: number): void {
  try {
    mkdirSync(TURN_DIR, { recursive: true });
    writeFileSync(`${TURN_DIR}/${sessionID}.json`, JSON.stringify({ t0, outTokens0 }), 'utf8');
  } catch {
    // 落盘失败时退化为纯内存（功能不受影响，只是热重载后会丢基线）
  }
}

export function clearTurnBaseline(sessionID: string): void {
  try {
    unlinkSync(`${TURN_DIR}/${sessionID}.json`);
  } catch {
    // 文件不存在即可
  }
}

export interface TurnBaseline {
  sessionID: string;
  t0: number;
  outTokens0: number;
}

export function loadTurnBaselines(now: number, ttlMs: number): TurnBaseline[] {
  const found: TurnBaseline[] = [];
  try {
    mkdirSync(TURN_DIR, { recursive: true });
  } catch {
    return found;
  }
  let names: string[] = [];
  try {
    names = readdirSync(TURN_DIR);
  } catch {
    return found;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const sessionID = name.slice(0, -5);
    const file = `${TURN_DIR}/${name}`;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<TurnBaseline>;
      if (typeof raw.t0 !== 'number' || typeof raw.outTokens0 !== 'number') throw new Error('bad shape');
      if (now - raw.t0 > ttlMs) {
        unlinkSync(file); // 僵尸回合（进程被杀过）→ 清掉
        continue;
      }
      found.push({ sessionID, t0: raw.t0, outTokens0: raw.outTokens0 });
    } catch {
      try {
        unlinkSync(file); // 坏文件 → 清掉，不影响启动
      } catch {
        // 忽略
      }
    }
  }
  return found;
}

const MAX_RESOURCES = 8;
const MAX_FIELDS = 6;

function permissionBody(data: PermissionData): string {
  const resources = (data.resources ?? []).slice(0, MAX_RESOURCES);
  const more = (data.resources?.length ?? 0) - resources.length;
  return joinLines([
    `**动作**: \`${data.action || '（未提供）'}\``,
    resources.length > 0 ? `**资源**:\n${resources.map((r) => `- \`${r}\``).join('\n')}` : '',
    more > 0 ? `…另有 ${more} 项` : '',
    data.message ? `**说明**: ${data.message}` : '',
  ]);
}

function formBody(data: FormData): string {
  const form = data.form ?? {};
  const fields = (form.fields ?? []).slice(0, MAX_FIELDS).map((f) => {
    const label = f.title || f.key || '（未命名字段）';
    const options = (f.options ?? [])
      .slice(0, 6)
      .map((o) => o.label || o.value || '')
      .filter((s) => s.length > 0);
    return options.length > 0 ? `- ${label}\n  选项: ${options.join(' / ')}` : `- ${label}`;
  });
  const more = (form.fields?.length ?? 0) - fields.length;
  return joinLines([
    form.title ? `**${form.title}**` : '',
    ...fields,
    more > 0 ? `…另有 ${more} 个字段` : '',
  ]);
}

export default Plugin.define({
  id: 'feishu.notify',
  setup: async (ctx: Ctx) => {
    const controller = new AbortController();

    // 本实例发通知统一用的 channel 名（options 里没配就是 "opencode"）。
    // 只是个名字：地址由 feishu-notify CLI 从用户配置解析，插件里没有任何地址。
    const channel = channelFromOptions(ctx.options);

    // sessionID -> 最近一次 assistant 最终文本（session.text.ended 提供全量文本）
    const lastText = new Map<string, string>();
    // sessionID -> { title, at }
    const titleCache = new Map<string, { title: string; at: number }>();
    // 本实例内的去重键 -> 上次发送时间（先便宜地短路，跨实例由 claimOnce 兜底）
    const lastSentAt = new Map<string, number>();
    // sessionID -> 上次「任务完成」通知里带过的文本，用于判断 idle 兜底时有没有新输出
    const lastNotifiedText = new Map<string, string>();
    let claimCount = 0;

    async function sessionTitle(sessionID: string): Promise<string> {
      const now = Date.now();
      const cached = titleCache.get(sessionID);
      if (cached && now - cached.at < TITLE_TTL_MS) return cached.title;
      try {
        const session = await ctx.session.get({ sessionID });
        const title = session?.title ? String(session.title) : '';
        if (title) titleCache.set(sessionID, { title, at: now });
        return title;
      } catch (e) {
        log('fetch session title failed: ' + String((e as Error)?.message ?? e));
        return '';
      }
    }

    // 一轮指标采集：execution.started 建（并落盘），step.* 累积，回合结束取用后清理
    const turns = new Map<string, TurnMetrics>();
    // 热重载恢复：把上一批实例留下的基线接回来（耗时/输出 tokens 精确恢复，TPS 标注为平均值）
    for (const b of loadTurnBaselines(Date.now(), TURN_TTL_MS)) {
      turns.set(b.sessionID, {
        t0: b.t0,
        outTokens0: b.outTokens0,
        genMs: 0,
        stepStart: null,
        outTokensStep: 0,
      });
      log(`turn baseline restored ${b.sessionID} t0=${b.t0} cumOut=${b.outTokens0}`);
    }

    /**
     * 跨插件实例的原子去重：同一 key 在 ttl 内只有一个调用者能抢占成功。
     * 文件创建用 'wx'（O_EXCL），天然原子；抢先失败的一侧直接放弃发送。
     */
    function claimOnce(key: string, ttlMs: number): boolean {
      const now = Date.now();
      const last = lastSentAt.get(key);
      if (last !== undefined && now - last <= ttlMs) return false;
      lastSentAt.set(key, now);

      const file = `${CLAIM_DIR}/c-${createHash('sha1').update(key).digest('hex').slice(0, 16)}`;
      try {
        if (now - statSync(file).mtimeMs <= ttlMs) return false; // 另一实例刚发过
        unlinkSync(file); // 过期残留，清掉后重新抢占
      } catch {
        // 文件不存在：继续抢占
      }
      try {
        closeSync(openSync(file, 'wx'));
      } catch {
        return false; // 另一实例同时抢到了
      }

      if (++claimCount % 20 === 0) {
        resetClaimDir(now);
      }
      return true;
    }

    // 清理超过 60s 的抢占标记（顺带自愈：目录被删也能重建）
    function resetClaimDir(now: number): void {
      try {
        for (const name of readdirSync(CLAIM_DIR)) {
          const p = `${CLAIM_DIR}/${name}`;
          try {
            if (now - statSync(p).mtimeMs > 60_000) unlinkSync(p);
          } catch {
            // 单个文件清理失败忽略
          }
        }
      } catch {
        try {
          mkdirSync(CLAIM_DIR, { recursive: true });
        } catch {
          // 目录建不出来时退化为纯内存去重
        }
      }
    }

    try {
      mkdirSync(CLAIM_DIR, { recursive: true });
    } catch {
      // 忽略：claimOnce 会退化为内存去重
    }

    async function titleWith(sessionID: string, prefix: string): Promise<string> {
      const title = await sessionTitle(sessionID);
      return title ? `${prefix} · ${shorten(title)}` : prefix;
    }

    // 回合结束的标题：文本尾部像在提问 → 等你决定，否则 → 任务完成
    function completionPrefix(text: string): string {
      return looksLikeQuestion(text) ? '❓ 等你决定' : '✅ 任务完成';
    }

    // 本轮指标行：模型 / 输出 tokens / 耗时（生成耗时）/ TPS
    async function metricsLine(sessionID: string): Promise<string> {
      const m = turns.get(sessionID);
      const now = Date.now();
      let model = '';
      let cumOut = 0;
      try {
        const info = (await ctx.session.get({ sessionID })) as
          | { model?: { id?: string; variant?: string }; tokens?: { output?: number } }
          | undefined;
        if (info?.model?.id) {
          model = info.model.variant ? `${info.model.id} ${info.model.variant}` : info.model.id;
        }
        cumOut = Number(info?.tokens?.output ?? 0);
      } catch (e) {
        log('metrics session.get failed: ' + String((e as Error)?.message ?? e));
      }

      const elapsedMs = m ? now - m.t0 : 0;
      const out = m ? Math.max(0, cumOut - m.outTokens0) : 0;
      // measured=true 表示本实例亲眼见过 step 窗口；false 说明基线是热重载接回来的，
      // 生成耗时无法重建 → TPS 退化为整轮平均值，必须在卡片上标出来，不能混为一谈
      const measured = !!(m && m.genMs > 0);
      const genMs = measured ? (m as TurnMetrics).genMs : elapsedMs;

      // 模型单独一行、加粗 + emoji：作为卡片正文里最显眼的一栏；
      // 其余指标退到第二行，避免整段挤成一行看不出重点。
      // 只用 ** 粗体（飞书卡片 markdown 确定支持），不赌 <font color> 之类未验证的标签。
      const head: string[] = [];
      const sub: string[] = [];
      if (model) head.push(`**🤖 ${model}**`);
      if (out > 0) sub.push(`输出 ${fmtTok(out)} tok`);
      if (elapsedMs > 0) {
        sub.push(
          measured && genMs < elapsedMs - 1000
            ? `耗时 ${fmtDur(elapsedMs)}（生成 ${fmtDur(genMs)}）`
            : `耗时 ${fmtDur(elapsedMs)}`,
        );
      }
      if (out > 0 && genMs > 0) {
        sub.push(
          `≈${Math.round(out / (genMs / 1000))} tok/s${measured ? '（生成期）' : '（平均，含工具等待）'}`,
        );
      }

      if (m) {
        // 差值 vs 每步累加 vs 独立消息逐条，三方互相印证（已与 session_message/session_v2 对平）
        log(
          `metrics ${sessionID} elapsed=${elapsedMs}ms gen=${m.genMs}ms measured=${measured} deltaOut=${out} stepOut=${m.outTokensStep} cumOut=${cumOut}`,
        );
        turns.delete(sessionID);
        clearTurnBaseline(sessionID);
      }
      return joinLines([head.join(''), sub.join(' · ')]);
    }

    function withMetrics(body: string, metrics: string): string {
      return metrics ? `${body}\n\n${metrics}` : body;
    }

    // 四个结束分支共用：并发取标题与指标，再发卡片（原先每个分支各写一遍 IIFE）
    function sendCompletion(sessionID: string, prefix: string, detail: string): void {
      void (async () => {
        const [title, metrics] = await Promise.all([
          titleWith(sessionID, prefix),
          metricsLine(sessionID),
        ]);
        notifyCard(title, withMetrics(detail, metrics), channel);
      })();
    }

    function textOf(sessionID: string): string {
      return lastText.get(sessionID) ?? '';
    }

    log(`=== PLUGIN loaded (feishu.notify, 2026-10-18 时机重做；channel="${channel}") ===`);

    // 后台消费事件流（不阻塞 setup；插件卸载时 AbortController 终止）
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const type = event.type;

          // 指标采集：只累计，不发通知（放在 notify 闸门之前）
          switch (type) {
            case 'session.execution.started': {
              const sessionID = (event.data as { sessionID?: string } | undefined)?.sessionID;
              if (!sessionID) break;
              const t0 = Date.now();
              void ctx.session
                .get({ sessionID })
                .then((info) => {
                  const outTokens0 = Number((info as { tokens?: { output?: number } })?.tokens?.output ?? 0);
                  turns.set(sessionID, { t0, outTokens0, genMs: 0, stepStart: null, outTokensStep: 0 });
                  saveTurnBaseline(sessionID, t0, outTokens0); // 落盘，热重载后接得回来
                  log(`turn start ${sessionID} cumOut=${outTokens0}`);
                })
                .catch((e) => log('turn start session.get failed: ' + String(e)));
              break;
            }
            case 'session.step.started': {
              const sessionID = (event.data as { sessionID?: string } | undefined)?.sessionID;
              const m = sessionID ? turns.get(sessionID) : undefined;
              if (m) m.stepStart = Date.now();
              break;
            }
            case 'session.step.ended': {
              const d = event.data as { sessionID?: string; tokens?: { output?: number } } | undefined;
              const m = d?.sessionID ? turns.get(d.sessionID) : undefined;
              if (m) {
                if (m.stepStart !== null) {
                  m.genMs += Date.now() - m.stepStart;
                  m.stepStart = null;
                }
                m.outTokensStep += Number(d?.tokens?.output ?? 0);
              }
              break;
            }
          }

          // 只处理「正文累积 + 触发事件」；其余高频事件直接丢弃
          if (
            type !== 'session.text.ended' &&
            !TRIGGER_TYPES.has(type) &&
            type !== 'session.idle' &&
            type !== 'session.status'
          ) {
            continue;
          }
          if (DEBUG && TRIGGER_TYPES.has(type)) {
            log(`TRIGGER ${JSON.stringify(event).slice(0, 600)}`);
          }

          switch (type) {
            case 'session.text.ended': {
              const data = event.data as { sessionID?: string; text?: string } | undefined;
              if (data?.sessionID && typeof data.text === 'string') {
                lastText.set(data.sessionID, data.text.slice(0, MSG_MAX_LEN));
              }
              break;
            }

            case 'permission.asked': {
              const data = event.data as PermissionData | undefined;
              const sessionID = data?.sessionID;
              if (!sessionID) break;
              if (!claimOnce(`permission:${data?.id ?? sessionID}`, PERMISSION_DEDUPE_MS)) break;
              const body = permissionBody(data ?? {});
              void titleWith(sessionID, '🔔 需要你决定').then((title) =>
                notifyCard(title, body || '**有操作等待你授权**', channel),
              );
              break;
            }

            case 'form.created': {
              const data = event.data as FormData | undefined;
              const sessionID = data?.form?.sessionID;
              if (!sessionID) break;
              if (!claimOnce(`form:${data?.form?.id ?? sessionID}`, PERMISSION_DEDUPE_MS)) break;
              const body = formBody(data ?? {});
              void titleWith(sessionID, '❓ 需要你回答').then((title) =>
                notifyCard(title, body || '**AI 在等你填写信息**', channel),
              );
              break;
            }

            case 'session.execution.succeeded': {
              const data = event.data as ExecutionData | undefined;
              const sessionID = data?.sessionID;
              if (!sessionID) break;
              if (!claimOnce(`exec:${sessionID}`, DONE_DEDUPE_MS)) break;
              const text = textOf(sessionID);
              lastNotifiedText.set(sessionID, text);
              sendCompletion(sessionID, completionPrefix(text), text || '（本轮没有输出文本）');
              break;
            }

            case 'session.idle': {
              // 兜底：万一内核没有派发 session.execution.*，用 idle 补一条「任务完成」。
              // succeeded 已经发过时，同一去重键 + 文本未变化会把它拦掉，不会重复。
              const data = event.data as { sessionID?: string } | undefined;
              const sessionID = data?.sessionID;
              if (!sessionID) break;
              if (!claimOnce(`exec:${sessionID}`, DONE_DEDUPE_MS)) break;
              const text = textOf(sessionID);
              if (text === lastNotifiedText.get(sessionID)) break;
              lastNotifiedText.set(sessionID, text);
              sendCompletion(sessionID, completionPrefix(text), text || '（本轮没有输出文本）');
              break;
            }

            case 'session.execution.failed': {
              const data = event.data as ExecutionData | undefined;
              const sessionID = data?.sessionID;
              if (!sessionID) break;
              if (!claimOnce(`exec:${sessionID}`, DONE_DEDUPE_MS)) break;
              lastNotifiedText.set(sessionID, textOf(sessionID));
              const detail = joinLines([
                data?.error?.type ? `**类型**: \`${data.error.type}\`` : '',
                data?.error?.message ? `**错误**: ${data.error.message}` : '',
                textOf(sessionID),
              ]);
              sendCompletion(sessionID, '❌ 任务失败', detail || '（执行失败，无错误详情）');
              break;
            }

            case 'session.execution.interrupted': {
              const data = event.data as ExecutionData | undefined;
              const sessionID = data?.sessionID;
              if (!sessionID) break;
              if (!claimOnce(`exec:${sessionID}`, DONE_DEDUPE_MS)) break;
              lastNotifiedText.set(sessionID, textOf(sessionID));
              const detail = joinLines([
                data?.reason ? `**原因**: ${data.reason}` : '',
                textOf(sessionID),
              ]);
              sendCompletion(sessionID, '⏸ 任务已中断', detail || '（执行被中断）');
              break;
            }
          }
        }
      } catch (err) {
        // AbortError 为正常退出（插件卸载）；其余错误记入日志
        if (!(err instanceof Error) || err.name !== 'AbortError') {
          log('event stream error: ' + (err instanceof Error ? err.message : String(err)));
        }
      }
    })();

    // Cleanup：插件卸载/重载时终止事件流
    return () => controller.abort();
  },
});
