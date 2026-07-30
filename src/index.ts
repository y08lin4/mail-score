interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  RAW_MAIL: R2Bucket;
  ANALYZE_QUEUE: Queue<AnalyzeJob>;
  CREATE_LIMITER: RateLimit;
  READ_LIMITER: RateLimit;
  APP_NAME?: string;
  INBOUND_DOMAIN?: string;
  TOKEN_SECRET: string;
}

interface AnalyzeJob {
  sessionId: string;
  objectKey: string;
}

type CheckStatus = "pass" | "warning" | "fail" | "info";

interface Check {
  id: string;
  group: "authentication" | "headers" | "content" | "transport";
  title: string;
  status: CheckStatus;
  points: number;
  maximum: number;
  evidence: string;
  advice: string;
}

interface Report {
  version: 1;
  analyzedAt: string;
  score: number;
  grade: string;
  summary: string;
  checks: Check[];
  limitations: string[];
}

interface SessionRow {
  id: string;
  expires_at: number;
  status: string;
  received_at: number | null;
  analyzed_at: number | null;
  report_json: string | null;
}

const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_RAW_BYTES = 5 * 1024 * 1024;
const encoder = new TextEncoder();

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") return json({ ok: true, service: "deliverability-lab" });
    if (url.pathname === "/api/sessions" && request.method === "POST") return createSession(request, env);
    if (url.pathname === "/api/sessions" && request.method === "GET") return readSession(request, env);
    if (url.pathname.startsWith("/api/")) return json({ success: false, message: "接口不存在" }, 404);

    const response = await env.ASSETS.fetch(request);
    return securityHeaders(response, true);
  },

  async email(message, env): Promise<void> {
    const domain = (env.INBOUND_DOMAIN || "").trim().toLowerCase();
    const recipient = splitMailbox(message.to);
    if (!recipient || recipient.domain !== domain || !recipient.local.startsWith("dl-")) {
      message.setReject("This recipient is not an active deliverability test address.");
      return;
    }
    if (message.rawSize > MAX_RAW_BYTES) {
      message.setReject("Message exceeds the 5 MiB analysis limit.");
      return;
    }

    const recipientHash = await sha256(recipient.local);
    const session = await env.DB.prepare(
      "SELECT id, expires_at, status FROM sessions WHERE recipient_hash = ? LIMIT 1",
    ).bind(recipientHash).first<Pick<SessionRow, "id" | "expires_at" | "status">>();
    if (!session || session.expires_at < Date.now() || session.status !== "waiting") {
      message.setReject("This test address is expired or already used.");
      return;
    }

    const objectKey = `mail/${session.id}/${crypto.randomUUID()}.eml`;
    try {
      await env.RAW_MAIL.put(objectKey, message.raw, {
        httpMetadata: { contentType: "message/rfc822" },
        customMetadata: { sessionId: session.id, receivedAt: String(Date.now()) },
      });
      await env.DB.prepare(
        "UPDATE sessions SET status = 'received', received_at = ?, object_key = ?, envelope_from = ? WHERE id = ? AND status = 'waiting'",
      ).bind(Date.now(), objectKey, message.from.slice(0, 320), session.id).run();
      await env.ANALYZE_QUEUE.send({ sessionId: session.id, objectKey });
    } catch {
      await env.DB.prepare("UPDATE sessions SET status = 'failed' WHERE id = ?").bind(session.id).run();
      message.setReject("The analysis service could not accept this message. Please try again later.");
    }
  },

  async queue(batch, env): Promise<void> {
    for (const item of batch.messages) {
      try {
        await analyzeMail(item.body, env);
        item.ack();
      } catch {
        item.retry({ delaySeconds: 30 });
      }
    }
  },

  async scheduled(_event, env): Promise<void> {
    const expired = await env.DB.prepare(
      "SELECT id, object_key FROM sessions WHERE expires_at < ? LIMIT 100",
    ).bind(Date.now()).all<{ id: string; object_key: string | null }>();
    for (const row of expired.results) if (row.object_key) await env.RAW_MAIL.delete(row.object_key);
    if (expired.results.length) await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(Date.now()).run();
  },
} satisfies ExportedHandler<Env, AnalyzeJob>;

