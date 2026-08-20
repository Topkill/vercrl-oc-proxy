"use strict";

const { handlePreflight } = require("../lib/relay");

/** GET /healthz — 健康检查 (供 Vercel 探活与外部监控) */
module.exports = async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  res.writeHead(200, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
  res.end(JSON.stringify({ status: "ok" }));
};
