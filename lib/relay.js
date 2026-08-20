"use strict";

/**
 * Relay Desk — Vercel 核心网关共享模块 (零依赖, 运行于 Vercel Node Functions)。
 * 所有配置通过环境变量注入, 无状态、无外部存储。
 */

const DEFAULT_BASE_URL = "https://opencode.ai/zen";
const MAX_BODY_BYTES = 64 * 1024 * 1024; // 64MB 请求体上限

/** 上游 Base URL, 允许带或不带 /v1 后缀, 末尾斜杠会被去掉 */
function getBaseURL() {
  return (process.env.UPSTREAM_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
}

/** 上游 API Key (可空; 为空时透传客户端 Authorization 头给上游) */
function getAPIKey() {
  return (process.env.UPSTREAM_API_KEY || "").trim();
}

/**
 * 组装转发上游用的 Authorization 头。
 * 只使用 UPSTREAM_API_KEY; 未配置时不给上游带任何认证头,
 * 绝不把客户端的 Authorization (CLIENT_KEYS) 泄漏给上游。
 */
function upstreamAuth() {
  const key = getAPIKey();
  return key ? "Bearer " + key : "";
}

/**
 * 允许访问网关的客户端密钥, 逗号分隔。
 * 为空 = 不校验 (任何人可用); 配置后必须带 Authorization: Bearer <key>。
 * 兼容两种命名: CLIENT_KEYS / OCP_CLIENT_KEYS。
 */
function getClientKeys() {
  const raw = process.env.CLIENT_KEYS || process.env.OCP_CLIENT_KEYS || "";
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * 模型别名, JSON 对象: {"deepseek:free": "deepseek-chat", ...}。
 * 请求里的 model 先经别名解析再转发上游。
 */
function getAliases() {
  const raw = process.env.MODEL_ALIASES || "";
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

/** 解析模型名: 命中别名则替换, 否则原样返回 */
function resolveModel(model) {
  const aliases = getAliases();
  if (typeof model === "string" && Object.prototype.hasOwnProperty.call(aliases, model)) {
    return aliases[model];
  }
  return model;
}

/**
 * 拼接上游端点。path 形如 /v1/chat/completions。
 * 若 base 已带 /v1 则不会重复拼接。
 */
function upstreamEndpoint(path) {
  const base = getBaseURL();
  const p = path.startsWith("/") ? path : "/" + path;
  if (p === "/v1" || p.startsWith("/v1/")) {
    if (/\/v1$/.test(base)) return base + p.slice("/v1".length);
    return base + p;
  }
  return base + p;
}

/** 常数时间字符串比较, 用于密钥校验 */
function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 校验客户端 Authorization 头; 未配置密钥时放行 */
function isAuthorized(req) {
  const keys = getClientKeys();
  if (keys.length === 0) return true;
  const header = req.headers["authorization"] || "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  return keys.some((k) => constantTimeEqual(k, token));
}

/** 逐跳头, 不转发给客户端 */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "content-encoding",
]);

/** 读取请求体 (带大小上限) */
function readBody(req, limit) {
  const max = limit || MAX_BODY_BYTES;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > max) {
        req.destroy();
        reject(new Error("request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** 输出 OpenAI 兼容 JSON 错误 */
function openAIError(message, type, status) {
  return {
    error: { message, type: type || "invalid_request_error", param: null, code: null },
    status: status || 400,
  };
}

/** 发送 JSON 响应并附带宽松 CORS 头 (兼容浏览器侧工具) */
function sendJSON(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "access-control-allow-origin": "*",
  });
  res.end(body);
}

/**
 * 处理浏览器预检请求 (OPTIONS)。命中时直接以 204 结束并返回 true。
 * 未命中 (非 OPTIONS) 返回 false, 调用方继续正常处理。
 */
function handlePreflight(req, res) {
  if (req.method !== "OPTIONS") return false;
  res.writeHead(204, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "Authorization, Content-Type, Accept",
    "access-control-expose-headers": "Content-Type",
    "access-control-max-age": "86400",
  });
  res.end();
  return true;
}

module.exports = {
  getBaseURL,
  getAPIKey,
  upstreamAuth,
  getClientKeys,
  getAliases,
  resolveModel,
  handlePreflight,
  upstreamEndpoint,
  isAuthorized,
  readBody,
  sendJSON,
  openAIError,
  HOP_BY_HOP,
};