async function createSession(request: Request, env: Env): Promise<Response> {
  if (!validOrigin(request)) return json({ success: false, message: "请求来源不受信任" }, 403);
  const rate = await env.CREATE_LIMITER.limit({ key: clientKey(request) });
  if (!rate.success) return json({ success: false, message: "创建测试地址过于频繁，请稍后再试" }, 429);

  const domain = (env.INBOUND_DOMAIN || "").trim().toLowerCase();
  if (!isDomain(domain) || domain.startsWith("replace_")) {
    return json({ success: false, message: "部署者尚未配置收信域名" }, 503);
  }
  const id = randomHex(16);
  const localPart = `dl-${randomHex(12)}`;
  const expiresAt = Date.now() + SESSION_TTL_MS;
  await env.DB.prepare(
    "INSERT INTO sessions (id, recipient_hash, created_at, expires_at, status) VALUES (?, ?, ?, ?, 'waiting')",
  ).bind(id, await sha256(localPart), Date.now(), expiresAt).run();

  return json({
    success: true,
    address: `${localPart}@${domain}`,
    token: await signToken(id, expiresAt, env.TOKEN_SECRET),
    expiresAt: new Date(expiresAt).toISOString(),
    retention: "原始邮件和报告会在地址过期后自动删除。",
  }, 201);
}

async function readSession(request: Request, env: Env): Promise<Response> {
  if (!validOrigin(request)) return json({ success: false, message: "请求来源不受信任" }, 403);
  const rate = await env.READ_LIMITER.limit({ key: clientKey(request) });
  if (!rate.success) return json({ success: false, message: "查询过于频繁，请稍后再试" }, 429);
  const token = new URL(request.url).searchParams.get("token") || "";
  const auth = await verifyToken(token, env.TOKEN_SECRET);
  if (!auth) return json({ success: false, message: "报告令牌无效或已过期" }, 403);

  const session = await env.DB.prepare(
    "SELECT id, expires_at, status, received_at, analyzed_at, report_json FROM sessions WHERE id = ? LIMIT 1",
  ).bind(auth.id).first<SessionRow>();
  if (!session) return json({ success: false, message: "检测会话不存在或已被清理" }, 404);
  let report: Report | null = null;
  try { report = session.report_json ? JSON.parse(session.report_json) as Report : null; } catch { /* corrupt rows are surfaced as pending */ }
  return json({
    success: true,
    status: session.status,
    expiresAt: new Date(session.expires_at).toISOString(),
    receivedAt: session.received_at ? new Date(session.received_at).toISOString() : null,
    analyzedAt: session.analyzed_at ? new Date(session.analyzed_at).toISOString() : null,
    report,
  });
}

async function analyzeMail(job: AnalyzeJob, env: Env): Promise<void> {
  const object = await env.RAW_MAIL.get(job.objectKey);
  if (!object) throw new Error("raw message not found");
  const raw = await object.text();
  const report = analyze(raw);
  await env.DB.prepare(
    "UPDATE sessions SET status = 'complete', analyzed_at = ?, report_json = ? WHERE id = ?",
  ).bind(Date.now(), JSON.stringify(report), job.sessionId).run();
}

