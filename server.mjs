import http from "node:http";
import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createReadStream } from "node:fs";
const execFileAsync = promisify(execFile);

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 4173);
const mineruToken = process.env.MINERU_API_TOKEN || "";
const deepseekKey = process.env.DEEPSEEK_API_KEY || "";
const dataRoot = process.env.DATA_ROOT || join(root, "data", "projects");
const safe = (s) => String(s).replace(/[^\w\u4e00-\u9fff.-]+/g, "_").slice(0, 80);
async function projectDir(id){ const d=join(dataRoot,safe(id)); await mkdir(join(d,"source","screenshots"),{recursive:true}); await mkdir(join(d,"source","pdfs"),{recursive:true}); await mkdir(join(d,"parsed"),{recursive:true}); return d; }
async function logAction(id, action, detail={}){ const d=await projectDir(id), f=join(d,"audit-log.jsonl"); await writeFile(f, JSON.stringify({at:new Date().toISOString(),action,detail})+"\n",{flag:"a"}); }
async function listProjects(){ await mkdir(dataRoot,{recursive:true}); const out=[]; for(const id of await readdir(dataRoot)){try{const d=await projectDir(id),p=JSON.parse(await readFile(join(d,"project.json")));out.push(p)}catch{}} return out.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)); }

async function jsonBody(req) {
  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > 28 * 1024 * 1024) throw new Error("请求超过 28 MB"); }
  return JSON.parse(raw);
}

