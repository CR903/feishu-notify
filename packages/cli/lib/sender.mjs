/**
 * lib/sender.mjs — 发送实现（CLI 侧唯一实现：init / doctor 的测试卡片）
 *
 * 为什么 CLI 侧不重写一套 HTTP：发送端（bash）用 curl，CLI 侧（Node）同样用 curl 子进程，
 * 行为与用户环境一致（代理、证书、curl 配置），且测试可以像 tests/capture-fixtures.sh 那样
 * **用 PATH 覆盖 stub 掉 curl** —— 断言测试因此完全不需要外网（子进程监督契约见
 * .trellis/spec/opencode-plugin/subprocess-supervision.md：这里 spawn 的是原生 curl 可执行文件，
 * 不是 npm launcher，没有"launcher 被 SIGKILL 后子进程成孤儿"的问题；但仍然设了超时，
 * 避免 doctor 在坏网络下挂死）。
 *
 * 安全：本文件不接收、不返回、不打印 webhook 明文；需要展示时一律用 config.mjs 的 maskWebhook。
 *
 * ## 超时可注入（FEISHU_NOTIFY_TIMEOUT_MS）
 *
 * 超时是**这里唯一的墙钟依赖**。它原本写死 15s，于是"发测试卡片后断言退出码"的测试
 * 实际在断言"这台机器 15s 内跑得完一次 stub curl"——压测/并行跑测试文件时机器一忙，
 * doctor 就把 channel 判成"不通"→ 退出码 1，测试**红得毫无道理**（2026-10-18 实测：
 * 连跑 5 遍根目录 npm test，第 4 遍 wiring.test.mjs 的 doctor 用例 duration 15628ms 撞上 15000ms 超时）。
 *
 * 所以：默认值不变（15s），但允许 env 覆盖，且**带范围钳制**（见 resolveTimeoutMs）。
 * 接线诊断类的测试据此把超时调到很大（它们验证的是诊断，不是超时行为）；
 * 超时行为本身另有一条专门的、确定性的用例（tests/timeout.test.mjs）。
 */

import { spawnSync } from "node:child_process";

import { DEFAULT_FOOTER, maskWebhook } from "./config.mjs";

export const DEFAULT_CURL = "curl";
export const DEFAULT_CURL_TIMEOUT_MS = 15_000;

/** 超时的合法范围（ms）：越界钳到边界，而不是照单全收 —— 0/负数/荒谬大值都是配置事故，不该把 doctor 挂死或变成立即失败 */
export const MIN_CURL_TIMEOUT_MS = 10;
export const MAX_CURL_TIMEOUT_MS = 600_000;

/** 覆盖超时的环境变量名（单处定义，避免文档与实现各写一遍字符串） */
export const TIMEOUT_ENV = "FEISHU_NOTIFY_TIMEOUT_MS";

/**
 * 解析生效的超时（ms）。**永不抛**：通知工具不该因为一个坏 env 就发不出去卡片。
 *
 *   - 未设置 / 空串 / 非数字（"abc"、""、NaN）→ 默认 15s（产品行为不变）
 *   - 小数 → 取整
 *   - 越界 → 钳到 [10ms, 600000ms]（0 与负数 → 10ms，比"立即失败"更可控；超大值 → 10min 上限）
 */
export function resolveTimeoutMs(env = process.env) {
  const raw = env?.[TIMEOUT_ENV];
  if (raw === undefined || raw === null) return DEFAULT_CURL_TIMEOUT_MS;
  const text = String(raw).trim();
  if (text === "") return DEFAULT_CURL_TIMEOUT_MS;

  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return DEFAULT_CURL_TIMEOUT_MS;

  return Math.min(MAX_CURL_TIMEOUT_MS, Math.max(MIN_CURL_TIMEOUT_MS, Math.trunc(parsed)));
}

/**
 * 测试卡片的 payload。**不含** webhook 明文（只有掩码），也不含任何密钥。
 *
 * `footer` 是"当前生效的 footer"（`init` / `doctor` 传进来）：自检卡片要和真实通知长得一样，
 * 否则用户无法从卡片上看出自己配的 footer 生效没有。规则与发送端一致：
 * 非空 → `${footer} · ${时间戳}`；空串 → 只有时间戳；未传 → 中性默认。
 */
export function testCardPayload({ channelName, label, webhook, footer = DEFAULT_FOOTER, timestamp = nowStamp() } = {}) {
  const title = `feishu-notify 自检${channelName ? `（${channelName}）` : ""}`;
  const lines = [
    "**配置自检**：能看到这张卡片，说明这个 channel 的 webhook 是通的。",
    channelName ? `- channel：\`${channelName}\`` : null,
    label ? `- label：${label}` : null,
    webhook ? `- 地址：\`${maskWebhook(webhook)}\`` : null,
  ].filter(Boolean);
  const noteText = footer === "" ? timestamp : `${footer} · ${timestamp}`;

  return JSON.stringify({
    msg_type: "interactive",
    card: {
      header: { title: { tag: "plain_text", content: title }, template: "blue" },
      elements: [
        { tag: "markdown", content: lines.join("\n") },
        { tag: "hr" },
        { tag: "note", elements: [{ tag: "plain_text", content: noteText }] },
      ],
    },
  });
}

