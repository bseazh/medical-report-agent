import http from "node:http";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createReadStream } from "node:fs";
import { createRequire } from "node:module";
const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const PptxGenJS = require("pptxgenjs");
const sharp = require("sharp");
import { buildReportPages, renderReport } from "./report-layout.mjs";
import { moduleRegistry, legacySuggestionRules } from "./src/modules/module-registry.mjs";
import { createMatrixWorkspace, matrixSections, matrixCoreFields, MATRIX_REVIEW_STATUSES, normalizeMatrixWorkspace } from "./src/matrix/matrix-registry.mjs";
import { renderMatrixSvg } from "./src/matrix/render.mjs";
import { humanizeMatrixFact } from "./src/matrix/labels.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
try { process.loadEnvFile(join(root, ".env")); }
catch (error) { if (error.code !== "ENOENT") throw error; }
const port = Number(process.env.PORT || 4173);
const mineruToken = process.env.MINERU_API_TOKEN || "";
const deepseekKey = process.env.DEEPSEEK_API_KEY || "";
const dataRoot = process.env.DATA_ROOT || join(root, "data", "projects");
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 20 * 1024 * 1024);
const MATRIX_DIMENSIONS = ["前置因素","诱发因素","介质因素","同化代谢","代谢转换与消除","结构完整性","防御与修护","传递系统","传输系统","能量生成","睡眠与放松","运动与活动","营养和水分","压力","人际社交关系","待分类"];
const SUGGESTION_RULES = legacySuggestionRules;
const safe = (s) => String(s).replace(/[^\w\u4e00-\u9fff.-]+/g, "_").slice(0, 80);
async function projectDir(id){ const d=join(dataRoot,safe(id)); await mkdir(join(d,"source","screenshots"),{recursive:true}); await mkdir(join(d,"source","pdfs"),{recursive:true}); await mkdir(join(d,"parsed"),{recursive:true}); return d; }
function redactSecrets(value){const text=JSON.stringify(value??{});return JSON.parse(text.replace(/sk-[A-Za-z0-9_-]{12,}/g,"[REDACTED_API_KEY]"));}
async function logAction(id, action, detail={}){ const d=await projectDir(id), f=join(d,"audit-log.jsonl"); await writeFile(f, JSON.stringify({at:new Date().toISOString(),action,detail:redactSecrets(detail)})+"\n",{flag:"a"}); }
async function loadProject(id) {
  const d = await projectDir(id);
  try { return { d, p: JSON.parse(await readFile(join(d, "project.json"))) }; }
  catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) {
      const missing = new Error("项目不存在或项目数据已损坏，请从项目列表重新打开"); missing.statusCode = 404; throw missing;
    }
    throw error;
  }
}
async function listProjects(){ await mkdir(dataRoot,{recursive:true}); const out=[]; for(const id of await readdir(dataRoot)){try{const d=await projectDir(id),p=JSON.parse(await readFile(join(d,"project.json")));out.push(p)}catch{}} return out.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)); }

async function jsonBody(req) {
  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > 28 * 1024 * 1024) throw new Error("请求超过 28 MB"); if (raw.length > MAX_UPLOAD_BYTES * 1.4 + 1024 * 1024) throw new Error(`上传请求超过 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB 文件限制`); }
  return JSON.parse(raw);
}
async function validatePdfFile(filePath){
  const {stdout}=await execFileAsync("pdfinfo",[filePath]);
  if(/Encrypted:\s+yes/i.test(stdout)) throw new Error("加密 PDF 暂不支持，请上传未加密文件");
  if(!/Pages:\s+\d+/i.test(stdout)) throw new Error("PDF 文件无法读取页数");
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
async function callDeepSeekModule(module, indicators, project, config = {}) {
  const key = config.key || deepseekKey;
  if (!key) throw new Error("未配置 DeepSeek API Key，请在设置中填写后再生成建议");
  const promptPath = join(root, module.promptFile);
  let modulePrompt = "";
  try { modulePrompt = await readFile(promptPath, "utf8"); } catch { modulePrompt = module.commonRules.join("\n"); }
  const base = (config.url || process.env.DEEPSEEK_API_URL || "https://api.deepseek.com").replace(/\/$/, "");
  const model = config.model || process.env.DEEPSEEK_MODEL || "deepseek-chat";
  const input = { module: { id: module.id, title: module.title, requiredInputs: module.requiredInputs }, caseData: project.caseData || {}, confirmedIndicators: indicators };
  const response = await fetch(base + "/chat/completions", { method:"POST", headers:{"Content-Type":"application/json",Authorization:"Bearer " + key}, body:JSON.stringify({model,temperature:0.2,response_format:{type:"json_object"},messages:[{role:"system",content:modulePrompt + "\n\n通用规则：\n" + module.commonRules.join("\n")},{role:"user",content:JSON.stringify(input)}]}) });
  if (!response.ok) throw new Error("DeepSeek 返回 " + response.status);
  const payload = await response.json();
  const parsed = JSON.parse(payload?.choices?.[0]?.message?.content || "{}");
  const actions = Array.isArray(parsed.actions) ? parsed.actions : [];
  const suggestions = Array.isArray(parsed.suggestions) ? parsed.suggestions : actions.map(action => ({category:action.category || "建议调整",type:module.legacyRule?.type || "其他",title:action.title || module.title,content:action.text || action.content || "",basis:parsed.evidence || []}));
  return { moduleId: module.id, moduleTitle: module.title, status: parsed.status || (suggestions.length ? "draft" : "missing_data"), title: parsed.title || module.title, summary: parsed.summary || "", actions, evidence: Array.isArray(parsed.evidence) ? parsed.evidence : [], reviewFlags: Array.isArray(parsed.reviewFlags) ? parsed.reviewFlags : [], reviewStatus: "待审核", suggestions, model };
}
async function callDeepSeekSuggestions(indicators, templateSuggestions = [], config = {}, project = {}) {
  const modules = moduleRegistry.filter(module => module.legacyRule);
  const moduleResults = [];
  for (const module of modules) {
    try { moduleResults.push(await callDeepSeekModule(module, indicators, project, config)); }
    catch (error) { moduleResults.push({moduleId:module.id,moduleTitle:module.title,status:"missing_data",title:module.title,summary:"",actions:[],evidence:[],reviewFlags:[error.message],reviewStatus:"待补充",suggestions:[],model:null}); }
  }
  return { model: moduleResults.find(x => x.model)?.model || config.model || process.env.DEEPSEEK_MODEL || "deepseek-chat", modules: moduleResults, suggestions: moduleResults.flatMap(result => result.suggestions.map(item => ({...item,module:result.moduleTitle,sourceModuleId:result.moduleId}))), combinationAnalysis: [] };
}
async function callVision(imageBase64, fileName, config = {}) {
  const key=config.key||deepseekKey;
  if(!key) throw new Error("未配置 DeepSeek API Key");
  const base=(config.url||process.env.DEEPSEEK_VISION_API_URL||process.env.DEEPSEEK_API_URL||"https://api.deepseek.com").replace(/\/$/,"");
  const model=config.model||process.env.DEEPSEEK_VISION_MODEL||"deepseek-v4-flash-vision-exp";
  const mime=/\.jpe?g$/i.test(fileName)?"image/jpeg":"image/png";
  const payload={model,temperature:0,messages:[{role:"system",content:"你是诊所截图信息整理助手。只提取截图中明确可见的事实，返回严格 JSON，不要 Markdown 代码块。字段包括 patient、history、symptoms、allergies、medications、visits、diagnosis、timeline。无法确认的字段使用空字符串或空数组，不要猜测。"},{role:"user",content:[{type:"text",text:"请识别这张诊所功能矩阵相关截图："+fileName},{type:"image_url",image_url:{url:"data:"+mime+";base64,"+imageBase64}}]}]};
  const response=await fetch(base+"/chat/completions",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+key},body:JSON.stringify(payload)});
  const body=await response.text();
  if(!response.ok) throw new Error("Vision model "+response.status+(body?": "+body.slice(0,500):""));
  let result;try{result=JSON.parse(body)}catch{throw new Error("视觉模型返回的不是 JSON 响应")}
  const content=result?.choices?.[0]?.message?.content;
  const text=Array.isArray(content)?content.map(item=>item?.text||"").join(""):String(content||"");
  const cleaned=text.replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/i,"").trim();
  let structured;try{structured=JSON.parse(cleaned)}catch{throw new Error("视觉模型内容不是可解析的 JSON")}
  return {model,raw:result,structured};
}

function visionField(key = "") {
  const value = String(key).toLowerCase().replace(/[._\-\d]/g, "");
  if (/主要问题|主诉|chiefcomplaint/.test(value)) return "chiefComplaint";
  if (/现病|经过|presentillness/.test(value)) return "presentIllness";
  if (/症状|表现|symptoms?/.test(value)) return "symptoms";
  if (/时间线|timeline|病程/.test(value)) return "timeline";
  if (/家族|familyhistory/.test(value)) return "familyHistory";
  if (/既往|past history|pasthistory/.test(value)) return "pastHistory";
  if (/过敏|allerg/.test(value)) return "allergies";
  if (/接触|暴露|exposure/.test(value)) return "exposures";
  if (/食物|foodreaction/.test(value)) return "foodReactions";
  if (/诊断|diagnos/.test(value)) return "diagnosis";
  if (/用药|药物|medication/.test(value)) return "medications";
  if (/睡眠|sleep/.test(value)) return "sleep";
  if (/运动|锻炼|exercise/.test(value)) return "exercise";
  if (/活动|activity/.test(value)) return "activity";
  if (/饮食|diet/.test(value)) return "diet";
  if (/饮水|water/.test(value)) return "water";
  if (/营养|nutrition/.test(value)) return "nutrition";
  if (/压力|stress/.test(value)) return "stress";
  if (/人际|社交|social/.test(value)) return "social";
  if (/支持|关系|relationship/.test(value)) return "relationships";
  if (/病史|history/.test(value)) return "history";
  if (/就诊|visits?/.test(value)) return "history";
  return "history";
}

function readVisionSource(d, file) {
  const directories = file.kind === "screenshot" ? ["screenshots", "screenshot"] : [file.kind, "screenshots"];
  return (async () => {
    for (const directory of [...new Set(directories)]) {
      try { return await readFile(join(d, "source", directory, file.name)); } catch {}
    }
    throw new Error(`截图文件不存在：${file.originalName || file.name}`);
  })();
}

