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
 */

import { spawnSync } from "node:child_process";

import { DEFAULT_FOOTER, maskWebhook } from "./config.mjs";

export const DEFAULT_CURL = "curl";
export const DEFAULT_CURL_TIMEOUT_MS = 15_000;

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
 * @returns {{ok:boolean, httpCode:number, bodyCode:number|undefined, body:string, message:string, elapsedMs:number}}
 *          永不抛错（网络/HTTP 失败都是返回值），由调用方决定退出码。
 */
export function sendPayload({
  webhook,
  payload,
  curl = process.env.FEISHU_NOTIFY_CURL || DEFAULT_CURL,
  env = process.env,
  timeoutMs = DEFAULT_CURL_TIMEOUT_MS,
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
    if (code === "ETIMEDOUT" || result.signal) return failed(`发送超时（${timeoutMs}ms 内没有响应，已中止）`, { elapsedMs });
    return failed(`调用 curl 失败：${result.error.message}`, { elapsedMs });
  }

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
