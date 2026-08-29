# 医见 · 医学报告分析 Agent

一个医学报告 PDF 分析 Agent。浏览器先用 PDF.js 提取文本，Node 服务端可调用 MinerU 做解析增强，再调用 DeepSeek 生成摘要、异常说明和就医沟通准备清单。

## 本地预览

推荐启动带 API 代理的版本：

```bash
cp .env.example .env
# 在 .env 中填写 MINERU_API_TOKEN 和 DEEPSEEK_API_KEY
node --env-file=.env server.mjs
```

然后访问 <http://localhost:4173>。

## 部署说明

`server.mjs` 同时托管静态页面和 `/api/analyze` 接口。密钥只在服务端环境变量中使用，绝不要写入 `index.html` 或 `app.js`。部署到 Vercel/Netlify 时，将同样的接口迁移为 Serverless Function，并配置环境变量。生产版本还应增加脱敏、访问控制、审计和专业医学审核流程。