async function callMatrixText(text, config = {}) { const key=config.key||deepseekKey;if(!key)throw new Error("未配置 DeepSeek API Key");const prompt=await readFile(join(root,"prompts/matrix-functional.v1.md"),"utf8");const base=(config.url||process.env.DEEPSEEK_API_URL||"https://api.deepseek.com").replace(/\/$/,"");const response=await fetch(base+"/chat/completions",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+key},body:JSON.stringify({model:config.model||"deepseek-chat",temperature:0,response_format:{type:"json_object"},messages:[{role:"system",content:prompt},{role:"user",content:String(text).slice(0,50000)}]})});if(!response.ok)throw new Error("DeepSeek 返回 "+response.status);const payload=await response.json();return JSON.parse(payload?.choices?.[0]?.message?.content||"{}");}
function parseReportType(name,text){const s=`${name} ${text}`;if(/肠道菌群|宏基因组/.test(s))return"gut-microbiome";if(/食物不耐受|food.?intolerance/i.test(s))return"food-intolerance";if(/营养与毒性元素|头发/.test(s))return"nutrient-toxic-elements";if(/肠道功能健康评估|GI Function/.test(s))return"gi-function";return"unknown"}
function extractStructuredIndicators(pages,fileName,type){const out=[];for(const pg of pages||[]){for(const line of String(pg.text||"").split(/\n|。/).map(x=>x.trim()).filter(Boolean)){const m=line.match(/([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9（）()\-]{1,30})\s*[:：]?\s*([<>≤≥]?\s*\d+(?:\.\d+)?)\s*([A-Za-zμ%/]+)?(?:\s*(?:参考值|参考范围)\s*[:：]?\s*([<>]?\s*\d+(?:\.\d+)?(?:\s*[-~至]\s*\d+(?:\.\d+)?|\s*[A-Za-zμ%/]+)?))?/);if(!m)continue;const abnormal=/(偏高|偏低|异常|升高|降低|超标|阳性|↑|↓|重度|中度|轻度)/.test(line);const level=/(显著异常|重度|中度|轻度)/.exec(line)?.[1]||null;out.push({name:m[1],value:m[2],unit:m[3]||null,reference:m[4]||null,status:abnormal?"异常":"正常",severity:level|| (abnormal?"异常":"正常"),reviewStatus:"待审核",reportType:type,raw:line.slice(0,300),source:{file:fileName,page:pg.page}});if(out.length>=500) return out;}}return out}
function extractKeyConclusions(pages,type,fileName){const lines=(pages||[]).flatMap(pg=>String(pg.text||'').split(/\n|。/).map(x=>({text:x.trim(),page:pg.page}))).filter(x=>x.text&&/(结论|结 果|提示|评估|印象|建议|阳性|异常|风险)/.test(x.text));return lines.slice(0,20).map(x=>({text:x.text.slice(0,500),source:{file:fileName,page:x.page},reportType:type}));}

function classifyIndicators(items){const noise=/^(采检日期|检测日期|报告日期|年龄|性别|姓名|电话|编号|页码|说明|备注|单位|参考|项目)$/;const filtered=items.filter(item=>item.name.length>1&&!noise.test(item.name)&&!/^20\d{2}$/.test(item.value));const groups=new Map();for(const item of filtered){const key=item.name.replace(/[（）()\s]/g,"").toLowerCase();const group=groups.get(key)||[];group.push(item);groups.set(key,group)}return filtered.map(item=>{const key=item.name.replace(/[（）()\s]/g,"").toLowerCase(),group=groups.get(key)||[],values=new Set(group.map(x=>`${x.value}|${x.unit||""}`));return {...item,duplicate:group.length>1,conflict:values.size>1,severity:item.status==="异常"?"异常":"未见明显异常"}})}
function suggestionBasis(indicator){return {name:indicator.name,value:indicator.value,unit:indicator.unit||null,reference:indicator.reference||null,source:indicator.source||{}}}
function buildSuggestions(project, mode="A") {
  const confirmed=(project.indicators||[]).filter(x=>x.reviewStatus!=="已排除");
  const abnormal=confirmed.filter(x=>x.status==="异常"||x.severity&&x.severity!=="未见明显异常");
  const text=abnormal.map(x=>`${x.name} ${x.value||""} ${x.raw||""}`).join(" ");
  const hasFood=/食物|不耐受|过敏|IgE|敏感/i.test(text),hasGut=/肠道|菌群|消化|吸收|便/i.test(text),hasToxic=/毒性|铅|汞|镉|砷|元素/i.test(text),hasNutrient=/维生素|矿物质|锌|硒|镁|铁|营养/i.test(text);
  const basis=abnormal.slice(0,8).map(suggestionBasis),sources=[...new Map(basis.map(x=>[`${x.source.file}|${x.source.page}`,x.source])).values()],suggestions=[];
  const add=(category,type,title,content,when=true,module="")=>{if(when){const definition=moduleRegistry.find(item=>item.title===module);suggestions.push({id:`suggestion-${Date.now()}-${suggestions.length}`,sourceType:"template",mode,module,sourceModuleId:definition?.id||module,category,type,title,content,editableContent:content,basis,sources,trigger:{module,rule:SUGGESTION_RULES.find(x=>x.module===module)?.when||"已确认指标"},reviewStatus:"待审核"})}};
  if(mode!=="C") add("必须回避","饮食","先暂停明确提示敏感/不耐受的食物","在人工复核敏感等级、症状关联和替代食物前，暂时回避报告中明确标记为显著异常的相关食物；不要自行扩大忌口范围。",hasFood,"饮食回避");
  add("必须回避","营养支持","避免自行使用高剂量补充剂","在毒性元素或营养异常未完成专业复核前，不自行叠加同类补充剂或高剂量产品；本建议不包含剂量。",hasToxic||hasNutrient,"营养支持");
  add("建议调整","饮食","建立可追踪的饮食与症状记录","连续记录饮食、症状和排便变化，配合专业人员评估，优先选择未提示异常且耐受良好的食物。",hasFood||hasGut,"饮食回避");
  add("建议调整","饮食","食物替代：优先选择耐受良好的同类食物","在确认敏感源后，使用营养结构相近且未提示异常的食物进行替代；具体清单需人工审核。",hasFood,"替代方案");
  add("可选建议","饮食","每餐饮食：保持蛋白质、蔬菜和主食的基本结构","根据个体耐受情况安排规律三餐，优先使用已确认可接受的食材，避免自行扩大限制范围。",hasFood||hasGut||abnormal.length>0,"一日饮食");
  add("建议调整","运动","采用循序渐进的活动安排","从低至中等强度、可耐受的活动开始，根据症状和专业意见逐步调整；出现不适时停止并咨询医生。",abnormal.length>0,"身体活动");
  add("建议调整","饮水","保持规律饮水并记录变化","分散到全天饮水，结合活动量、天气和医生意见调整；如有饮水限制，以专业人员要求为准。",abnormal.length>0,"科学饮水");
  add("建议调整","减压","加入每日可执行的放松安排","安排短时呼吸练习、规律作息或低负荷放松活动，并记录睡眠、压力与症状变化，供后续复核；如焦虑或失眠明显影响生活，应寻求专业帮助。",hasGut||abnormal.length>1,"睡眠与减压");
  add("可选建议","饮食","优先从日常饮食补足多样性","在确认指标和饮食耐受范围后，优先通过多样化食物获得营养；是否需要补充剂由医生或营养师决定。",hasNutrient||hasGut||abnormal.length>0,"一日饮食");
  add("建议调整","营养","建立均衡营养记录","在已确认耐受范围内记录三餐、蛋白质、蔬菜、水果和膳食纤维摄入，避免因回避食物造成饮食过度单一；具体目标由专业人员确认。",hasFood||hasGut||hasNutrient,"均衡营养");
  add("建议调整","能量","记录能量摄入与晨起精力","保持相对规律的进食时间，连续记录每日能量摄入、晨起精力和运动后恢复情况，先观察变化再由专业人员调整方案。",hasNutrient||hasGut||abnormal.length>0,"能量调节");
  add("建议调整","神经与内分泌","记录睡眠、压力与用药相关变化","记录入睡时间、睡眠质量、晨起状态和压力变化；如正在使用助眠或其他长期药物，任何调整均需先咨询开药医生。",hasGut||abnormal.length>0,"神经递质与内分泌");
  add("可选建议","阶段计划","生成阶段性健康管理草案","先核对明确的回避或暴露因素，再进行饮食结构、能量、睡眠和活动等基础调整，之后根据复查结果动态调整；不自动生成药物或补充剂剂量。",abnormal.length>0,"阶段干预");
  add("建议调整","复查","建立复查前后的对照记录","在复查前记录症状、饮食耐受、排便、睡眠、压力、活动量和执行困难；复查后仅依据专业人员确认的项目比较变化，不自行解读单项结果。",abnormal.length>0,"复查与动态调整");
  if(mode==="C") suggestions.forEach(x=>{x.category="可选建议";x.content=`保守版本：${x.content} 暂不据此作出长期饮食限制或补充剂决定。`;x.editableContent=x.content});
  if(mode==="B") suggestions.forEach(x=>{x.content=`个性化组合：${x.content} 请结合其他已确认指标、病例背景和症状时间线进行人工调整。`;x.editableContent=x.content});
  const modules = moduleRegistry.filter(module => module.legacyRule).map(module => {
    const items = suggestions.filter(item => item.module === module.title);
    return {moduleId:module.id,moduleTitle:module.title,status:items.length ? "draft" : "missing_data",title:module.title,summary:items.length ? `${items.length} 条待审核建议` : "当前资料不足，暂不生成本模块建议。",actions:items,evidence:basis,reviewFlags:items.length ? [] : ["缺少该模块的明确输入"],reviewStatus:"待审核",suggestions:items};
  });
  return {generatedAt:new Date().toISOString(),mode,modeLabel:{A:"标准模板",B:"个性化组合",C:"保守建议"}[mode],ruleCatalog:SUGGESTION_RULES,basedOnIndicatorCount:confirmed.length,confirmedAbnormalCount:abnormal.length,combinationAnalysis:abnormal.length>=2?[{title:"多个已确认异常需要联合评估",detail:`当前有 ${abnormal.length} 条已确认异常指标，建议结合症状、时间线和来源页码进行人工综合判断，不将单项结果视为诊断。`,indicators:abnormal.slice(0,12).map(suggestionBasis),sources}]:[],modules,suggestions,disclaimer:"建议仅基于已确认指标生成草稿，不构成诊断、治疗或用药建议；必须人工审核后才可进入 PPT。"};
}
const runningProjects = new Set();
function indicatorSuggestion(indicator){const suggestions={"food-intolerance":"结合症状记录与医生或营养师复核，不要仅凭单项结果长期扩大忌口范围。","nutrient-toxic-elements":"结合参考范围、症状和其他检查复核；补充剂类型与剂量需由专业人员确认。","gut-microbiome":"结合消化道症状和临床评估复核，不依据单项菌群结果自行治疗。","gi-function":"建议结合消化症状、饮食记录和医生评估，必要时由医生确定复查项目。"};return suggestions[indicator.reportType]||"请结合症状、既往史和医生意见复核，不根据单一指标自行诊断或用药。"}
async function analyzeStoredPdf(projectId,file){const d=await projectDir(projectId),pdf=await readFile(join(d,"source",file.kind==="screenshot"?"screenshots":file.kind,file.name));let mineruError="",mineru={text:"",pages:[]};try{mineru=await callMinerU(pdf.toString("base64"),file.name,{})}catch(error){mineruError=error.message}const sourceText=mineru.text||"",reportType=parseReportType(file.originalName||file.name,sourceText),structuredIndicators=extractStructuredIndicators(mineru.pages||[],file.originalName||file.name,reportType);await writeFile(join(d,"parsed",`${safe(file.name)}.json`),JSON.stringify({fileName:file.originalName||file.name,reportType,text:sourceText,pages:mineru.pages||[],structuredIndicators,meta:{mineru:!mineruError,mineruError}},null,2));const p=JSON.parse(await readFile(join(d,"project.json")));p.files=(p.files||[]).map(item=>item.name===file.name?{...item,status:mineruError?"失败":"已完成",queueStatus:mineruError?"failed":"completed",parsedAt:new Date().toISOString(),error:mineruError||undefined}:item);p.updatedAt=new Date().toISOString();await saveProject(d,p);await logAction(projectId,"analysis.file.completed",{fileName:file.name,ok:!mineruError,indicatorCount:structuredIndicators.length})}
async function buildProjectSummary(projectId){const d=await projectDir(projectId),p=JSON.parse(await readFile(join(d,"project.json"))),indicators=[];for(const file of p.files||[]){if(file.kind!=="pdfs")continue;try{const parsed=JSON.parse(await readFile(join(d,"parsed",`${safe(file.name)}.json`)));indicators.push(...(parsed.structuredIndicators||[]))}catch{}}const merged=new Map();for(const item of indicators){const key=`${item.name}|${item.value}|${item.source?.file}`;const current=merged.get(key);if(!current)merged.set(key,{...item,sourcePages:item.source?.page==null?[]:[item.source.page]});else{if(item.source?.page!=null&&!current.sourcePages.includes(item.source.page))current.sourcePages.push(item.source.page);if(item.status==="异常")current.status="异常";}}const unique=[...merged.values()],abnormal=unique.filter(item=>item.status==="异常");const findings=abnormal.map(item=>({source:item.source||{},reportType:item.reportType||"unknown",title:`${item.name} ${item.value}${item.unit?` ${item.unit}`:""}`,detail:`${item.raw||"报告标记异常"}；来源：${item.source?.file||"未知文件"}，第 ${(item.sourcePages||[item.source?.page||"?"]).join("、")} 页。${indicatorSuggestion(item)}`,high:true}));const completed=(p.files||[]).filter(file=>file.kind==="pdfs"&&file.status==="已完成").length,total=(p.files||[]).filter(file=>file.kind==="pdfs").length;return {file:`${p.name}·项目综合分析`,summary:`已汇总 ${completed}/${total} 份 PDF，提取 ${unique.length} 条候选指标，其中 ${abnormal.length} 条被报告原文标记为异常。所有结果仍需人工核对原文和页码后才能进入矩阵与 PPT。`,fields:[{label:"报告数量",value:`${completed}/${total} 份已完成`},{label:"候选指标",value:`${unique.length} 项`},{label:"异常候选",value:`${abnormal.length} 项`},{label:"审核状态",value:"待人工审核"}],values:unique.slice(0,20),findings,guidance:["先核对每条异常项的指标值、单位、参考范围、文件名和页码。","将异常项与症状、既往史及其他检查结果联合评估，避免孤立解读。","饮食、运动、饮水、减压和营养支持建议需经人工审核；暂不自动生成药物或补充剂剂量。"],analyzedAt:new Date().toISOString()}}
async function analyzeProject(projectId){runningProjects.add(projectId);try{const d=await projectDir(projectId),p=JSON.parse(await readFile(join(d,"project.json"))),pending=(p.files||[]).filter(file=>file.kind==="pdfs"&&file.status!=="已完成");p.status="处理中";p.files=(p.files||[]).map(file=>pending.some(item=>item.name===file.name)?{...file,status:"处理中",queueStatus:"queued"}:file);p.updatedAt=new Date().toISOString();await saveProject(d,p);for(const file of pending)await analyzeStoredPdf(projectId,file);const summary=await buildProjectSummary(projectId),latest=JSON.parse(await readFile(join(d,"project.json")));latest.analysisSummary=summary;latest.status=(latest.files||[]).some(file=>file.kind==="pdfs"&&file.status==="失败")?"失败":"待审核";latest.updatedAt=new Date().toISOString();await writeFile(join(d,"project.json"),JSON.stringify(latest,null,2));await writeFile(join(d,"parsed","project-summary.json"),JSON.stringify(summary,null,2));await logAction(projectId,"analysis.project.completed",{pdfCount:(latest.files||[]).filter(file=>file.kind==="pdfs").length,abnormalCount:summary.findings.length})}finally{runningProjects.delete(projectId)}}

