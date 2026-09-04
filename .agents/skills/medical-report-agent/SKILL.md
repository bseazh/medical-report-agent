# Medical Report Agent 本地运行 Skill

## 目的
检查并启动 `medical-report-agent`，验证 Node.js、环境变量和本地端口；禁止把 API 密钥写入源码、前端或 Git。

## 配置

```bash
cp .env.example .env
chmod 600 .env
```

变量：`MINERU_API_TOKEN`、`MINERU_API_URL`、`DEEPSEEK_API_KEY`、`DEEPSEEK_API_URL`、`DEEPSEEK_MODEL`、`PORT`。

## 检查与启动

```bash
node --version
test -f server.mjs && test -f index.html && test -f app.js
node --env-file=.env server.mjs
curl -fsS http://localhost:${PORT:-4173}/ >/dev/null
```

浏览器访问 `http://localhost:${PORT:-4173}`。端口占用时使用 `PORT=4174`，不要使用宽泛的 kill 命令。

## MVP 调试顺序

先无密钥确认本地 PDF.js；再接 MinerU PDF 解析；再接 DeepSeek 文本摘要；之后增加视觉模型截图解析、项目目录、人工审核、矩阵和 PPT 导出。

## 安全

只记录项目 ID、模型名、状态和错误摘要，不记录 Token、Key、完整病例原文或完整请求体。远程同步只同步代码、PRD 和脱敏样例，不同步 `.env` 与真实病例资料。