function analyze(raw: string): Report {
  const { headers, body } = parseMessage(raw);
  const checks: Check[] = [];
  const from = firstHeader(headers, "from");
  const returnPath = firstHeader(headers, "return-path");
  const replyTo = firstHeader(headers, "reply-to");
  const auth = allHeaders(headers, "authentication-results").join(" ").toLowerCase();
  const dkim = firstHeader(headers, "dkim-signature");
  const contentType = firstHeader(headers, "content-type").toLowerCase();
  const received = allHeaders(headers, "received");

  add(checks, "dkim-signature", "authentication", "DKIM 签名结构", dkim && /\bd=[^;\s]+/i.test(dkim) && /\bs=[^;\s]+/i.test(dkim) ? "pass" : dkim ? "warning" : "fail", 12,
    dkim ? "检测到 DKIM-Signature，并找到 d= 与 s= 参数。" : "邮件头未检测到 DKIM-Signature。", "发送域应为每封外发邮件添加有效 DKIM 签名。");
  add(checks, "dkim-result", "authentication", "DKIM 验证结果", authResult(auth, "dkim"), 8,
    auth ? `Authentication-Results：${short(auth, 180)}` : "收件路径未提供 Authentication-Results。", "应在受控收信链路中核对 DKIM 的实际验证结果。");
  add(checks, "spf-result", "authentication", "SPF 验证结果", authResult(auth, "spf"), 8,
    auth ? `Authentication-Results：${short(auth, 180)}` : "收件路径未提供 Authentication-Results。", "检查发信 IP 是否包含在发件域 SPF 策略中。");
  add(checks, "dmarc-result", "authentication", "DMARC 验证与对齐", authResult(auth, "dmarc"), 7,
    auth ? `Authentication-Results：${short(auth, 180)}` : "收件路径未提供 Authentication-Results。", "配置 DMARC，并使 From 域与 SPF 或 DKIM 域对齐。");

  const fromDomain = mailboxDomain(from);
  const returnDomain = mailboxDomain(returnPath);
  add(checks, "from", "headers", "From 发件人", fromDomain ? "pass" : "fail", 6,
    fromDomain ? `From 使用域名：${fromDomain}` : "From 缺失或格式无法识别。", "使用可正常接收回复的标准 From 地址。");
  const aligned = fromDomain && returnDomain && relatedDomain(fromDomain, returnDomain);
  add(checks, "return-path", "headers", "Return-Path 与 From 一致性", aligned ? "pass" : returnPath ? "warning" : "warning", 5,
    returnPath ? (aligned ? "Return-Path 与 From 域名一致或同属一个组织域。" : "Return-Path 与 From 域名不一致。") : "邮件头未提供 Return-Path。", "营销或事务邮件应让信封发件域与 From 域保持可解释的一致关系。");
  const replyDomain = mailboxDomain(replyTo);
  add(checks, "reply-to", "headers", "Reply-To 可解释性", !replyTo || (fromDomain && replyDomain && relatedDomain(fromDomain, replyDomain)) ? "pass" : "warning", 3,
    replyTo ? `Reply-To 使用域名：${replyDomain || "无法识别"}` : "未设置 Reply-To（通常是正常的）。", "如设置 Reply-To，应避免把用户无提示地引导到无关域名。");
  const date = firstHeader(headers, "date");
  const dateValue = Date.parse(date);
  add(checks, "date", "headers", "Date 时间", Number.isFinite(dateValue) ? Math.abs(Date.now() - dateValue) > 7 * 86400000 ? "warning" : "pass" : "fail", 4,
    Number.isFinite(dateValue) ? `Date：${date}` : "Date 缺失或无法解析。", "由发送程序生成正确的 RFC 5322 Date 头，避免明显偏差。");
  const messageId = firstHeader(headers, "message-id");
  add(checks, "message-id", "headers", "Message-ID", /<[^<>\s]+@[^<>\s]+>/.test(messageId) ? "pass" : "warning", 4,
    messageId ? `Message-ID：${short(messageId, 120)}` : "未检测到 Message-ID。", "为每封邮件生成唯一且格式正确的 Message-ID。");
  add(checks, "subject", "headers", "Subject 主题", firstHeader(headers, "subject").trim() ? "pass" : "warning", 3,
    firstHeader(headers, "subject").trim() ? "主题存在。" : "主题为空。", "为收件人提供具体、可理解的主题。");

  const hasPlain = /text\/plain/i.test(contentType) || (!/multipart\//i.test(contentType) && body.trim().length > 0);
  add(checks, "plain-text", "content", "纯文本版本", hasPlain ? "pass" : "warning", 8,
    hasPlain ? "检测到纯文本正文或单段文本消息。" : "未检测到明确的 text/plain 版本。", "HTML 邮件应同时提供可读的纯文本 MIME 部分。");
  const hasHTML = /text\/html/i.test(contentType) || /<html[\s>]|<body[\s>]|<table[\s>]/i.test(body);
  const activeHTML = /<script\b|<form\b|javascript:/i.test(body);
  const remoteImages = (body.match(/<img\b[^>]+\bsrc=["']https?:\/\//gi) || []).length;
  add(checks, "html-safety", "content", "HTML 结构与活跃内容", activeHTML ? "fail" : hasHTML && remoteImages > 8 ? "warning" : "pass", 7,
    activeHTML ? "HTML 中含有 script、form 或 javascript: 内容。" : hasHTML ? `HTML 正文存在；远程图片数量：${remoteImages}。` : "邮件未使用 HTML 正文。", "不要在邮件中加入脚本、表单或可执行内容；控制远程图片数量。");
  const links = extractLinks(body);
  const suspiciousLinks = links.filter((link) => /^http:\/\//i.test(link) || /https?:\/\/\d{1,3}(?:\.\d{1,3}){3}/.test(link) || /xn--/i.test(link));
  add(checks, "links", "content", "链接卫生", suspiciousLinks.length ? "warning" : links.length > 16 ? "warning" : "pass", 6,
    `共检测到 ${links.length} 个 URL；高风险格式 ${suspiciousLinks.length} 个。`, "优先使用 HTTPS、自有域名和清晰链接；避免裸 IP、Punycode 与过量链接。");
  const attachmentRisk = /content-disposition:\s*attachment|filename\*?=/i.test(raw) && /\.(?:exe|js|vbs|scr|bat|cmd|jar|msi)(?:["';\s]|$)/i.test(raw);
  const hasAttachment = /content-disposition:\s*attachment|filename\*?=/i.test(raw);
  add(checks, "attachments", "content", "附件风险", attachmentRisk ? "fail" : hasAttachment ? "warning" : "pass", 4,
    attachmentRisk ? "检测到高风险可执行附件扩展名。" : hasAttachment ? "检测到附件；报告不会执行或打开附件。" : "未检测到附件。", "避免可执行附件；必要文件宜使用受控下载链接并说明用途。");

  add(checks, "received-trace", "transport", "Received 传输链", received.length ? "pass" : "warning", 10,
    received.length ? `检测到 ${received.length} 条 Received 记录。` : "未检测到 Received 记录。", "保留完整的传输头，便于诊断中继与 TLS 路径。");
  const hasMimeVersion = Boolean(firstHeader(headers, "mime-version"));
  add(checks, "mime-version", "transport", "MIME 声明", hasMimeVersion ? "pass" : hasHTML || hasAttachment ? "warning" : "pass", 5,
    hasMimeVersion ? "检测到 MIME-Version 头。" : "未检测到 MIME-Version 头。", "含多部分、HTML 或附件的邮件应明确声明 MIME-Version: 1.0。");

  const score = Math.max(0, Math.min(100, checks.reduce((total, check) => total + check.points, 0)));
  return {
    version: 1,
    analyzedAt: new Date().toISOString(),
    score,
    grade: score >= 90 ? "配置良好" : score >= 70 ? "可投递，建议优化" : score >= 45 ? "存在明显风险" : "需要先修复基础配置",
    summary: `完成 ${checks.length} 项离线检测，其中 ${checks.filter((check) => check.status === "fail").length} 项失败、${checks.filter((check) => check.status === "warning").length} 项需要关注。`,
    checks,
    limitations: [
      "本报告评估收到的邮件及其可见认证证据，不等同于 Gmail、Outlook 等真实邮箱的进箱率。",
      "第一阶段不会调用第三方信誉或黑名单 API，也不会打开链接、执行附件或加载邮件远程资源。",
      "SPF、DKIM、DMARC 的独立 DNS 与密码学复核将在后续检测器版本加入；当前会展示收信路径提供的 Authentication-Results。",
    ],
  };
}

function add(checks: Check[], id: Check["id"], group: Check["group"], title: string, status: CheckStatus, maximum: number, evidence: string, advice: string): void {
  const points = status === "pass" ? maximum : status === "warning" ? Math.floor(maximum / 2) : 0;
  checks.push({ id, group, title, status, points, maximum, evidence, advice });
}

function authResult(value: string, name: string): CheckStatus {
  if (!value) return "warning";
  if (new RegExp(`\\b${name}=pass\\b`, "i").test(value)) return "pass";
  if (new RegExp(`\\b${name}=(fail|softfail|temperror|permerror)\\b`, "i").test(value)) return "fail";
  return "warning";
}

function parseMessage(raw: string): { headers: Map<string, string[]>; body: string } {
  const match = /\r?\n\r?\n/.exec(raw);
  const headerBlock = match ? raw.slice(0, match.index) : raw;
  const body = match ? raw.slice((match.index || 0) + match[0].length) : "";
  const headers = new Map<string, string[]>();
  let current = "";
  for (const line of headerBlock.replace(/\r\n/g, "\n").split("\n")) {
    if (/^[ \t]/.test(line) && current) {
      const values = headers.get(current)!;
      values[values.length - 1] += ` ${line.trim()}`;
      continue;
    }
    const pivot = line.indexOf(":");
    if (pivot < 1) { current = ""; continue; }
    current = line.slice(0, pivot).trim().toLowerCase();
    const values = headers.get(current) || [];
    values.push(line.slice(pivot + 1).trim());
    headers.set(current, values);
  }
  return { headers, body };
}

function firstHeader(headers: Map<string, string[]>, name: string): string { return headers.get(name.toLowerCase())?.[0] || ""; }
function allHeaders(headers: Map<string, string[]>, name: string): string[] { return headers.get(name.toLowerCase()) || []; }
function extractLinks(body: string): string[] { return [...new Set(body.match(/https?:\/\/[^\s<>"')]+/gi) || [])].slice(0, 100); }
function short(value: string, length: number): string { return value.length > length ? `${value.slice(0, length - 1)}…` : value; }
function mailboxDomain(value: string): string | null { return /<?[^<>\s@]+@([^<>\s@]+)>?/i.exec(value)?.[1]?.toLowerCase() || null; }
function relatedDomain(left: string, right: string): boolean { return left === right || left.endsWith(`.${right}`) || right.endsWith(`.${left}`); }
function splitMailbox(value: string): { local: string; domain: string } | null { const match = /^([^@\s]+)@([^@\s]+)$/i.exec(value.trim()); return match ? { local: match[1].toLowerCase(), domain: match[2].toLowerCase() } : null; }
function isDomain(value: string): boolean { return value.length <= 253 && value.split(".").length >= 2 && value.split(".").every((label) => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/i.test(label)); }
function clientKey(request: Request): string { return request.headers.get("CF-Connecting-IP") || "anonymous"; }
function validOrigin(request: Request): boolean { const origin = request.headers.get("origin"); return !origin || origin === new URL(request.url).origin; }

function randomHex(bytes: number): string { const data = crypto.getRandomValues(new Uint8Array(bytes)); return Array.from(data, (byte) => byte.toString(16).padStart(2, "0")).join(""); }
async function sha256(value: string): Promise<string> { const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value)); return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""); }
async function signToken(id: string, expiresAt: number, secret: string): Promise<string> { const payload = `${id}.${expiresAt}`; return `${payload}.${await hmac(payload, secret)}`; }
async function verifyToken(token: string, secret: string): Promise<{ id: string; expiresAt: number } | null> { const match = /^([a-f0-9]{32})\.(\d{13})\.([A-Za-z0-9_-]+)$/.exec(token); if (!match || Number(match[2]) < Date.now()) return null; const payload = `${match[1]}.${match[2]}`; return timingSafeEqual(match[3], await hmac(payload, secret)) ? { id: match[1], expiresAt: Number(match[2]) } : null; }
async function hmac(payload: string, secret: string): Promise<string> { const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload)); return base64URL(new Uint8Array(signature)); }
function base64URL(bytes: Uint8Array): string { let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function timingSafeEqual(left: string, right: string): boolean { if (left.length !== right.length) return false; let difference = 0; for (let i = 0; i < left.length; i += 1) difference |= left.charCodeAt(i) ^ right.charCodeAt(i); return difference === 0; }
function json(payload: unknown, status = 200): Response { return securityHeaders(new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } })); }
function securityHeaders(response: Response, noIndex = false): Response { const headers = new Headers(response.headers); headers.set("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"); headers.set("Referrer-Policy", "no-referrer"); headers.set("X-Content-Type-Options", "nosniff"); headers.set("X-Frame-Options", "DENY"); headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()"); if (noIndex) headers.set("X-Robots-Tag", "noindex, nofollow, noarchive"); return new Response(response.body, { status: response.status, statusText: response.statusText, headers }); }