function send(res, status, body) { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }); res.end(JSON.stringify(body)); }
async function runPptQa(filePath, slideCount) {
  const warnings = [];
  try {
    const { stdout } = await execFileAsync("unzip", ["-p", filePath, "ppt/slides/slide*.xml"]);
    const text = String(stdout || "");
    if (!text.trim()) warnings.push("未读取到幻灯片 XML 内容");
    const longRuns = (text.match(/<a:t>[^<]{180,}<\/a:t>/g) || []).length;
    if (longRuns) warnings.push(`发现 ${longRuns} 个超长文本片段，建议人工检查文字溢出`);
  } catch (error) { warnings.push(`无法完成结构检查：${error.message}`); }
  try {
    const outDir = `${filePath}.qa`;
    await mkdir(outDir, { recursive: true });
    await execFileAsync("soffice", ["--headless", "--convert-to", "pdf", "--outdir", outDir, filePath], { timeout: 90000 });
    const pdfName = filePath.replace(/^.*[\\/]/, "").replace(/\.pptx$/i, ".pdf");
    try { const stat = await import("node:fs/promises").then(m => m.stat(join(outDir, pdfName))); if (!stat.size) warnings.push("LibreOffice 转换后 PDF 为空"); } catch { warnings.push("未生成可预览 PDF，无法完成页面级渲染检查"); }
    await rm(outDir, { recursive: true, force: true });
  } catch (error) { warnings.push(`页面渲染检查不可用：${error.message}`); }
  return { status: warnings.length ? "warning" : "passed", warnings, checkedAt: new Date().toISOString(), slideCount };
}
function synthesisVersion(p) {
  const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==="object"?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
  return createHash("sha256").update(JSON.stringify(stable({patientName:p.patientName||"",caseData:p.caseData||{},reviewed:p.reviewed||false,indicators:p.indicators||[],suggestions:p.suggestions?.suggestions||[],combinations:p.suggestions?.combinationAnalysis||[],interventionPeriod:p.suggestions?.interventionPeriod||"",reviewPeriod:p.suggestions?.reviewPeriod||"",evidence:p.evidence?.evidence||[]}))).digest("hex");
}
function currentSynthesisReview(p) {
  const r=p.synthesisReview||{status:"待审核",note:"",version:0};
  return r.status==="已确认"&&r.dataVersion!==synthesisVersion(p)?{...r,status:"待审核",invalidatedReason:"资料变更或旧确认未绑定版本，请重新审核"}:r;
}
async function saveProject(d,p) {
  const review=currentSynthesisReview(p);
  if(p.synthesisReview&&review.status!==p.synthesisReview.status)p.synthesisReview={...review,invalidatedAt:new Date().toISOString()};
  await writeFile(join(d,"project.json"),JSON.stringify(p,null,2));
}
function dimensionAssessment(items) {
  if(!items.length)return {assessment:"无相关数据",assessmentStatus:"无相关数据"};
  if(items.some(x=>x.status==="异常"))return {assessment:"存在已确认异常指标，需结合原始报告进一步评估",assessmentStatus:"需关注"};
  if(items.every(x=>x.status==="正常"))return {assessment:"未见明显异常",assessmentStatus:"未见明显异常"};
  return {assessment:"指标正常/异常性质尚未明确",assessmentStatus:"待补充判断"};
}
function buildEvidenceDrafts(project) {
  const confirmed=(project.indicators||[]).filter(x=>x.reviewStatus==="已确认");
  const now=Date.now();
  return confirmed.map((x,i)=>({id:`evidence-${now}-${i}`,type:"指标证据",dimension:x.dimension||"待分类",claim:`${x.name} 的已确认结果支持关注“${x.dimension||"待分类"}”维度。`,reasoning:`依据指标值 ${x.value||"未填写"}${x.unit?` ${x.unit}`:""} 及其审核状态整理；这是一条信息整理依据，不代表临床诊断。`,indicatorIds:[x.id||x.name],indicators:[{name:x.name,value:x.value||"",unit:x.unit||null,status:x.status||"待确认"}],sources:x.source?[x.source]:[],sourceType:"rule",reviewStatus:"待审核",createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}));
}
function evidenceFor(project) { return (project.evidence?.evidence||[]).filter(x=>x.reviewStatus==="已确认"); }
function buildMatrixDraft(project) {
  const indicators=project.indicators||[]; const groups=new Map();
  for(const item of indicators){const key=item.dimension||"待分类";(groups.get(key)||groups.set(key,[]).get(key)).push(item);}
  return {status:"草稿",generatedAt:new Date().toISOString(),basedOnIndicatorCount:indicators.length,dimensions:[...groups].map(([name,items])=>({name,count:items.length,assessment:"基于候选指标生成，等待人工确认",assessmentStatus:"待审核",items,sources:[...new Map(items.map(x=>[`${x.source?.file}|${x.source?.page}`,x.source||{}])).values()]}))};
}