async function callMinerU(pdfBase64, fileName, config = {}) {
  const token = config.token || mineruToken; if (!token || !pdfBase64) return { text: "", skipped: true };
  const configuredBase = config.baseUrl || config.url || process.env.MINERU_API_BASE_URL || "https://mineru.net/api/v4";
  const base = configuredBase.replace(/\/file-urls\/(?:batch-upload|batch)\/?$/, "").replace(/\/api\/v1\/?$/, "/api/v4").replace(/\/$/, "");
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const create = await fetch(`${base}/file-urls/batch`, { method: "POST", headers, body: JSON.stringify({ files: [{ name: fileName || "report.pdf", is_ocr: false }] }) });
  if (!create.ok) throw new Error(`MinerU task create ${create.status}`);
  const created = await create.json(); const data = created.data || created; const batchId = data.batch_id || data.batchId || data.id;
  const urls = data.file_urls || data.fileUrls || []; const uploadUrl = Array.isArray(urls) ? urls[0] : urls[fileName] || Object.values(urls)[0];
  if (!batchId || !uploadUrl) throw new Error("MinerU response missing batch_id or upload URL");
  const upload = await fetch(uploadUrl, { method: "PUT", body: Buffer.from(pdfBase64, "base64") }); if (!upload.ok) throw new Error(`MinerU file upload ${upload.status}`);
  let result = null; const timeout = Date.now() + Number(config.timeoutMs || process.env.MINERU_TIMEOUT_MS || 180000);
  while (Date.now() < timeout) { const poll = await fetch(`${base}/extract-results/batch/${encodeURIComponent(batchId)}`, { headers: { Authorization: `Bearer ${token}` } }); if (!poll.ok) throw new Error(`MinerU task status ${poll.status}`); const payload = await poll.json(); const rows = payload.data?.extract_result || payload.data?.results || payload.data || []; const row = Array.isArray(rows) ? (rows[0] || {}) : (rows[fileName] || Object.values(rows)[0] || {}); const state = String(row.state || row.status || payload.data?.status || "").toLowerCase(); if (["done","success","completed","succeeded"].includes(state) || row.full_zip_url || row.fullZipUrl || row.download_url) { result = { ...payload, row }; break; } if (["failed","error"].includes(state)) throw new Error(`MinerU task failed: ${row.err_msg || row.error || state}`); await new Promise(r => setTimeout(r, 3000)); }
  if (!result) throw new Error("MinerU task timeout");
  const zipUrl = result.row.full_zip_url || result.row.fullZipUrl || result.row.download_url || result.row.url; if (!zipUrl) return { text: result.row.markdown || result.row.text || "", pages: [], payload: result };
  const zipPath = join(dataRoot, `.mineru-${Date.now()}.zip`); const zip = await fetch(zipUrl); if (!zip.ok) throw new Error(`MinerU result download ${zip.status}`); await writeFile(zipPath, Buffer.from(await zip.arrayBuffer())); const outDir = `${zipPath}.dir`; await mkdir(outDir, { recursive: true }); await execFileAsync("unzip", ["-oq", zipPath, "-d", outDir]);
  const { stdout: files } = await execFileAsync("find", [outDir, "-type", "f"]); const pageFiles = files.split("\n").filter(x => /\.md$|\.json$/i.test(x)).sort(); const pages = []; for (const file of pageFiles) { const text = await readFile(file, "utf8"); pages.push({ file: file.replace(`${outDir}/`, ""), text, page: pages.length + 1 }); }
  await rm(zipPath, { force: true }); await rm(outDir, { recursive: true, force: true }); return { text: pages.map(x => `\n[Page ${x.page}]\n${x.text}`).join("\n"), pages, payload: result };
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
async function callVision(imageBase64, fileName, config = {}) { const key=config.key||deepseekKey;if(!key)return null;const base=(config.url||process.env.DEEPSEEK_API_URL||"https://api.deepseek.com").replace(/\/$/,"");const model=config.model||process.env.DEEPSEEK_VISION_MODEL||"deepseek-v4-flash-vision-exp";const r=await fetch(`${base}/chat/completions`,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${key}`},body:JSON.stringify({model,temperature:0,response_format:{type:"json_object"},messages:[{role:"system",content:"Extract only visible facts from this clinic screenshot. Return strict JSON with patient, history, symptoms, allergies, medications, visits, diagnosis, timeline. Missing or uncertain values must be null and reviewStatus must be 待人工确认. Never guess."},{role:"user",content:[{type:"text",text:`File: ${fileName}`},{type:"image_url",image_url:{url:`data:image/png;base64,${imageBase64}`}}]}]})});if(!r.ok)throw new Error(`Vision model ${r.status}`);const j=await r.json();return {model,raw:j,structured:JSON.parse(j.choices?.[0]?.message?.content||"{}")}; }
function parseReportType(name,text){const s=`${name} ${text}`;if(/肠道菌群|宏基因组/.test(s))return"gut-microbiome";if(/食物不耐受|food.?intolerance/i.test(s))return"food-intolerance";if(/营养与毒性元素|头发/.test(s))return"nutrient-toxic-elements";if(/肠道功能健康评估|GI Function/.test(s))return"gi-function";return"unknown"}
function extractStructuredIndicators(pages,fileName,type){const out=[];for(const pg of pages||[]){for(const line of String(pg.text||"").split(/\n|。/).map(x=>x.trim()).filter(Boolean)){const m=line.match(/([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9（）()\-]{1,30})\s*[:：]?\s*([<>≤≥]?\s*\d+(?:\.\d+)?)\s*([A-Za-zμ%/]+)?(?:\s*(?:参考值|参考范围)\s*[:：]?\s*([<>]?\s*\d+(?:\.\d+)?(?:\s*[-~至]\s*\d+(?:\.\d+)?|\s*[A-Za-zμ%/]+)?))?/);if(!m)continue;out.push({name:m[1],value:m[2],unit:m[3]||null,reference:m[4]||null,status:/(偏高|偏低|异常|升高|降低|超标|阳性|↑|↓)/.test(line)?"异常":"待确认",reviewStatus:"待审核",reportType:type,raw:line.slice(0,300),source:{file:fileName,page:pg.page}});if(out.length>=500) return out;}}return out}

function send(res, status, body) { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }); res.end(JSON.stringify(body)); }
async function handler(req, res) {
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (req.method === "GET" && req.url === "/api/projects") return send(res,200,{projects:await listProjects()});
  if (req.method === "POST" && req.url === "/api/projects") { const b=await jsonBody(req), now=new Date().toISOString(), id=`project-${Date.now()}`, p={id,name:String(b.name||"未命名项目"),patientName:"",status:"未开始",createdAt:now,updatedAt:now,files:[]}; const d=await projectDir(id); await writeFile(join(d,"project.json"),JSON.stringify(p,null,2)); await logAction(id,"project.create",{name:p.name}); return send(res,201,p); }
  const pm=req.url.match(/^\/api\/projects\/([^/]+)$/); if(pm && req.method==="DELETE"){const id=pm[1]; await rm(join(dataRoot,safe(id)),{recursive:true,force:true}); return send(res,200,{ok:true});}
  const pu=req.url.match(/^\/api\/projects\/([^/]+)\/upload$/); if(pu && req.method==="POST"){const id=pu[1],b=await jsonBody(req),d=await projectDir(id),original=String(b.name||"file"),kind=String(b.kind||"").toLowerCase(),dir=kind==="pdf"||original.toLowerCase().endsWith(".pdf")?"pdfs":"screenshots";let name=safe(original),n=1;while(true){try{await readFile(join(d,"source",dir,name));name=`${name.replace(/(\.[^.]+)?$/,"")}-${n++}${name.match(/\.[^.]+$/)?.[0]||""}`}catch{break}} await writeFile(join(d,"source",dir,name),Buffer.from(String(b.base64||""),"base64")); const p=JSON.parse(await readFile(join(d,"project.json"))); p.files=[...(p.files||[]),{name,originalName:original,kind:dir,status:"待解析",queueStatus:"queued",size:Number(b.size||0),uploadedAt:new Date().toISOString()}];p.updatedAt=new Date().toISOString();await writeFile(join(d,"project.json"),JSON.stringify(p,null,2));await logAction(id,"file.upload",{name,kind:dir});return send(res,201,{ok:true,file:p.files.at(-1)});}
  const fd=req.url.match(/^\/api\/projects\/([^/]+)\/files\/([^/]+)$/); if(fd && req.method==="DELETE"){const id=fd[1],name=decodeURIComponent(fd[2]),d=await projectDir(id),p=JSON.parse(await readFile(join(d,"project.json")));const f=(p.files||[]).find(x=>x.name===name);if(f)await rm(join(d,"source",f.kind,name),{force:true});p.files=(p.files||[]).filter(x=>x.name!==name);p.updatedAt=new Date().toISOString();await writeFile(join(d,"project.json"),JSON.stringify(p,null,2));await logAction(id,"file.delete",{name});return send(res,200,{ok:true});}
  const raw=req.url.match(/^\/api\/projects\/([^/]+)\/files\/([^/]+)\/raw$/); if(raw && req.method==="GET"){const d=await projectDir(raw[1]),p=JSON.parse(await readFile(join(d,"project.json"))),requested=decodeURIComponent(raw[2]),f=(p.files||[]).find(x=>x.name===requested||x.originalName===requested);if(!f)return send(res,404,{error:"File not found"});const filePath=join(d,"source",f.kind,f.name);res.writeHead(200,{"Content-Type":f.kind==="pdfs"?"application/pdf":"application/octet-stream","Content-Disposition":`inline; filename*=UTF-8''${encodeURIComponent(f.name)}`,"Content-Length":String(f.size||0)});const stream=createReadStream(filePath);stream.on("error",error=>{if(!res.headersSent)return send(res,404,{error:error.message});res.destroy(error)});stream.pipe(res);return}
  const fr=req.url.match(/^\/api\/projects\/([^/]+)\/files\/([^/]+)$/); if(fr && req.method==="GET"){const id=fr[1],name=decodeURIComponent(fr[2]),d=await projectDir(id),p=JSON.parse(await readFile(join(d,"project.json"))),f=(p.files||[]).find(x=>x.name===name||x.originalName===name);if(!f)return send(res,404,{error:"File not found"});let parsed=null;try{parsed=JSON.parse(await readFile(join(d,"parsed",`${safe(name)}.json`)))}catch{}return send(res,200,{file:f,parsed,reviewed:p.reviewed||{},indicators:p.indicators||[]});}
  const cr=req.url.match(/^\/api\/projects\/([^/]+)\/case$/); if(cr && req.method==="GET"){const d=await projectDir(cr[1]),p=JSON.parse(await readFile(join(d,"project.json")));return send(res,200,{caseData:p.caseData||{patient:{},history:{},indicators:[],sources:[]},reviewed:p.reviewed||false});}
  if(cr && req.method==="PUT"){const d=await projectDir(cr[1]),b=await jsonBody(req),p=JSON.parse(await readFile(join(d,"project.json")));p.caseData=b.caseData||{};p.reviewed=Boolean(b.reviewed);p.status=p.reviewed?"已确认":"待审核";p.updatedAt=new Date().toISOString();await writeFile(join(d,"project.json"),JSON.stringify(p,null,2));await logAction(cr[1],p.reviewed?"case.reviewed":"case.updated",{reviewed:p.reviewed});return send(res,200,{ok:true,caseData:p.caseData,reviewed:p.reviewed});}
  const ir=req.url.match(/^\/api\/projects\/([^/]+)\/indicators$/); if(ir && req.method==="POST"){const d=await projectDir(ir[1]),p=JSON.parse(await readFile(join(d,"project.json"))),items=[];const dims=[['肠道|菌群|消化|吸收','同化代谢'],['免疫|炎症|IgE|过敏','防御与修护'],['毒性|元素|铅|汞|钛|锡','代谢转换与消除'],['锌|硒|镁|钾|营养','营养和水分'],['能量|线粒体|代谢','能量生成'],['皮肤|屏障|甲|骨','结构完整性'],['神经|乙酰胆碱|多巴胺|睡眠','传递系统']];for(const f of p.files||[]){try{const x=JSON.parse(await readFile(join(d,"parsed",`${safe(f.name)}.json`)));const pages=x.pages||[{page:null,text:x.text||''}];for(const pg of pages){const lines=String(pg.text||'').split(/\n|。/).map(s=>s.trim()).filter(Boolean);for(const line of lines){const m=line.match(/([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9（）()\-]{1,30})\s*[:：]?\s*([<>≤≥]?\s*\d+(?:\.\d+)?(?:\s*[A-Za-zμ%/]+)?)/);if(!m)continue;const status=/(偏高|升高|超标|阳性|异常|↑|重度|中度)/.test(line)?'异常':'待确认';const dim=dims.find(([re])=>new RegExp(re,'i').test(line))?.[1]||'待分类';items.push({name:m[1],value:m[2],raw:line.slice(0,240),status,reviewStatus:'待审核',dimension:dim,source:{file:f.originalName||f.name,page:pg.page,locator:`page-${pg.page||'?'}`}});if(items.length>=300)break}if(items.length>=300)break} }catch{}}p.indicators=items;p.updatedAt=new Date().toISOString();await writeFile(join(d,"project.json"),JSON.stringify(p,null,2));await logAction(ir[1],"indicators.extracted",{count:items.length,paged:true});return send(res,200,{indicators:items});}
  if(ir && req.method==="PUT"){const d=await projectDir(ir[1]),b=await jsonBody(req),p=JSON.parse(await readFile(join(d,"project.json")));p.indicators=Array.isArray(b.indicators)?b.indicators:[];p.updatedAt=new Date().toISOString();await writeFile(join(d,"project.json"),JSON.stringify(p,null,2));await logAction(ir[1],"indicators.reviewed",{count:p.indicators.length});return send(res,200,{ok:true,indicators:p.indicators});}
  const mr=req.url.match(/^\/api\/projects\/([^/]+)\/matrix$/); if(mr && req.method==="GET"){const d=await projectDir(mr[1]),p=JSON.parse(await readFile(join(d,"project.json"))),dims=["前置因素","诱发因素","介质因素","同化代谢","代谢转换与消除","结构完整性","防御与修护","传递系统","传输系统","能量生成","睡眠与放松","运动与活动","营养和水分","压力","人际社交关系"];return send(res,200,{dimensions:dims.map(name=>({name,items:(p.indicators||[]).filter(x=>x.reviewStatus==="已确认"&&x.dimension===name),assessment:(p.indicators||[]).some(x=>x.reviewStatus==="已确认"&&x.dimension===name)?"Confirmed indicators available":"No confirmed indicators"}))});}
  const rr=req.url.match(/^\/api\/projects\/([^/]+)\/files\/([^/]+)\/retry$/); if(rr && req.method==="POST"){const id=rr[1],name=decodeURIComponent(rr[2]),d=await projectDir(id),p=JSON.parse(await readFile(join(d,"project.json")));p.files=(p.files||[]).map(f=>f.name===name?{...f,status:"处理中",queueStatus:"queued",retryAt:new Date().toISOString()}:f);p.updatedAt=new Date().toISOString();await writeFile(join(d,"project.json"),JSON.stringify(p,null,2));await logAction(id,"file.retry",{name});return send(res,200,{ok:true});}
  if (req.method === "POST" && req.url === "/api/analyze") {
    try {
      const body = await jsonBody(req); const localText = String(body.text || ""); const fileName = String(body.fileName || "report.pdf"); const config = body.config || {};
      if(body.projectId){const d=await projectDir(body.projectId),p=JSON.parse(await readFile(join(d,"project.json")));p.files=(p.files||[]).map(f=>f.name===fileName||f.originalName===fileName?{...f,status:"处理中",queueStatus:"processing"}:f);p.updatedAt=new Date().toISOString();await writeFile(join(d,"project.json"),JSON.stringify(p,null,2));}
      if (!localText && !body.pdfBase64) return send(res, 400, { error: "缺少 PDF 内容" });
      let mineru = { text: "", skipped: true }; let mineruError = "";
      try { mineru = await callMinerU(body.pdfBase64, fileName, config.mineru); } catch (error) { mineruError = error.message; }
      const sourceText = mineru.text || localText;
      let ai = null; let aiError = "";
      try { ai = await callDeepSeek(sourceText, fileName, config.deepseek); } catch (error) { aiError = error.message; }
      const reportType=parseReportType(fileName,sourceText);const structuredIndicators=extractStructuredIndicators(mineru.pages||[],fileName,reportType);if(body.projectId){const d=await projectDir(body.projectId),p=JSON.parse(await readFile(join(d,"project.json")));await writeFile(join(d,"parsed",`${safe(fileName)}.json`),JSON.stringify({fileName,reportType,text:sourceText,pages:mineru.pages||[],structuredIndicators,ai,meta:{mineru:!mineru.skipped&&!mineruError,mineruError,deepseek:Boolean(ai),deepseekError:aiError}},null,2));p.files=(p.files||[]).map(f=>f.name===fileName||f.originalName===fileName?{...f,status:mineruError?"失败":"已完成",queueStatus:mineruError?"failed":"completed",parsedAt:new Date().toISOString(),error:mineruError||undefined}:f);p.updatedAt=new Date().toISOString();await writeFile(join(d,"project.json"),JSON.stringify(p,null,2));await logAction(body.projectId,"analysis.saved",{fileName,reportType,indicatorCount:structuredIndicators.length});}
      return send(res, 200, { text: sourceText, ai, meta: { mineru: !mineru.skipped && !mineruError, mineruError, deepseek: Boolean(ai), deepseekError: aiError } });
    } catch (error) { return send(res, 400, { error: error.message || "分析请求失败" }); }
  }
  if(req.method==="POST"&&req.url==="/api/analyze-image"){try{const b=await jsonBody(req),v=await callVision(b.imageBase64,b.fileName||"screenshot.png",b.config?.deepseek||{});if(b.projectId){const d=await projectDir(b.projectId);await writeFile(join(d,"parsed",`${safe(b.fileName||"screenshot")}.vision.json`),JSON.stringify(v,null,2));await logAction(b.projectId,"vision.saved",{fileName:b.fileName})}return send(res,200,v)}catch(e){return send(res,400,{error:e.message})}}
  if (req.method === "POST" && req.url === "/api/test-connection") {
    try { const body = await jsonBody(req); const service = body.service; const cfg = body.config || {}; if (service === "deepseek") { if (!cfg.key) return send(res, 400, { error: "请填写 DeepSeek API Key" }); const base = (cfg.url || "https://api.deepseek.com").replace(/\/$/, ""); const r = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${cfg.key}` } }); if (!r.ok) throw new Error(`DeepSeek 返回 ${r.status}`); return send(res, 200, { ok: true, message: "DeepSeek 连接成功" }); } if (service === "mineru") { if (!cfg.token) return send(res, 400, { error: "请填写 MinerU Token" }); const r = await fetch(cfg.url || "https://mineru.net", { headers: { Authorization: `Bearer ${cfg.token}` } }); if (!r.ok && r.status !== 404) throw new Error(`MinerU 返回 ${r.status}`); return send(res, 200, { ok: true, message: "MinerU 服务可访问" }); } return send(res, 400, { error: "未知服务" }); } catch (error) { return send(res, 502, { error: error.message || "连接失败" }); }
  }
  const path = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  try { const file = await readFile(join(root, path)); const type = extname(path) === ".html" ? "text/html" : extname(path) === ".css" ? "text/css" : "text/javascript"; res.writeHead(200, { "Content-Type": `${type}; charset=utf-8` }); res.end(file); } catch { res.writeHead(404); res.end("Not found"); }
}
http.createServer((req,res)=>handler(req,res).catch(error=>{console.error(error);if(!res.headersSent)send(res,500,{error:"Internal server error"});else res.destroy()})).listen(port, () => console.log(`医见服务已启动: http://localhost:${port}`));
