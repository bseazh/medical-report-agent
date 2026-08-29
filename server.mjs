import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 4173);
const mineruToken = process.env.MINERU_API_TOKEN || "";
const deepseekKey = process.env.DEEPSEEK_API_KEY || "";

async function jsonBody(req) {
  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > 28 * 1024 * 1024) throw new Error("请求超过 28 MB"); }
  return JSON.parse(raw);
}

async function callMinerU(pdfBase64, fileName, config = {}) {
  const token = config.token || mineruToken; if (!token || !pdfBase64) return { text: "", skipped: true };
  const endpoint = config.url || process.env.MINERU_API_URL || "https://mineru.net/api/v1/file-urls/batch-upload";
  const form = new FormData();
  form.append("files", new Blob([Buffer.from(pdfBase64, "base64")], { type: "application/pdf" }), fileName || "report.pdf");
  const response = await fetch(endpoint, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
  if (!response.ok) throw new Error(`MinerU 返回 ${response.status}`);
  const payload = await response.json();
  return { text: payload?.data?.text || payload?.data?.markdown || payload?.text || "", payload };
}

async function callDeepSeek(text, fileName, config = {}) {
  const key = config.key || deepseekKey; if (!key) return null;
  const base = (config.url || "https://api.deepseek.com").replace(/\/$/, "");
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: "deepseek-chat", temperature: 0.2, response_format: { type: "json_object" }, messages: [
      { role: "system", content: "你是医学报告信息整理助手。只能基于原文整理，不做诊断、不推荐药物。输出严格 JSON，字段为 summary(string), findings(array of {title,detail,high}), guidance(array of string), disclaimer(string)。用简体中文，清楚标注不确定性。" },
      { role: "user", content: `文件：${fileName}\n请分析以下医学报告文本：\n${text.slice(0, 50000)}` },
    ] }),
  });
  if (!response.ok) throw new Error(`DeepSeek 返回 ${response.status}`);
  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content || "{}";
  return JSON.parse(content);
}

function send(res, status, body) { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }); res.end(JSON.stringify(body)); }
async function handler(req, res) {
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (req.method === "POST" && req.url === "/api/analyze") {
    try {
      const body = await jsonBody(req); const localText = String(body.text || ""); const fileName = String(body.fileName || "report.pdf"); const config = body.config || {};
      if (!localText && !body.pdfBase64) return send(res, 400, { error: "缺少 PDF 内容" });
      let mineru = { text: "", skipped: true }; let mineruError = "";
      try { mineru = await callMinerU(body.pdfBase64, fileName, config.mineru); } catch (error) { mineruError = error.message; }
      const sourceText = mineru.text || localText;
      let ai = null; let aiError = "";
      try { ai = await callDeepSeek(sourceText, fileName, config.deepseek); } catch (error) { aiError = error.message; }
      return send(res, 200, { text: sourceText, ai, meta: { mineru: !mineru.skipped && !mineruError, mineruError, deepseek: Boolean(ai), deepseekError: aiError } });
    } catch (error) { return send(res, 400, { error: error.message || "分析请求失败" }); }
  }
  if (req.method === "POST" && req.url === "/api/test-connection") {
    try { const body = await jsonBody(req); const service = body.service; const cfg = body.config || {}; if (service === "deepseek") { if (!cfg.key) return send(res, 400, { error: "请填写 DeepSeek API Key" }); const base = (cfg.url || "https://api.deepseek.com").replace(/\/$/, ""); const r = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${cfg.key}` } }); if (!r.ok) throw new Error(`DeepSeek 返回 ${r.status}`); return send(res, 200, { ok: true, message: "DeepSeek 连接成功" }); } if (service === "mineru") { if (!cfg.token) return send(res, 400, { error: "请填写 MinerU Token" }); const r = await fetch(cfg.url || "https://mineru.net", { headers: { Authorization: `Bearer ${cfg.token}` } }); if (!r.ok && r.status !== 404) throw new Error(`MinerU 返回 ${r.status}`); return send(res, 200, { ok: true, message: "MinerU 服务可访问" }); } return send(res, 400, { error: "未知服务" }); } catch (error) { return send(res, 502, { error: error.message || "连接失败" }); }
  }
  const path = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  try { const file = await readFile(join(root, path)); const type = extname(path) === ".html" ? "text/html" : extname(path) === ".css" ? "text/css" : "text/javascript"; res.writeHead(200, { "Content-Type": `${type}; charset=utf-8` }); res.end(file); } catch { res.writeHead(404); res.end("Not found"); }
}
http.createServer(handler).listen(port, () => console.log(`医见服务已启动: http://localhost:${port}`));