/**
 * POST 一个 payload 到 webhook。
 *
 * 判定“成功”比 bash 发送端更严一档（这是**新增**代码，不改发送端既有行为）：
 * 飞书机器人接口在 token 无效时也会回 HTTP 200，只在 body 里给 `code != 0`。
 * 因此这里要求 2xx **且** body.code 为 0（body 不是带 code 的 JSON 时只看 HTTP 状态）。
 * init 靠它决定“验证通过才落盘”，所以严一点是必要的。
 *
 * 超时：`timeoutMs` 缺省 = `resolveTimeoutMs(env)`（默认 15s，可被 FEISHU_NOTIFY_TIMEOUT_MS 覆盖）。
 * 显式传入的 `timeoutMs` 优先 —— 测试据此在不依赖墙钟的前提下钉住各分支（含"发送超时"本身）。
 *
 * @returns {{ok:boolean, httpCode:number, bodyCode:number|undefined, body:string, message:string, elapsedMs:number}}
 *          永不抛错（网络/HTTP 失败都是返回值），由调用方决定退出码。
 */
export function sendPayload({
  webhook,
  payload,
  curl = process.env.FEISHU_NOTIFY_CURL || DEFAULT_CURL,
  env = process.env,
  timeoutMs = resolveTimeoutMs(env),
  spawn = spawnSync,
} = {}) {
  const args = ["-sS", "-w", "\n%{http_code}", "-X", "POST", webhook, "-H", "Content-Type: application/json", "--data-binary", payload];
  const started = Date.now();

  let result;
  try {
    result = spawn(curl, args, { encoding: "utf8", timeout: timeoutMs, env, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    return failed(`调用 curl 失败：${error?.message ?? error}`, { elapsedMs: Date.now() - started });
  }
  const elapsedMs = Date.now() - started;

  if (result.error) {
    const code = result.error.code;
    if (code === "ENOENT") return failed(`找不到 curl（可设置 FEISHU_NOTIFY_CURL 指定路径）`, { elapsedMs });
  }

  // G5：`signal` 或 `ETIMEDOUT` 都归到“发送超时”。**不再要求 error 存在** ——
  // 子进程被外部信号杀死（stub 自杀 / 被 kill）时 spawnSync 可能只给 signal、不给 error，
  // 旧写法会掉进下面的 httpCode===0 分支，文案退化成“没有拿到 HTTP 状态码”。
  const signal = result.signal ?? result.error?.signal;
  const code = result.error?.code;
  if (code === "ETIMEDOUT" || signal) {
    const why = signal ? `，信号 ${signal}` : "";
    return failed(`发送超时（${timeoutMs}ms 内没有响应，已中止${why}）`, { elapsedMs });
  }

  if (result.error) return failed(`调用 curl 失败：${result.error.message}`, { elapsedMs });

  const stdout = result.stdout ?? "";
  const match = /(\d{3})\s*$/.exec(stdout);
  const httpCode = match ? Number(match[1]) : 0;
  const body = (match ? stdout.slice(0, match.index) : stdout).trim();
  const bodyCode = parseBodyCode(body);
  const curlStderr = (result.stderr ?? "").trim();

  if (httpCode === 0) {
    return { ok: false, httpCode, bodyCode, body, message: `没有拿到 HTTP 状态码（curl 退出码 ${result.status}）${curlStderr ? `：${curlStderr}` : ""}`, elapsedMs };
  }
  if (httpCode < 200 || httpCode >= 300) {
    return { ok: false, httpCode, bodyCode, body, message: `HTTP ${httpCode}${curlStderr ? `（${curlStderr}）` : ""}`, elapsedMs };
  }
  if (bodyCode !== undefined && bodyCode !== 0) {
    return { ok: false, httpCode, bodyCode, body, message: `飞书返回 code=${bodyCode}${bodyMessage(body) ? ` msg=${bodyMessage(body)}` : ""}（HTTP 200 但业务失败）`, elapsedMs };
  }
  return { ok: true, httpCode, bodyCode, body, message: `HTTP ${httpCode}`, elapsedMs };
}

/** 发一张测试卡片；返回同 sendPayload，并附带脱敏后的目标地址（便于日志对照） */
export function sendTestCard({ webhook, channelName, label, footer, ...rest } = {}) {
  const result = sendPayload({ webhook, payload: testCardPayload({ webhook, channelName, label, footer }), ...rest });
  return { ...result, webhookMasked: maskWebhook(webhook) };
}

/** 展示用的正文截断（飞书错误 body 是我们自己打印的，不含 webhook） */
export function shortBody(body, max = 200) {
  const text = (body ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function failed(message, { elapsedMs }) {
  return { ok: false, httpCode: 0, bodyCode: undefined, body: "", message, elapsedMs };
}

function parseBodyCode(body) {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === "object" && typeof parsed.code === "number") return parsed.code;
  } catch {
    /* 非 JSON 正文：没有业务码可判 */
  }
  return undefined;
}

function bodyMessage(body) {
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === "object" && typeof parsed.msg === "string") return parsed.msg.slice(0, 120);
  } catch {
    /* ignore */
  }
  return "";
}

function nowStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