async function convertPptToPdf(pptxPath, pdfPath) {
  const outDir = join(pdfPath, "..");
  await mkdir(outDir, { recursive: true });
  const profile = `file://${join(dataRoot, `.lo-${Date.now()}-${Math.random().toString(16).slice(2)}`)}`;
  try {
    await execFileAsync("soffice", ["--headless", `-env:UserInstallation=${profile}`, "--convert-to", "pdf", "--outdir", outDir, pptxPath], { timeout: 120000 });
    const generated = join(outDir, pptxPath.replace(/^.*[\\/]/, "").replace(/\.pptx$/i, ".pdf"));
    const stat = await import("node:fs/promises").then(m => m.stat(generated));
    if (!stat.size) throw new Error("LibreOffice 生成的 PDF 为空");
    if (generated !== pdfPath) await import("node:fs/promises").then(m => m.rename(generated, pdfPath));
    return { ok: true, path: pdfPath, size: stat.size };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
async function generateProjectPpt(projectId){
  const d=await projectDir(projectId),p=JSON.parse(await readFile(join(d,"project.json")));
  const confirmed=(p.indicators||[]).filter(x=>x.reviewStatus==="已确认"),confirmedEvidence=evidenceFor(p),plan=p.approvedPlan||{status:"待审核",suggestions:[]},sugs=(plan.suggestions||[]).filter(x=>x.reviewStatus==="已确认");
  if((p.suggestions?.suggestions||[]).some(x=>!['已确认','已排除'].includes(x.reviewStatus))) throw new Error("仍有建议未完成审核，无法导出 PPT");
  if(plan.status!=="已确认") throw new Error("请先保存并确认全部建议，再生成 PPT");
  if(plan.dataVersion && plan.dataVersion!==synthesisVersion(p)) throw new Error("指标或建议已变更，请重新保存并确认建议");
  if(!sugs.length) throw new Error("没有已确认建议，无法导出 PPT");
  const exportProject={...p,approvedPlan:plan,suggestions:{...(p.suggestions||{}),suggestions:sugs}};
  const pages=buildReportPages(exportProject),pptx=renderReport(new PptxGenJS(),pages);
  const outName=`${safe(p.caseData?.patient?.name||p.patientName||"患者")}-健康改善指导方案-${Date.now()}.pptx`,outPath=join(d,"exports",outName);
  await mkdir(join(d,"exports"),{recursive:true}); await pptx.writeFile({fileName:outPath});
  const previewName=outName.replace(/\.pptx$/i,".pdf"),previewPath=join(d,"exports",previewName),preview=await convertPptToPdf(outPath,previewPath);
  const qa=await runPptQa(outPath,pages.length); if(!preview.ok)qa.warnings=[...(qa.warnings||[]),`PDF 预览未生成：${preview.error}`]; qa.preview=preview.ok?{name:previewName,size:preview.size}:null;
      const latest=JSON.parse(await readFile(join(d,"project.json")));
  if(synthesisVersion(latest)!==synthesisVersion(p)){await rm(outPath,{force:true});throw new Error("导出期间资料变更，请重新审核")}
  p.synthesisReview=latest.synthesisReview;p.exports=[...(p.exports||[]),{name:outName,createdAt:new Date().toISOString(),kind:"pptx",slideCount:pages.length,previewName:preview.ok?previewName:null,qa}];p.updatedAt=new Date().toISOString();await saveProject(d,p);await logAction(projectId,"ppt.exported",{name:outName,qa});return {name:outName,slideCount:pages.length,qa};
}
async function buildExportData(projectId){
  const d=await projectDir(projectId),p=JSON.parse(await readFile(join(d,"project.json")));
  const indicators=(p.indicators||[]).filter(x=>x.reviewStatus==="已确认");
  const suggestions=(p.suggestions?.suggestions||[]).filter(x=>x.reviewStatus==="已确认");
  const evidence=evidenceFor(p);
  const files=(p.files||[]).map(x=>({name:x.name,originalName:x.originalName,kind:x.kind,size:x.size,status:x.status,uploadedAt:x.uploadedAt,sourceDirectory:`source/${x.kind}`}));
  return {exportedAt:new Date().toISOString(),project:{id:p.id,name:p.name,patientName:p.patientName,status:p.status},caseData:p.caseData||{},indicators,suggestions,evidence,files,sourceDirectory:{pdfs:files.filter(x=>x.kind==="pdfs"),screenshots:files.filter(x=>x.kind==="screenshots")},disclaimer:"导出内容仅包含人工确认数据，不构成医疗诊断。"};
}
async function handler(req, res) {
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (req.method === "GET" && req.url === "/api/health") return send(res,200,{ok:true,service:"medical-report-agent",uptime:process.uptime(),mineruConfigured:Boolean(mineruToken),deepseekConfigured:Boolean(deepseekKey),maxUploadBytes:MAX_UPLOAD_BYTES});
  const kc=req.url.match(/^\/api\/projects\/([^/]+)\/key-conclusions$/); if(kc&&req.method==="GET"){const d=await projectDir(kc[1]),p=JSON.parse(await readFile(join(d,"project.json"))),out=[];for(const f of p.files||[]){if(f.kind!=="pdfs")continue;try{const path=join(d,"parsed",`${safe(f.name)}.json`),x=JSON.parse(await readFile(path));const items=x.keyConclusions||extractKeyConclusions(x.pages||[],x.reportType||"unknown",x.fileName||f.originalName||f.name);if(!x.keyConclusions){x.keyConclusions=items;await writeFile(path,JSON.stringify(x,null,2));}out.push(...items);}catch{}}return send(res,200,{keyConclusions:out});}
  const ej=req.url.match(/^\/api\/projects\/([^/]+)\/export-json$/); if(ej&&req.method==="GET"){return send(res,200,await buildExportData(ej[1]));}
  const sd=req.url.match(/^\/api\/projects\/([^/]+)\/source-directory$/); if(sd&&req.method==="GET"){const data=await buildExportData(sd[1]);return send(res,200,{project:data.project,sourceDirectory:data.sourceDirectory,generatedAt:data.exportedAt});}
  const eh=req.url.match(/^\/api\/projects\/([^/]+)\/exports$/); if(eh&&req.method==="GET"){const d=await projectDir(eh[1]),p=JSON.parse(await readFile(join(d,"project.json")));return send(res,200,{exports:p.exports||[]});}
  if (req.method === "GET" && req.url === "/api/projects") return send(res,200,{projects:await listProjects()});
  if (req.method === "POST" && req.url === "/api/projects") { const b=await jsonBody(req), now=new Date().toISOString(), id=`project-${Date.now()}`, p={id,name:String(b.name||"未命名项目"),patientName:"",status:"未开始",createdAt:now,updatedAt:now,files:[]}; const d=await projectDir(id); await saveProject(d,p); await logAction(id,"project.create",{name:p.name}); return send(res,201,p); }
  const pm=req.url.match(/^\/api\/projects\/([^/]+)$/); if(pm && req.method==="DELETE"){const id=pm[1]; await rm(join(dataRoot,safe(id)),{recursive:true,force:true}); return send(res,200,{ok:true});}
  const pu=req.url.match(/^\/api\/projects\/([^/]+)\/upload$/); if(pu && req.method==="POST"){const id=pu[1],b=await jsonBody(req),d=await projectDir(id),original=String(b.name||"file"),kind=String(b.kind||"").toLowerCase(),dir=kind==="pdf"||original.toLowerCase().endsWith(".pdf")?"pdfs":"screenshots";let name=safe(original),n=1;while(true){try{await readFile(join(d,"source",dir,name));name=`${name.replace(/(\.[^.]+)?$/,"")}-${n++}${name.match(/\.[^.]+$/)?.[0]||""}`}catch{break}} await writeFile(join(d,"source",dir,name),Buffer.from(String(b.base64||""),"base64")); const p=JSON.parse(await readFile(join(d,"project.json"))); p.files=[...(p.files||[]),{name,originalName:original,kind:dir,status:"待解析",queueStatus:"queued",size:Number(b.size||0),uploadedAt:new Date().toISOString()}];p.updatedAt=new Date().toISOString();await saveProject(d,p);await logAction(id,"file.upload",{name,kind:dir});return send(res,201,{ok:true,file:p.files.at(-1)});}
  const fd=req.url.match(/^\/api\/projects\/([^/]+)\/files\/([^/]+)$/); if(fd && req.method==="DELETE"){const id=fd[1],name=decodeURIComponent(fd[2]),d=await projectDir(id),p=JSON.parse(await readFile(join(d,"project.json")));const f=(p.files||[]).find(x=>x.name===name);if(f)await rm(join(d,"source",f.kind,name),{force:true});p.files=(p.files||[]).filter(x=>x.name!==name);p.updatedAt=new Date().toISOString();await saveProject(d,p);await logAction(id,"file.delete",{name});return send(res,200,{ok:true});}
  const raw=req.url.match(/^\/api\/projects\/([^/]+)\/files\/([^/]+)\/raw$/); if(raw && req.method==="GET"){const d=await projectDir(raw[1]),p=JSON.parse(await readFile(join(d,"project.json"))),requested=decodeURIComponent(raw[2]),f=(p.files||[]).find(x=>x.name===requested||x.originalName===requested);if(!f)return send(res,404,{error:"File not found"});const filePath=join(d,"source",f.kind,f.name);res.writeHead(200,{"Content-Type":f.kind==="pdfs"?"application/pdf":"application/octet-stream","Content-Disposition":`inline; filename*=UTF-8''${encodeURIComponent(f.name)}`,"Content-Length":String(f.size||0)});const stream=createReadStream(filePath);stream.on("error",error=>{if(!res.headersSent)return send(res,404,{error:error.message});res.destroy(error)});stream.pipe(res);return}
  const fr=req.url.match(/^\/api\/projects\/([^/]+)\/files\/([^/]+)$/); if(fr && req.method==="GET"){const id=fr[1],name=decodeURIComponent(fr[2]),d=await projectDir(id),p=JSON.parse(await readFile(join(d,"project.json"))),f=(p.files||[]).find(x=>x.name===name||x.originalName===name);if(!f)return send(res,404,{error:"File not found"});let parsed=null;try{parsed=JSON.parse(await readFile(join(d,"parsed",`${safe(name)}.json`)))}catch{}return send(res,200,{file:f,parsed,reviewed:p.reviewed||{},indicators:p.indicators||[]});}
  const cr=req.url.match(/^\/api\/projects\/([^/]+)\/case$/); if(cr && req.method==="GET"){const d=await projectDir(cr[1]),p=JSON.parse(await readFile(join(d,"project.json")));return send(res,200,{caseData:{...(p.caseData||{patient:{},history:{},sources:[]}),indicators:p.indicators||p.caseData?.indicators||[]},reviewed:p.reviewed||false});}
  if(cr && req.method==="PUT"){const d=await projectDir(cr[1]),b=await jsonBody(req),p=JSON.parse(await readFile(join(d,"project.json")));p.caseData=b.caseData||{};p.reviewed=Boolean(b.reviewed);p.status=p.reviewed?"已确认":"待审核";p.updatedAt=new Date().toISOString();await saveProject(d,p);await logAction(cr[1],p.reviewed?"case.reviewed":"case.updated",{reviewed:p.reviewed});return send(res,200,{ok:true,caseData:p.caseData,reviewed:p.reviewed});}
  const ir=req.url.match(/^\/api\/projects\/([^/]+)\/indicators$/); if(ir && req.method==="POST"){const d=await projectDir(ir[1]),p=JSON.parse(await readFile(join(d,"project.json"))),items=[];const dims=[['肠道|菌群|消化|吸收','同化代谢'],['免疫|炎症|IgE|过敏','防御与修护'],['毒性|元素|铅|汞|钛|锡','代谢转换与消除'],['锌|硒|镁|钾|营养','营养和水分'],['能量|线粒体|代谢','能量生成'],['皮肤|屏障|甲|骨','结构完整性'],['神经|乙酰胆碱|多巴胺|睡眠','传递系统']];for(const f of p.files||[]){try{const x=JSON.parse(await readFile(join(d,"parsed",`${safe(f.name)}.json`)));const pages=x.pages||[{page:null,text:x.text||''}];for(const pg of pages){const lines=String(pg.text||'').split(/\n|。/).map(s=>s.trim()).filter(Boolean);for(const line of lines){const m=line.match(/([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9（）()\-]{1,30})\s*[:：]?\s*([<>≤≥]?\s*\d+(?:\.\d+)?(?:\s*[A-Za-zμ%/]+)?)/);if(!m)continue;const status=/(偏高|升高|超标|阳性|异常|↑|重度|中度)/.test(line)?'异常':'待确认';const dim=dims.find(([re])=>new RegExp(re,'i').test(line))?.[1]||'待分类';items.push({name:m[1],value:m[2],raw:line.slice(0,240),status,reviewStatus:'待审核',dimension:dim,source:{file:f.originalName||f.name,page:pg.page,locator:`page-${pg.page||'?'}`}});if(items.length>=300)break}if(items.length>=300)break} }catch{}}p.indicators=items;p.updatedAt=new Date().toISOString();await saveProject(d,p);await logAction(ir[1],"indicators.extracted",{count:items.length,paged:true});return send(res,200,{indicators:items});}
  if(ir && req.method==="PUT"){const d=await projectDir(ir[1]),b=await jsonBody(req),p=JSON.parse(await readFile(join(d,"project.json")));p.indicators=Array.isArray(b.indicators)?b.indicators:[];p.updatedAt=new Date().toISOString();await saveProject(d,p);await logAction(ir[1],"indicators.reviewed",{count:p.indicators.length});return send(res,200,{ok:true,indicators:p.indicators});}
  const mwt=req.url.match(/^\/api\/projects\/([^/]+)\/matrix-workspace\/text$/); if(mwt&&req.method==="POST"){try{const b=await jsonBody(req),d=await projectDir(mwt[1]),p=JSON.parse(await readFile(join(d,"project.json"))),workspace=p.matrixWorkspace||createMatrixWorkspace(),parsed=await callMatrixText(b.text||"",b.config?.deepseek||{});let filledCoreCount=0;workspace.core=normalizeMatrixWorkspace(workspace).core;for(const item of parsed.core?.fields||[]){const field=workspace.core.fields.find(field=>field.id===item.id);const content=typeof item.content==="string"?humanizeMatrixFact(item.content).trim():"";if(!field||!content||field.content?.trim())continue;field.content=content;field.reviewStatus="待审核";field.sourceType="manual";filledCoreCount++;}const sectionFields={story:["chiefComplaint","presentIllness","symptoms","timeline","history"],antecedents:["familyHistory","pastHistory","allergies"],triggers:["exposures","foodReactions"],mediators:["diagnosis","medications","symptoms"],"sleep-relaxation":["sleep"],"exercise-activity":["exercise","activity"],"nutrition-water":["diet","water","nutrition"],stress:["stress"],"social-relationships":["social","relationships"]};
for(const result of parsed.sections||[]){const section=workspace.sections.find(x=>x.sectionId===result.sectionId);if(!section)continue;const allowed=sectionFields[result.sectionId]||["history"];const facts=(result.facts||[]).map((item,index)=>{const text=humanizeMatrixFact(item.text||item.content||item.answer||"").trim();return {...item,text,field:allowed.includes(item.field)?item.field:allowed[index%allowed.length],title:item.title||"病史资料",sourceType:"manual",reviewStatus:"待审核"};}).filter(item=>item.text);const answers=(result.suggestedAnswers||[]).map(answer=>{const text=humanizeMatrixFact(answer.answer||"").trim();return {questionId:answer.questionId,answer:text};}).filter(answer=>answer.answer);const answerFacts=answers.filter(answer=>!facts.some(fact=>fact.text===answer.answer)).map((answer,index)=>({field:allowed[index%allowed.length],title:"整理内容",text:answer.answer,sourceType:"manual",reviewStatus:"待审核"}));const merged=[...(section.candidateFacts||[]),...facts,...answerFacts];const seen=new Set();section.candidateFacts=merged.filter(item=>item.text&&!seen.has(item.text)&&(seen.add(item.text),true));section.interpretation=humanizeMatrixFact(result.interpretation||"").trim()||section.interpretation;for(const answer of answers){const question=section.questions.find(x=>x.id===answer.questionId);if(question&&!question.answer)question.answer=answer.answer;}}
const coreById=new Map((workspace.core.fields||[]).map(field=>[field.id,field]));for(const item of parsed.core?.fields||[]){const field=coreById.get(item.id);const content=humanizeMatrixFact(item.content||"").trim();if(field&&content&&!field.content){field.content=content;field.reviewStatus="待审核";field.sourceType="manual";}}Object.assign(workspace,normalizeMatrixWorkspace(workspace));workspace.updatedAt=new Date().toISOString();p.matrixWorkspace=workspace;p.updatedAt=workspace.updatedAt;await saveProject(d,p);return send(res,200,{ok:true,workspace,filledCoreCount,model:parsed.model||"deepseek-chat"})}catch(e){return send(res,400,{error:e.message||"文字稿整理失败"})}}
  const mwg=req.url.match(/^\/api\/projects\/([^/]+)\/matrix-workspace\/generate$/); if(mwg&&req.method==="POST"){try{const d=await projectDir(mwg[1]),p=JSON.parse(await readFile(join(d,"project.json"))),workspace=p.matrixWorkspace||createMatrixWorkspace(),sourceFiles=(p.files||[]).filter(x=>x.kind==="screenshots"||x.kind==="screenshot"),facts=[];for(const file of sourceFiles){let vision=null;try{vision=JSON.parse(await readFile(join(d,"parsed",safe(file.name)+".vision.json")))}catch{}if(!vision){try{vision=await callVision((await readVisionSource(d,file)).toString("base64"),file.name);if(vision)await writeFile(join(d,"parsed",safe(file.name)+".vision.json"),JSON.stringify(vision,null,2))}catch(error){file.status="识别失败";file.error=error.message;facts.push({title:"识别状态",field:"history",text:"截图识别失败："+error.message,source:{kind:"screenshot",file:file.originalName||file.name,page:null},reviewStatus:"需补充"});continue}}file.status="已识别";delete file.error;const structured=vision?.structured||{};const walk=(value,prefix="")=>{if(value===null||value===undefined||value==="")return;if(typeof value==="object"){for(const [key,item] of Object.entries(value))walk(item,prefix?prefix+"."+key:key);return}facts.push({title:prefix.split(".").pop(),text:humanizeMatrixFact(`${prefix} ${String(value)}`),field:visionField(prefix.split(".").pop()),source:{kind:"screenshot",file:file.originalName||file.name,page:null},reviewStatus:"待审核"})};walk(structured);}const caseData=p.caseData||{},history=caseData.history||{},patient=caseData.patient||{};const map={story:[history.chiefComplaint,history.presentIllness,history.symptoms,history.timeline],antecedents:[history.familyHistory,history.pastHistory,history.allergies],triggers:[history.exposures,history.foodReactions,history.presentIllness],mediators:[history.diagnosis,history.medications,history.symptoms],"sleep-relaxation":[history.sleep],"exercise-activity":[history.exercise],"nutrition-water":[history.diet,history.water],stress:[history.stress],"social-relationships":[history.social]};for(const section of workspace.sections){const values=(map[section.sectionId]||[]).filter(Boolean).map(String);const fields={story:["chiefComplaint","presentIllness","symptoms","history","timeline"],antecedents:["familyHistory","pastHistory","allergies"],triggers:["exposures","foodReactions"],mediators:["diagnosis","medications","symptoms"],"sleep-relaxation":["sleep"],"exercise-activity":["exercise","activity"],"nutrition-water":["diet","water","nutrition"],stress:["stress"],"social-relationships":["social","relationships"]};const allowed=fields[section.sectionId]||[];const sectionFacts=facts.filter(x=>x.text&&x.text!=="{}"&&allowed.includes(x.field));const uniqueFacts=new Map();for(const item of sectionFacts){const key=(item.field||"")+"|"+item.text;if(!uniqueFacts.has(key))uniqueFacts.set(key,item)}section.candidateFacts=[...values.map((text,index)=>({title:["主要问题","现病经过","症状表现","健康时间线"][index]||"病史资料",field:["chiefComplaint","presentIllness","symptoms","timeline"][index]||"history",text,sourceType:"case",reviewStatus:"待审核"})),...uniqueFacts.values()];if(values.length&&!section.questions.some(q=>q.answer))section.questions[0].answer=values.join("；");if(sectionFacts.length)section.interpretation=section.interpretation||"已从上传截图生成候选信息，请逐条核对。";section.sources=[...new Map(sectionFacts.map(x=>[x.source.file,x.source])).values()];}workspace.core=workspace.core||{central:"心理、精神、情绪",fields:matrixCoreFields.map(field=>({...field,content:"",reviewStatus:"待审核",sources:[]}))};workspace.core.fields=workspace.core.fields.map(field=>{const related=facts.filter(item=>{const text=item.text||"";return (field.id==="assimilation"&&/消化|吸收|肠道|菌群|排便/.test(text))||(field.id==="conversion"&&/肝|代谢|毒性|元素|排出/.test(text))||(field.id==="defense"&&/免疫|炎症|过敏|感染/.test(text))||(field.id==="energy"&&/疲劳|能量|线粒体|运动/.test(text))||(field.id==="transport"&&/循环|血液|血管|传输/.test(text))||(field.id==="signal"&&/神经|睡眠|情绪|压力/.test(text))||(field.id==="integrity"&&/皮肤|屏障|骨|结构/.test(text))});return related.length&&!field.content?{...field,content:related.slice(0,3).map(item=>item.text).join("；"),sources:[...new Map(related.map(item=>[item.source?.file,item.source])).values()]}:field});workspace=normalizeMatrixWorkspace(workspace);workspace.status="待审核";workspace.updatedAt=new Date().toISOString();p.matrixWorkspace=workspace;p.updatedAt=workspace.updatedAt;await saveProject(d,p);await logAction(mwg[1],"matrix-workspace.generated",{screenshotCount:sourceFiles.length,factCount:facts.length});return send(res,200,{ok:true,workspace,sourceFiles});}catch(e){return send(res,400,{error:e.message||"矩阵草稿生成失败"})}}
  const mwp=req.url.match(/^\/api\/projects\/([^/]+)\/matrix-workspace\/export-png$/); if(mwp&&req.method==="GET"){const d=await projectDir(mwp[1]),p=JSON.parse(await readFile(join(d,"project.json"))),svg=renderMatrixSvg(normalizeMatrixWorkspace(p.matrixWorkspace||createMatrixWorkspace()),p.caseData?.patient?.name||p.patientName||"患者"),png=await sharp(Buffer.from(svg)).png().toBuffer();res.writeHead(200,{"Content-Type":"image/png","Content-Disposition":"attachment; filename*=UTF-8\'\'functional-matrix.png","Content-Length":String(png.length)});return res.end(png)}
  const mwi=req.url.match(/^\/api\/projects\/([^/]+)\/matrix-workspace\/export-image$/); if(mwi&&req.method==="GET"){const d=await projectDir(mwi[1]),p=JSON.parse(await readFile(join(d,"project.json"))),svg=renderMatrixSvg(normalizeMatrixWorkspace(p.matrixWorkspace||createMatrixWorkspace()),p.caseData?.patient?.name||p.patientName||"患者");res.writeHead(200,{"Content-Type":"image/svg+xml; charset=utf-8","Content-Disposition":"attachment; filename*=UTF-8\'\'functional-matrix.svg"});return res.end(svg)}
  const mwe=req.url.match(/^\/api\/projects\/([^/]+)\/matrix-workspace\/export$/); if(mwe&&req.method==="GET"){const d=await projectDir(mwe[1]),p=JSON.parse(await readFile(join(d,"project.json")));return send(res,200,{exportedAt:new Date().toISOString(),project:{id:p.id,name:p.name,patientName:p.caseData?.patient?.name||p.patientName||""},workspace:normalizeMatrixWorkspace(p.matrixWorkspace||createMatrixWorkspace()),disclaimer:"功能矩阵为人工核对工作底稿，不构成诊断或治疗结论。"});}
  const mw=req.url.match(/^\/api\/projects\/([^/]+)\/matrix-workspace(?:\/sections\/([^/]+))?$/); if(mw&&req.method==="GET"){const d=await projectDir(mw[1]),p=JSON.parse(await readFile(join(d,"project.json")));if(!p.matrixWorkspace){p.matrixWorkspace=createMatrixWorkspace();}p.matrixWorkspace=normalizeMatrixWorkspace(p.matrixWorkspace);await saveProject(d,p);const sectionId=mw[2];return send(res,200,sectionId?{section:p.matrixWorkspace.sections.find(x=>x.sectionId===sectionId)||null,definitions:matrixSections}:{workspace:p.matrixWorkspace,definitions:matrixSections});}
  if(mw&&req.method==="PUT"){const d=await projectDir(mw[1]),b=await jsonBody(req),p=JSON.parse(await readFile(join(d,"project.json")));if(!p.matrixWorkspace)p.matrixWorkspace=createMatrixWorkspace();const sectionId=mw[2];if(sectionId){const index=p.matrixWorkspace.sections.findIndex(x=>x.sectionId===sectionId);if(index<0)return send(res,404,{error:"矩阵分区不存在"});const incoming=b.section||b;const old=p.matrixWorkspace.sections[index];p.matrixWorkspace.sections[index]={...old,...incoming,sectionId,reviewStatus:MATRIX_REVIEW_STATUSES.includes(incoming.reviewStatus)?incoming.reviewStatus:old.reviewStatus,updatedAt:new Date().toISOString()};}else if(b.workspace){p.matrixWorkspace={...p.matrixWorkspace,...b.workspace,core:b.workspace.core||p.matrixWorkspace.core,sections:Array.isArray(b.workspace.sections)?b.workspace.sections:p.matrixWorkspace.sections};}p.matrixWorkspace.status=p.matrixWorkspace.sections.every(x=>["已确认","已排除"].includes(x.reviewStatus))?"已确认":"待审核";p.matrixWorkspace.updatedAt=new Date().toISOString();p.updatedAt=p.matrixWorkspace.updatedAt;await saveProject(d,p);await logAction(mw[1],"matrix-workspace.saved",{sectionId:sectionId||"all",status:p.matrixWorkspace.status});return send(res,200,{ok:true,workspace:p.matrixWorkspace});}
  const mr=req.url.match(/^\/api\/projects\/([^/]+)\/matrix$/); if(mr&&req.method==="POST"){const d=await projectDir(mr[1]),p=JSON.parse(await readFile(join(d,"project.json")));if(!(p.indicators||[]).length)return send(res,400,{error:"暂无候选指标，请先完成报告解析和指标提取"});p.matrixDraft=buildMatrixDraft(p);p.updatedAt=new Date().toISOString();await saveProject(d,p);await logAction(mr[1],"matrix.draft.generated",{indicatorCount:p.indicators.length});return send(res,200,{ok:true,matrixDraft:p.matrixDraft});}
  const er=req.url.match(/^\/api\/projects\/([^/]+)\/evidence$/); if(er&&req.method==="GET"){const d=await projectDir(er[1]),p=JSON.parse(await readFile(join(d,"project.json"))),e=p.evidence||{version:0,evidence:[],generatedAt:null};return send(res,200,{...e,confirmed:evidenceFor(p)});}
  if(er&&req.method==="POST"){const d=await projectDir(er[1]),p=JSON.parse(await readFile(join(d,"project.json"))),drafts=buildEvidenceDrafts(p),existing=p.evidence?.evidence||[],existingKeys=new Set(existing.flatMap(x=>x.indicatorIds||[])),fresh=drafts.filter(x=>!(x.indicatorIds||[]).some(id=>existingKeys.has(id)));p.evidence={version:(p.evidence?.version||0)+1,generatedAt:new Date().toISOString(),evidence:[...existing,...fresh]};p.updatedAt=new Date().toISOString();await saveProject(d,p);await logAction(er[1],"evidence.generated",{count:fresh.length});return send(res,200,{ok:true,...p.evidence});}
  if(er&&req.method==="PUT"){const d=await projectDir(er[1]),p=JSON.parse(await readFile(join(d,"project.json"))),b=await jsonBody(req),items=Array.isArray(b.evidence)?b.evidence.map(x=>({...x,reviewStatus:["待审核","已确认","需补充","已排除"].includes(x.reviewStatus)?x.reviewStatus:"待审核",updatedAt:new Date().toISOString()})):[];p.evidence={...(p.evidence||{}),version:(p.evidence?.version||0)+1,evidence:items,updatedAt:new Date().toISOString()};p.updatedAt=new Date().toISOString();await saveProject(d,p);await logAction(er[1],"evidence.reviewed",{confirmed:items.filter(x=>x.reviewStatus==="已确认").length,total:items.length,version:p.evidence.version});return send(res,200,{ok:true,...p.evidence,confirmed:evidenceFor(p)});}
  if(mr && req.method==="GET"){const d=await projectDir(mr[1]),p=JSON.parse(await readFile(join(d,"project.json"))),confirmed=(p.indicators||[]).filter(x=>x.reviewStatus==="已确认"),confirmedEvidence=evidenceFor(p),dims=["前置因素","诱发因素","介质因素","同化代谢","代谢转换与消除","结构完整性","防御与修护","传递系统","传输系统","能量生成","睡眠与放松","运动与活动","营养和水分","压力","人际社交关系"],itemsFor=name=>confirmed.filter(x=>x.dimension===name),sourcesFor=items=>[...new Map(items.map(x=>[`${x.source?.file}|${x.source?.page}`,x.source||{}])).values()];const dimensions=dims.map(name=>{const items=itemsFor(name);return {name,items,assessment:items.length?`基于 ${items.length} 条已确认指标进行综合评估`:`当前未发现已确认指标`,assessmentStatus:items.length?"待人工确认":"未见明显异常",...dimensionAssessment(items),sources:sourcesFor(items)}});const abnormal=confirmed.filter(x=>x.status==="异常"),abnormalSources=sourcesFor(abnormal);const rootMechanisms=[];if(abnormal.some(x=>/肠道|菌群|消化|吸收|便/.test(`${x.name}${x.raw||""}`)))rootMechanisms.push({name:"肠道与同化代谢负担",detail:"已确认指标提示需要结合消化、吸收和排便相关信息综合评估。",indicators:abnormal.filter(x=>/肠道|菌群|消化|吸收|便/.test(`${x.name}${x.raw||""}`)),sources:sourcesFor(abnormal.filter(x=>/肠道|菌群|消化|吸收|便/.test(`${x.name}${x.raw||""}`))) });if(abnormal.some(x=>/食物|不耐受|过敏|IgE|敏感/.test(`${x.name}${x.raw||""}`)))rootMechanisms.push({name:"免疫敏感与暴露因素",detail:"已确认指标提示需要核对敏感源、暴露时间和症状关联。",indicators:abnormal.filter(x=>/食物|不耐受|过敏|IgE|敏感/.test(`${x.name}${x.raw||""}`)),sources:sourcesFor(abnormal.filter(x=>/食物|不耐受|过敏|IgE|敏感/.test(`${x.name}${x.raw||""}`))) });const threeFactors=[{name:"前置因素",detail:"病例背景、既往史、长期饮食和生活方式；需要人工补充与确认。",sources:[]},{name:"诱发因素",detail:"近期饮食、感染、压力、环境或暴露变化；需要结合时间线确认。",sources:abnormalSources},{name:"介质因素",detail:"已确认检测异常及其可能关联的功能维度；不作临床诊断。",sources:abnormalSources}];const timeline=(p.caseData?.history?.timeline||p.caseData?.timeline||[]).map(x=>({...x,sources:x.sources||[]}));const matrixDraft=p.matrixDraft||((p.indicators||[]).length?buildMatrixDraft(p):null);return send(res,200,{confirmedIndicatorCount:confirmed.length,candidateIndicatorCount:(p.indicators||[]).length,confirmedEvidenceCount:confirmedEvidence.length,evidence:confirmedEvidence,matrixDraft,dimensions,rootMechanisms,threeFactors,timeline,disclaimer:"矩阵仅用于整理已确认信息，所有综合评估和根源机制均需专业人员人工确认。"});}
  const sm=req.url.match(/^\/api\/projects\/([^/]+)\/suggestions\/model$/); if(sm&&req.method==="POST"){try{const d=await projectDir(sm[1]),p=JSON.parse(await readFile(join(d,"project.json"))),confirmed=(p.indicators||[]).filter(x=>x.reviewStatus!=="已排除");if(!confirmed.length)return send(res,400,{error:"没有可用报告指标，无法生成 DeepSeek 建议"});const body=await jsonBody(req),model=await callDeepSeekSuggestions(confirmed,p.suggestions?.suggestions||[],body.config?.deepseek||{},p),stamp=new Date().toISOString(),existing=p.suggestions||{},generated=model.suggestions.map((x,i)=>({...x,id:`deepseek-${Date.now()}-${i}`,sourceType:"deepseek",reviewStatus:"待审核",editableContent:x.content||"",basis:Array.isArray(x.basis)?x.basis:[],generatedAt:stamp,model:model.model}));if(synthesisVersion(JSON.parse(await readFile(join(d,"project.json"))))!==synthesisVersion(p))return send(res,409,{error:"生成期间资料已修改，请重新生成建议"});p.suggestions={...existing,generatedAt:existing.generatedAt||stamp,modelGeneratedAt:stamp,model:model.model,modelError:null,combinationAnalysis:[...(existing.combinationAnalysis||[]),...(model.combinationAnalysis||[])],suggestions:[...(existing.suggestions||[]),...generated]};
      p.suggestions.modules=model.modules||[];
      await mkdir(join(d,"parsed","modules"),{recursive:true});
      for (const moduleResult of model.modules || []) await writeFile(join(d,"parsed","modules",safe(moduleResult.moduleId)+".json"),JSON.stringify(moduleResult,null,2));
      const approvedModules=(model.modules||[]).map(module=>({...module,suggestions:p.suggestions.suggestions.filter(item=>item.sourceModuleId===module.moduleId||item.module===module.moduleTitle),reviewStatus:"待审核"}));
      p.approvedPlan={version:"1.0.0",status:"待审核",createdAt:stamp,updatedAt:stamp,dataVersion:synthesisVersion(p),source:"deepseek-module-generation",modules:approvedModules,suggestions:p.suggestions.suggestions};
      await writeFile(join(d,"approved-plan.json"),JSON.stringify(p.approvedPlan,null,2));p.updatedAt=stamp;await saveProject(d,p);await logAction(sm[1],"suggestions.model_generated",{count:generated.length,model:model.model});return send(res,200,{ok:true,...p.suggestions,pptReadySuggestions:p.suggestions.suggestions.filter(x=>x.reviewStatus==="已确认")});}catch(e){return send(res,400,{error:e.message||"DeepSeek 建议生成失败"});}}
  const sy=req.url.match(/^\/api\/projects\/([^/]+)\/synthesis$/); if(sy && req.method==="PUT"){let loaded;try{loaded=await loadProject(sy[1])}catch(error){return send(res,error.statusCode||500,{error:error.message||"项目读取失败"})}const {d,p}=loaded,b=await jsonBody(req),status=["待审核","已确认","已修改"].includes(b.status)?b.status:"待审核",stamp=new Date().toISOString(),prev=p.synthesisReview||{};if(status==="已确认"&&b.dataVersion!==synthesisVersion(p))return send(res,409,{error:"资料版本已变更，请刷新综合分析后重新确认"});if(status==="已确认"&&!(p.indicators||[]).some(x=>x.reviewStatus==="已确认"))return send(res,400,{error:"暂无已确认指标，不能确认综合分析"});p.synthesisReview={status,note:String(b.note||""),updatedAt:stamp,version:(prev.version||0)+1,dataVersion:synthesisVersion(p)};p.updatedAt=stamp;await saveProject(d,p);await logAction(sy[1],"synthesis.reviewed",{status,version:p.synthesisReview.version});return send(res,200,{ok:true,synthesisReview:p.synthesisReview});}
  const syGet=req.url.match(/^\/api\/projects\/([^/]+)\/synthesis$/); if(syGet && req.method==="GET"){let loaded;try{loaded=await loadProject(syGet[1])}catch(error){return send(res,error.statusCode||500,{error:error.message||"项目读取失败"})}const {d,p}=loaded,confirmed=(p.indicators||[]).filter(x=>x.reviewStatus==="已确认"),abnormal=confirmed.filter(x=>x.status==="异常"),suggestions=(p.suggestions?.suggestions||[]).filter(x=>x.reviewStatus==="已确认"),groups=new Map();for(const x of confirmed){const key=x.dimension||"待分类";groups.set(key,(groups.get(key)||[]).concat(x));}const dimensions=MATRIX_DIMENSIONS.map(name=>{const items=groups.get(name)||[];const abnormalCount=items.filter(x=>x.status==="异常").length;return {name,count:items.length,abnormalCount,assessment:abnormalCount?`该维度有 ${abnormalCount} 条已确认异常指标，需结合病例背景和原始报告进一步确认。`:`未见明显异常`,assessmentStatus:abnormalCount?"需关注":"未见明显异常",...dimensionAssessment(items),indicators:items.slice(0,8),sources:[...new Map(items.map(x=>[`${x.source?.file}|${x.source?.page}`,x.source||{}])).values()]};});const sourceMap=[...new Map(abnormal.map(x=>[`${x.source?.file}|${x.source?.page}`,x.source||{}])).values()];const summary=confirmed.length?`当前共纳入 ${confirmed.length} 条人工确认指标，其中 ${abnormal.length} 条被报告标记为异常。综合分析应优先关注异常组合、对应功能维度和病例症状时间线。`:`当前暂无已确认指标，无法生成综合分析。`;const synthesisReview=currentSynthesisReview(p),confirmedEvidence=evidenceFor(p),evidenceKeys=new Set(confirmedEvidence.flatMap(x=>[...(x.indicatorIds||[]),...(x.indicators||[]).map(v=>v.name)])),analysisIndicators=confirmed.filter(x=>evidenceKeys.has(x.id)||evidenceKeys.has(x.name)),analysisAbnormal=analysisIndicators.filter(x=>x.status==="异常"),analysisGroups=new Map();for(const x of analysisIndicators){const key=x.dimension||"待分类";analysisGroups.set(key,(analysisGroups.get(key)||[]).concat(x));}const analysisDimensions=MATRIX_DIMENSIONS.map(name=>{const items=analysisGroups.get(name)||[];const abnormalCount=items.filter(x=>x.status==="异常").length;return {name,count:items.length,abnormalCount,...dimensionAssessment(items),indicators:items.slice(0,8),sources:[...new Map(items.map(x=>[`${x.source?.file}|${x.source?.page}`,x.source||{}])).values()]};});const analysisSummary=confirmed.length?`当前综合分析纳入 ${confirmed.length} 条已确认指标，其中 ${abnormal.length} 条被报告标记为异常；功能矩阵作为独立工作底稿单独维护。`:`当前暂无已确认指标，不能生成正式综合分析。`;return send(res,200,{generatedAt:new Date().toISOString(),confirmedIndicatorCount:analysisIndicators.length,rawConfirmedIndicatorCount:confirmed.length,confirmedEvidenceCount:confirmedEvidence.length,abnormalCount:analysisAbnormal.length,confirmedSuggestionCount:suggestions.length,summary:analysisSummary,dimensions:analysisDimensions,priorityFindings:analysisAbnormal.slice(0,12).map(x=>({title:`${x.name} ${x.value||""}`,detail:x.raw||"已确认异常指标",source:x.source||{}})),combinationAnalysis:(p.suggestions?.combinationAnalysis||[]),confirmedSuggestions:suggestions,confirmedEvidence,sources:sourceMap,reviewStatus:synthesisReview.status,synthesisReview,dataVersion:synthesisVersion(p),disclaimer:"综合分析仅使用已确认指标和已确认功能医学举证；所有结论仍需人工确认，不构成诊断。"});}
  const ex=req.url.match(/^\/api\/projects\/([^/]+)\/export-ppt$/); if(ex&&ex[1]&&req.method==="POST"){try{return send(res,200,{ok:true,...await generateProjectPpt(ex[1])})}catch(e){return send(res,400,{error:e.message})}}
  const previewExport=req.url.match(/^\/api\/projects\/([^/]+)\/exports\/([^/]+)\/preview$/); if(previewExport&&req.method==="GET"){const d=await projectDir(previewExport[1]),name=decodeURIComponent(previewExport[2]),filePath=join(d,"exports",name);try{const stat=await import('node:fs/promises').then(m=>m.stat(filePath));res.writeHead(200,{"Content-Type":"application/pdf","Content-Disposition":`inline; filename*=UTF-8''${encodeURIComponent(name)}`,"Content-Length":String(stat.size)});createReadStream(filePath).pipe(res);return}catch{return send(res,404,{error:"Preview not found"})}}
  const rawExport=req.url.match(/^\/api\/projects\/([^/]+)\/exports\/([^/]+)$/); if(rawExport&&req.method==="GET"){const d=await projectDir(rawExport[1]),name=decodeURIComponent(rawExport[2]),filePath=join(d,"exports",safe(name));try{const stat=await import('node:fs/promises').then(m=>m.stat(filePath));res.writeHead(200,{"Content-Type":"application/vnd.openxmlformats-officedocument.presentationml.presentation","Content-Disposition":`attachment; filename*=UTF-8''${encodeURIComponent(name)}`,"Content-Length":String(stat.size)});createReadStream(filePath).pipe(res);return}catch{return send(res,404,{error:"Export not found"})}}
  const pt=req.url.match(/^\/api\/projects\/([^/]+)\/ppt-template$/); if(pt&&req.method==="GET"){
    const d=await projectDir(pt[1]),p=JSON.parse(await readFile(join(d,"project.json"))),confirmedEvidence=evidenceFor(p);
    const plan=p.approvedPlan||{status:"待审核",suggestions:[]};
    const ready=plan.status==="已确认"&&(!plan.dataVersion||plan.dataVersion===synthesisVersion(p))&&(plan.suggestions||[]).some(x=>x.reviewStatus==="已确认");
    const previewProject={...p,approvedPlan:plan};
    const slides=ready?buildReportPages(previewProject,confirmedEvidence):[];
    return send(res,200,{templateName:"敏医康 · 竖版健康改善方案",slideCount:slides.length,slides,ready,disclaimer:ready?"此处为 approved-plan.json 的排版预览；确认后可导出同一份内容。":"请先生成并确认健康建议，确认后的 approved-plan.json 才能进入预览。"});
  }
  const approvedPlanRoute=req.url.match(/^\/api\/projects\/([^/]+)\/approved-plan$/); if(approvedPlanRoute&&req.method==="GET"){const d=await projectDir(approvedPlanRoute[1]);try{return send(res,200,JSON.parse(await readFile(join(d,"approved-plan.json"))))}catch{return send(res,200,{version:"1.0.0",status:"待审核",modules:[],suggestions:[]})}}
  const outputProfileRoute=req.url.match(/^\/api\/projects\/([^/]+)\/output-profile$/); if(outputProfileRoute){const d=await projectDir(outputProfileRoute[1]),p=JSON.parse(await readFile(join(d,"project.json"))); if(req.method==="GET") return send(res,200,{profile:p.outputProfile||{audience:"client",ageGroup:"adult",missingData:"hide"}}); if(req.method==="PUT"){const b=await jsonBody(req);p.outputProfile={audience:["client","professional"].includes(b.audience)?b.audience:"client",ageGroup:["adult","child"].includes(b.ageGroup)?b.ageGroup:"adult",missingData:["hide","show"].includes(b.missingData)?b.missingData:"hide"};p.updatedAt=new Date().toISOString();await saveProject(d,p);return send(res,200,{ok:true,profile:p.outputProfile});}}
  const sg=req.url.match(/^\/api\/projects\/([^/]+)\/suggestions$/); if(sg && req.method==="POST"){const d=await projectDir(sg[1]),p=JSON.parse(await readFile(join(d,"project.json")));let body={};try{body=await jsonBody(req)}catch{}if(!(p.indicators||[]).length){const extracted=[];for(const file of p.files||[]){if(file.kind!=="pdfs")continue;try{const parsed=JSON.parse(await readFile(join(d,"parsed",safe(file.name)+".json")));for(const item of parsed.structuredIndicators||[]){extracted.push({...item,reviewStatus:"待审核",source:{...item.source,file:item.source?.file||file.originalName||file.name}});}}catch{}}p.indicators=extracted;}if(!(p.indicators||[]).some(item=>item.reviewStatus!=="已排除"))return send(res,400,{error:"没有可用的报告指标，请先完成报告分析；已排除指标不会用于建议。"});const data=buildSuggestions(p,["A","B","C"].includes(body.mode)?body.mode:"A");p.suggestions=data;const stamp=new Date().toISOString();p.approvedPlan={version:"1.0.0",status:"待审核",updatedAt:stamp,dataVersion:synthesisVersion(p),modules:data.modules||[],suggestions:data.suggestions||[]};await writeFile(join(d,"approved-plan.json"),JSON.stringify(p.approvedPlan,null,2));p.updatedAt=stamp;await saveProject(d,p);await logAction(sg[1],"suggestions.generated",{basedOnIndicatorCount:data.basedOnIndicatorCount,count:data.suggestions.length});return send(res,200,data);}
  if(sg && req.method==="GET"){const d=await projectDir(sg[1]),p=JSON.parse(await readFile(join(d,"project.json"))),data=p.suggestions||{generatedAt:null,basedOnIndicatorCount:0,confirmedAbnormalCount:0,combinationAnalysis:[],suggestions:[],disclaimer:"请先生成建议草稿。"};return send(res,200,{...data,confirmedIndicatorCount:(p.indicators||[]).filter(x=>x.reviewStatus==="已确认").length,candidateIndicatorCount:(p.indicators||[]).length,pptReadySuggestions:(data.suggestions||[]).filter(x=>x.reviewStatus==="已确认")});}
  if(sg && req.method==="PUT"){const d=await projectDir(sg[1]),b=await jsonBody(req),p=JSON.parse(await readFile(join(d,"project.json"))),current=p.suggestions||{},suggestions=Array.isArray(b.suggestions)?b.suggestions.map(x=>({...x,reviewStatus:["待审核","已确认","已修改","需补充","已排除"].includes(x.reviewStatus)?x.reviewStatus:"待审核"})):current.suggestions||[],version={version:(current.versions?.length||0)+1,savedAt:new Date().toISOString(),suggestions:JSON.parse(JSON.stringify(suggestions)),interventionPeriod:String(b.interventionPeriod??current.interventionPeriod??""),reviewPeriod:String(b.reviewPeriod??current.reviewPeriod??"")};p.suggestions={...current,suggestions,interventionPeriod:version.interventionPeriod,reviewPeriod:version.reviewPeriod,versions:[...(current.versions||[]),version],updatedAt:version.savedAt};
      const configuredModules=current.modules?.length?current.modules:moduleRegistry.filter(module=>module.legacyRule).map(module=>({moduleId:module.id,moduleTitle:module.title,status:"missing_data",suggestions:[]}));
      const approvedModules=configuredModules.map(module=>{const items=suggestions.filter(x=>x.sourceModuleId===module.moduleId||x.module===module.moduleTitle);return {...module,suggestions:items,reviewStatus:items.length&&items.every(x=>["已确认","已排除"].includes(x.reviewStatus))?"已确认":items.length?"待审核":"资料不足"};});
      p.approvedPlan={version:"1.0.0",status:suggestions.every(x=>["已确认","已排除"].includes(x.reviewStatus))?"已确认":"待审核",updatedAt:version.savedAt,dataVersion:synthesisVersion(p),interventionPeriod:version.interventionPeriod,reviewPeriod:version.reviewPeriod,modules:approvedModules,suggestions};
      await writeFile(join(d,"approved-plan.json"),JSON.stringify(p.approvedPlan,null,2));p.updatedAt=version.savedAt;await saveProject(d,p);await logAction(sg[1],"suggestions.reviewed",{confirmed:suggestions.filter(x=>x.reviewStatus==="已确认").length,total:suggestions.length,version:version.version});return send(res,200,{ok:true,...p.suggestions,pptReadySuggestions:suggestions.filter(x=>x.reviewStatus==="已确认")});}
  const pa=req.url.match(/^\/api\/projects\/([^/]+)\/analyze-all$/); if(pa&&req.method==="POST"){const d=await projectDir(pa[1]),p=JSON.parse(await readFile(join(d,"project.json"))),pdfs=(p.files||[]).filter(file=>file.kind==="pdfs");if(!pdfs.length)return send(res,400,{error:"当前项目没有 PDF"});if(runningProjects.has(pa[1]))return send(res,202,{ok:true,status:"处理中"});analyzeProject(pa[1]).catch(async error=>{const latest=JSON.parse(await readFile(join(d,"project.json")));latest.status="失败";latest.analysisError=error.message;latest.updatedAt=new Date().toISOString();await writeFile(join(d,"project.json"),JSON.stringify(latest,null,2));await logAction(pa[1],"analysis.project.failed",{error:error.message})});return send(res,202,{ok:true,status:"处理中",pdfCount:pdfs.length})}
  const ps=req.url.match(/^\/api\/projects\/([^/]+)\/analysis-summary$/); if(ps&&req.method==="GET"){const d=await projectDir(ps[1]),p=JSON.parse(await readFile(join(d,"project.json")));return send(res,200,{status:p.status,files:p.files||[],summary:p.analysisSummary||null,error:p.analysisError||null})}
  const rr=req.url.match(/^\/api\/projects\/([^/]+)\/files\/([^/]+)\/retry$/); if(rr && req.method==="POST"){const id=rr[1],name=decodeURIComponent(rr[2]),d=await projectDir(id),p=JSON.parse(await readFile(join(d,"project.json")));p.files=(p.files||[]).map(f=>f.name===name?{...f,status:"处理中",queueStatus:"queued",retryAt:new Date().toISOString()}:f);p.updatedAt=new Date().toISOString();await saveProject(d,p);await logAction(id,"file.retry",{name});return send(res,200,{ok:true});}
  if (req.method === "GET" && req.url === "/api/modules") return send(res, 200, { version: "1.0.0", modules: moduleRegistry });
  if (req.method === "POST" && req.url === "/api/analyze") {
    try {
      const body = await jsonBody(req); const localText = String(body.text || ""); const fileName = String(body.fileName || "report.pdf"); const config = body.config || {};
      if(body.projectId){const d=await projectDir(body.projectId),p=JSON.parse(await readFile(join(d,"project.json")));p.files=(p.files||[]).map(f=>f.name===fileName||f.originalName===fileName?{...f,status:"处理中",queueStatus:"processing"}:f);p.updatedAt=new Date().toISOString();await saveProject(d,p);}
      if (!localText && !body.pdfBase64) return send(res, 400, { error: "缺少 PDF 内容" });
      let mineru = { text: "", skipped: true }; let mineruError = "";
      try { mineru = await callMinerU(body.pdfBase64, fileName, config.mineru); } catch (error) { mineruError = error.message; }
      const sourceText = mineru.text || localText;
      let ai = null; let aiError = "";
      try { ai = await callDeepSeek(sourceText, fileName, config.deepseek); } catch (error) { aiError = error.message; }
      const reportType=parseReportType(fileName,sourceText);const structuredIndicators=extractStructuredIndicators(mineru.pages||[],fileName,reportType);if(body.projectId){const d=await projectDir(body.projectId),p=JSON.parse(await readFile(join(d,"project.json")));await writeFile(join(d,"parsed",`${safe(fileName)}.json`),JSON.stringify({fileName,reportType,text:sourceText,pages:mineru.pages||[],structuredIndicators,ai,meta:{mineru:!mineru.skipped&&!mineruError,mineruError,deepseek:Boolean(ai),deepseekError:aiError}},null,2));p.files=(p.files||[]).map(f=>f.name===fileName||f.originalName===fileName?{...f,status:mineruError?"失败":"已完成",queueStatus:mineruError?"failed":"completed",parsedAt:new Date().toISOString(),error:mineruError||undefined}:f);p.updatedAt=new Date().toISOString();await saveProject(d,p);await logAction(body.projectId,"analysis.saved",{fileName,reportType,indicatorCount:structuredIndicators.length});}
      return send(res, 200, { text: sourceText, ai, meta: { mineru: !mineru.skipped && !mineruError, mineruError, deepseek: Boolean(ai), deepseekError: aiError } });
    } catch (error) { return send(res, 400, { error: error.message || "分析请求失败" }); }
  }
  if(req.method==="POST"&&req.url==="/api/analyze-image"){try{const b=await jsonBody(req),v=await callVision(b.imageBase64,b.fileName||"screenshot.png",b.config?.deepseek||{});if(b.projectId){const d=await projectDir(b.projectId);await writeFile(join(d,"parsed",`${safe(b.fileName||"screenshot")}.vision.json`),JSON.stringify(v,null,2));await logAction(b.projectId,"vision.saved",{fileName:b.fileName})}return send(res,200,v)}catch(e){return send(res,400,{error:e.message})}}
  if (req.method === "POST" && req.url === "/api/test-connection") {
    try { const body = await jsonBody(req); const service = body.service; const cfg = body.config || {}; if (service === "deepseek") { if (!cfg.key) return send(res, 400, { error: "请填写 DeepSeek API Key" }); const base = (cfg.url || "https://api.deepseek.com").replace(/\/$/, ""); const r = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${cfg.key}` } }); if (!r.ok) throw new Error(`DeepSeek 返回 ${r.status}`); return send(res, 200, { ok: true, message: "DeepSeek 连接成功" }); } if (service === "mineru") { if (!cfg.token) return send(res, 400, { error: "请填写 MinerU Token" }); const r = await fetch(cfg.url || "https://mineru.net", { headers: { Authorization: `Bearer ${cfg.token}` } }); if (!r.ok && r.status !== 404) throw new Error(`MinerU 返回 ${r.status}`); return send(res, 200, { ok: true, message: "MinerU 服务可访问" }); } return send(res, 400, { error: "未知服务" }); } catch (error) { return send(res, 502, { error: error.message || "连接失败" }); }
  }
  const path = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  try { const file = await readFile(join(root, path)); const type = extname(path) === ".html" ? "text/html" : extname(path) === ".css" ? "text/css" : extname(path) === ".png" ? "image/png" : "text/javascript"; res.writeHead(200, { "Content-Type": `${type}; charset=utf-8` }); res.end(file); } catch { res.writeHead(404); res.end("Not found"); }
}
http.createServer((req,res)=>handler(req,res).catch(error=>{console.error(error);if(!res.headersSent)send(res,500,{error:"Internal server error"});else res.destroy()})).listen(port, () => console.log(`医见服务已启动: http://localhost:${port}`));
