"use strict";

/**
 * POST /v1/chat/completions — opencode 核心转发入口。
 * 校验客户端密钥 -> 模型别名解析 -> 转发上游 -> 原样流式回传 SSE / JSON。
 * 零依赖, 仅使用 Node 内置 fetch (Node 18+), 适配 Vercel Node Functions。
 */

const {
  getAPIKey,
  resolveModel,
  isAuthorized,
  readBody,
  sendJSON,
  openAIError,
  HOP_BY_HOP,
  upstreamEndpoint,
  handlePreflight,
} = require("../../../lib/relay");

/** 把上游响应体逐块泵给客户端 (SSE 流式) */
async function pump(upstream, res) {
  if (!upstream.body) {
    res.end(await upstream.text());
    return;
  }
  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length) res.write(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  res.end();
}

module.exports = async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  if (req.method !== "POST") {
    return sendJSON(res, 405, openAIError("method not allowed; use POST", "invalid_request_error", 405));
  }
  res.setHeader("access-control-allow-origin", "*");
  if (!isAuthorized(req)) {
    return sendJSON(res, 401, openAIError("invalid or missing client key", "authentication_error", 401));
  }

  const upstreamKey = getAPIKey();
  if (!upstreamKey) {
    return sendJSON(res, 500, openAIError("UPSTREAM_API_KEY is not configured on the server", "server_error", 500));
  }

  let raw;
  try {
    raw = await readBody(req);
  } catch (e) {
    return sendJSON(res, 400, openAIError("could not read request body: " + e.message));
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (_) {
    return sendJSON(res, 400, openAIError("request body must be valid JSON"));
  }
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.messages)) {
    return sendJSON(res, 400, openAIError("request body must include a messages array"));
  }
  if (typeof payload.model === "string") {
    payload.model = resolveModel(payload.model);
  }

  let upstream;
  try {
    upstream = await fetch(upstreamEndpoint("/v1/chat/completions"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: payload.stream ? "text/event-stream" : "application/json",
        authorization: "Bearer " + upstreamKey,
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return sendJSON(res, 502, openAIError("upstream unreachable: " + e.message, "server_error", 502));
  }

  // 回传上游状态与头, 过滤逐跳头; content-type 保上游原样 (SSE 必需)
  const outHeaders = { "content-type": upstream.headers.get("content-type") || "application/json" };
  for (const [name, value] of upstream.headers) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === "content-type" || lower === "set-cookie") continue;
    outHeaders[name] = value;
  }
  res.writeHead(upstream.status, outHeaders);
  try {
    await pump(upstream, res);
  } catch (_) {
    // 客户端断开或上游中断: 尽力结束响应
    if (!res.writableEnded) res.end();
  }
};
