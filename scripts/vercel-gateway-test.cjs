"use strict";

/**
 * Relay Desk Vercel 网关本地冒烟测试 (零依赖)。
 * 起一个 mock 上游, 用真实 http 服务器路由到 api/ 下的 handler,
 * 覆盖: 健康检查 / 客户端鉴权 / 别名解析 / 非流式与 SSE 流式转发 / 模型列表 / 405。
 * 运行: node scripts/vercel-gateway-test.cjs
 */

const http = require("node:http");
const assert = require("node:assert");

const chatHandler = require("../api/v1/chat/completions.js");
const modelsHandler = require("../api/v1/models.js");
const healthzHandler = require("../api/healthz.js");

let failures = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log("  PASS  " + name))
    .catch((e) => {
      failures++;
      console.log("  FAIL  " + name + "  ->  " + (e && e.message));
    });
}

function readReq(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

/** mock 上游: 回显 chat 请求, 返回 models 列表 */
function startMockUpstream() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      const body = JSON.parse(await readReq(req));
      const model = body.model || "unknown";
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write('data: {"id":"chatcmpl-mock","object":"chat.completion.chunk","model":"' + model + '","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"}}]}\n\n');
        res.write('data: {"id":"chatcmpl-mock","object":"chat.completion.chunk","model":"' + model + '","choices":[{"index":0,"delta":{"content":" world"}}]}\n\n');
        res.end("data: [DONE]\n\n");
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "chatcmpl-mock", object: "chat.completion", model, choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      }
      return;
    }
    if (url.pathname === "/v1/models" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        object: "list",
        data: [
          { id: "deepseek-chat", object: "model", owned_by: "deepseek" },
          { id: "deepseek-reasoner", object: "model", owned_by: "deepseek" },
          { id: "deepseek:free", object: "model", owned_by: "deepseek", pricing: { prompt: 0, completion: 0 } },
          { id: "gpt-4o", object: "model", owned_by: "openai", pricing: { prompt: 10, completion: 20 } },
        ],
      }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

/** 起一个路由到真实 handler 的网关服务器 */
function startGateway() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/v1/chat/completions") return chatHandler(req, res);
    if (url.pathname === "/v1/models") return modelsHandler(req, res);
    if (url.pathname === "/healthz") return healthzHandler(req, res);
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function post(base, path, body, headers) {
  return fetch(base + path, { method: "POST", headers: Object.assign({ "content-type": "application/json" }, headers || {}), body: JSON.stringify(body) });
}
function get(base, path, headers) {
  return fetch(base + path, { method: "GET", headers: headers || {} });
}

async function main() {
  const upstream = await startMockUpstream();
  const gateway = await startGateway();
  const up = "http://127.0.0.1:" + upstream.address().port;
  const gw = "http://127.0.0.1:" + gateway.address().port;

  process.env.UPSTREAM_BASE_URL = up;
  process.env.UPSTREAM_API_KEY = "sk-upstream-test";
  process.env.CLIENT_KEYS = "ck-alpha,ck-beta";
  process.env.MODEL_ALIASES = JSON.stringify({ "deepseek:free": "deepseek-chat", "my-model": "deepseek-reasoner" });
  delete process.env.UPSTREAM_MODELS;
  delete process.env.FILTER_FREE;

  await check("GET /healthz -> 200 ok", async () => {
    const r = await get(gw, "/healthz");
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    assert.strictEqual(j.status, "ok");
  });

  await check("OPTIONS 预检 -> 204 + CORS 头", async () => {
    const r = await fetch(gw + "/v1/chat/completions", { method: "OPTIONS" });
    assert.strictEqual(r.status, 204);
    assert.strictEqual(r.headers.get("access-control-allow-origin"), "*");
  });

  await check("chat 无密钥 -> 401", async () => {
    const r = await post(gw, "/v1/chat/completions", { model: "deepseek-chat", messages: [{ role: "user", content: "hi" }] });
    assert.strictEqual(r.status, 401);
  });

  await check("chat 密钥错误 -> 401", async () => {
    const r = await post(gw, "/v1/chat/completions", { model: "x", messages: [] }, { authorization: "Bearer wrong" });
    assert.strictEqual(r.status, 401);
  });

  await check("非流式转发 + 别名解析 -> 200", async () => {
    const r = await post(gw, "/v1/chat/completions", { model: "deepseek:free", messages: [{ role: "user", content: "ping" }] }, { authorization: "Bearer ck-alpha" });
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    assert.strictEqual(j.model, "deepseek-chat");
    assert.strictEqual(j.choices[0].message.content, "pong");
  });

  await check("SSE 流式转发 -> 200 + data: [DONE]", async () => {
    const r = await post(gw, "/v1/chat/completions", { model: "my-model", stream: true, messages: [{ role: "user", content: "ping" }] }, { authorization: "Bearer ck-beta" });
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get("content-type"), /text\/event-stream/);
    const text = await r.text();
    assert.ok(text.includes('"model":"deepseek-reasoner"'), "别名应作用于流式响应: " + text.slice(0, 200));
    assert.ok(text.includes("data: [DONE]"), "应收到结束标记");
  });

  await check("chat GET -> 405", async () => {
    const r = await get(gw, "/v1/chat/completions", { authorization: "Bearer ck-alpha" });
    assert.strictEqual(r.status, 405);
  });

  await check("models 静态配置 (UPSTREAM_MODELS) -> 指定列表", async () => {
    process.env.UPSTREAM_MODELS = "deepseek-chat,deepseek-reasoner";
    try {
      const r = await get(gw, "/v1/models", { authorization: "Bearer ck-alpha" });
      assert.strictEqual(r.status, 200);
      const j = await r.json();
      assert.deepStrictEqual(j.data.map((m) => m.id), ["deepseek-chat", "deepseek-reasoner"]);
    } finally {
      delete process.env.UPSTREAM_MODELS;
    }
  });

  await check("models 透传上游 -> 4 个", async () => {
    const r = await get(gw, "/v1/models", { authorization: "Bearer ck-alpha" });
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    assert.strictEqual(j.data.length, 4);
  });

  await check("models FILTER_FREE=1 -> 只留免费", async () => {
    process.env.FILTER_FREE = "1";
    try {
      const r = await get(gw, "/v1/models", { authorization: "Bearer ck-alpha" });
      const j = await r.json();
      assert.deepStrictEqual(j.data.map((m) => m.id), ["deepseek:free"]);
    } finally {
      delete process.env.FILTER_FREE;
    }
  });

  await check("models 无密钥 -> 401", async () => {
    const r = await get(gw, "/v1/models");
    assert.strictEqual(r.status, 401);
  });

  gateway.close();
  upstream.close();
  console.log("");
  if (failures > 0) {
    console.log(failures + " test(s) FAILED");
    process.exit(1);
  }
  console.log("ALL TESTS PASSED");
}

main().catch((e) => { console.error(e); process.exit(1); });
