"use strict";

/**
 * GET /v1/models — 模型列表。
 * 1) 配置了 UPSTREAM_MODELS (逗号分隔或 JSON 数组) 时直接返回;
 * 2) 否则拉取上游 /v1/models 原样透传, FILTER_FREE=1 时只保留免费模型
 *    (id 以 :free/-free 结尾 或 pricing 为零)。
 */

const {
  upstreamAuth,
  isAuthorized,
  sendJSON,
  openAIError,
  upstreamEndpoint,
  handlePreflight,
} = require("../../lib/relay");

function modelObject(id) {
  return { id: String(id), object: "model", created: 0, owned_by: "relay" };
}

function isFreeModel(m) {
  if (!m || typeof m !== "object") return false;
  const id = String(m.id || "");
  const suffix = id.endsWith(":free") || id.endsWith("-free");
  const pricing = m.pricing || {};
  const zero = (v) => {
    if (typeof v === "number") return v === 0;
    if (typeof v === "string") {
      const s = v.trim().replace(/^\$/, "");
      return s !== "" && !Number.isNaN(Number(s)) && Number(s) === 0;
    }
    return false;
  };
  const promptZero = zero(pricing.prompt) || zero(pricing.input);
  const completionZero = zero(pricing.completion) || zero(pricing.output);
  return suffix || (promptZero && completionZero);
}

module.exports = async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  if (req.method !== "GET") {
    return sendJSON(res, 405, openAIError("method not allowed; use GET", "invalid_request_error", 405));
  }
  res.setHeader("access-control-allow-origin", "*");
  if (!isAuthorized(req)) {
    return sendJSON(res, 401, openAIError("invalid or missing client key", "authentication_error", 401));
  }

  // 1) 静态配置优先
  const configured = process.env.UPSTREAM_MODELS || "";
  if (configured.trim()) {
    let ids;
    try {
      ids = JSON.parse(configured);
    } catch (_) {
      ids = configured.split(",");
    }
    if (!Array.isArray(ids)) ids = [ids];
    const data = ids.map(String).map(modelObject);
    return sendJSON(res, 200, { object: "list", data });
  }

  // 2) 透传上游 (UPSTREAM_API_KEY 可为空, 空时透传客户端 Authorization)
  let upstream;
  try {
    const headers = { accept: "application/json" };
    const auth = upstreamAuth();
    if (auth) headers.authorization = auth;
    upstream = await fetch(upstreamEndpoint("/v1/models"), { headers });
  } catch (e) {
    return sendJSON(res, 502, openAIError("upstream unreachable: " + e.message, "server_error", 502));
  }
  const text = await upstream.text();
  if (upstream.status !== 200) {
    res.writeHead(upstream.status, { "content-type": "application/json; charset=utf-8" });
    return res.end(text);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    return sendJSON(res, 502, openAIError("upstream returned an invalid models payload"));
  }
  const list = Array.isArray(parsed && parsed.data) ? parsed.data : [];
  const filterFree = process.env.FILTER_FREE === "1" || process.env.FILTER_FREE === "true";
  const data = filterFree ? list.filter(isFreeModel) : list;
  return sendJSON(res, 200, { object: "list", data });
};
