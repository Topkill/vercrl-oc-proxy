# Relay Desk — Vercel 核心网关部署

> 只移植了 opencode 需要的**核心请求**: `POST /v1/chat/completions`(含 SSE 流式)、`GET /v1/models`、`GET /healthz`。
> 不包含管理台 / 代理池 / Resin / 统计 / 告警。全部配置走环境变量, 零依赖, 无外部存储。

## 目录结构

```
api/
  healthz.js                  # GET /healthz
  v1/
    chat/completions.js       # POST /v1/chat/completions (流式转发)
    models.js                 # GET /v1/models
lib/
  relay.js                    # 共享逻辑: 环境变量 / 鉴权 / 别名 / 端点拼接
vercel.json                   # 路由与函数配置
```

## 部署步骤

1. 把本仓库导入 Vercel (Import Project)。
   - Framework Preset 选 **Other** (仓库自带 `vercel.json` 已设 `"framework": null`)。
   - Root Directory 保持仓库根目录。
2. 在 Project → Settings → Environment Variables 配置(必填项):

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `UPSTREAM_BASE_URL` | 否 | 上游 Base URL, 默认 `https://opencode.ai/zen`; 如 `https://api.deepseek.com` (带不带 `/v1` 均可) |
| `UPSTREAM_API_KEY` | 否 | 上游 API Key。**可留空**: 为空时不再报 500, 而是把客户端请求里的 `Authorization` 头原样透传给上游 (适合 `https://opencode.ai/zen` 这类免 key 或沿用客户端 key 的场景) |
| `CLIENT_KEYS` | 否 | 逗号分隔的客户端密钥, 空 = 不鉴权; opencode 用它作为 apiKey |
| `MODEL_ALIASES` | 否 | JSON 别名表, 如 `{"deepseek:free":"deepseek-chat"}` |
| `UPSTREAM_MODELS` | 否 | 逗号分隔或 JSON 数组的模型列表; 设置后 `/v1/models` 直接返回它, 不再请求上游 |
| `FILTER_FREE` | 否 | `1`/true 时 `/v1/models` 只保留免费模型(id 以 `:free`/`-free` 结尾或 pricing 为零) |

3. Deploy。部署完成后:

```text
https://<your-project>.vercel.app/v1/chat/completions
https://<your-project>.vercel.app/v1/models
https://<your-project>.vercel.app/healthz
```

## opencode 客户端接入

在 opencode 的 provider 配置中加一个 OpenAI-compatible 上游:

```json
{
  "provider": {
    "relay": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Relay Desk (Vercel)",
      "options": {
        "baseURL": "https://<your-project>.vercel.app/v1",
        "apiKey": "<CLIENT_KEYS 里的某一个>"
      },
      "models": { "deepseek:free": { "name": "DeepSeek Free" } }
    }
  }
}
```

随后 `opencode --provider relay -m deepseek:free` 即可使用。请求中的 `model` 会先经 `MODEL_ALIASES` 解析再转发上游。

## 验证

部署后先测连通性:

```bash
curl https://<your-project>.vercel.app/healthz
curl https://<your-project>.vercel.app/v1/models -H "Authorization: Bearer <client-key>"
curl https://<your-project>.vercel.app/v1/chat/completions \
  -H "Authorization: Bearer <client-key>" -H "Content-Type: application/json" \
  -d '{"model":"deepseek:free","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

## 本地运行与测试

```bash
UPSTREAM_BASE_URL=https://api.deepseek.com UPSTREAM_API_KEY=sk-xxx CLIENT_KEYS=ck1 \
  npx vercel dev            # 本地起 Vercel 环境
# 或直接跑冒烟测试 (mock 上游, 无需真实密钥):
node scripts/vercel-gateway-test.cjs
```

## 限制与注意事项

- **函数时长**: `vercel.json` 里 chat 函数 `maxDuration: 60`(Hobby 上限, 需启用 Fluid Compute; Pro 可到 300)。
  长流式对话可能超过上限被截断, 建议 Pro 计划。
- **无状态**: 不做用量统计/客户端密钥轮换, 密钥通过环境变量管理, 修改后重新部署生效。
- **区域**: 建议把项目 Region 设置在离上游较近的区域以减少时延。
- 本目录不影响原有 Docker / Go 自托管部署, 两者可并存。
