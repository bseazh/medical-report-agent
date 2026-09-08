import { humanizeMatrixFact } from "./labels.mjs";

function escapeXml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]);
}
function wrap(text, size = 22) { const result = []; let value = String(text || ""); while (value.length > size) { result.push(value.slice(0, size)); value = value.slice(size); } if (value) result.push(value); return result; }
function factText(section) { const seen = new Set(); return (section.confirmedFacts?.length ? section.confirmedFacts : section.candidateFacts || []).map(fact => humanizeMatrixFact(fact.text)).filter(text => text && !seen.has(text) && seen.add(text)).slice(0, 3); }

export function renderMatrixSvg(workspace, patientName = "患者") {
  const colors = { story: "#58B98A", factor: "#63A8D8", lifestyle: "#E2A34D" };
  const sections = workspace?.sections || [], byId = new Map(sections.map(section => [section.sectionId, section]));
  const output = [`<svg xmlns="http://www.w3.org/2000/svg" width="1800" height="1280" viewBox="0 0 1800 1280"><rect width="1800" height="1280" fill="#F7FAF8"/><text x="60" y="60" font-size="30" font-family="Noto Sans SC, sans-serif" font-weight="700" fill="#17231F">功能医学矩阵</text><text x="60" y="92" font-size="16" font-family="Noto Sans SC, sans-serif" fill="#71807A">${escapeXml(patientName)} · 人工核对版</text>`];
  const card = (x, y, w, h, title, section, color) => { const facts = factText(section); let html = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="16" fill="#FFFFFF" stroke="#DDE8E1" stroke-width="2"/><rect x="${x}" y="${y}" width="${w}" height="7" rx="4" fill="${color}"/><text x="${x + 20}" y="${y + 35}" font-size="20" font-family="Noto Sans SC, sans-serif" font-weight="700" fill="#17231F">${escapeXml(title)}</text>`; facts.forEach((fact, index) => wrap(fact, 24).slice(0, 2).forEach((line, lineIndex) => { html += `<text x="${x + 22}" y="${y + 68 + index * 38 + lineIndex * 17}" font-size="14" font-family="Noto Sans SC, sans-serif" fill="#52645A">${escapeXml(line)}</text>`; })); if (!facts.length) html += `<text x="${x + 22}" y="${y + 70}" font-size="14" font-family="Noto Sans SC, sans-serif" fill="#A0ADA5">暂无已识别内容</text>`; return html; };
  const story = byId.get("story") || {}, ante = byId.get("antecedents") || {}, trigger = byId.get("triggers") || {}, mediator = byId.get("mediators") || {};
  output.push(card(60, 130, 410, 150, "复述您的故事", story, colors.story));
  output.push(card(60, 300, 410, 180, "前置因素  疾病的种子", ante, colors.factor));
  output.push(card(60, 500, 410, 180, "触发因素  疾病的扳机", trigger, colors.factor));
  output.push(card(60, 700, 410, 180, "媒介因素  维持疾病的燃料", mediator, colors.factor));
  const cx = 1010, cy = 455, core = workspace?.core || { central: "心理、精神、情绪", fields: [] }, coreById = new Map((core.fields || []).map(field => [field.id, field])), ring = [{id:"assimilation",title:"同化代谢",x:790,y:215},{id:"conversion",title:"代谢转化与消除",x:1135,y:250},{id:"defense",title:"防御与修复",x:1260,y:470},{id:"energy",title:"能量生成",x:1115,y:675},{id:"transport",title:"传输系统",x:820,y:675},{id:"signal",title:"传递系统",x:690,y:470},{id:"integrity",title:"结构完整性",x:900,y:120}];
  output.push(`<circle cx="${cx}" cy="${cy}" r="205" fill="none" stroke="#A8D9B2" stroke-width="5" stroke-dasharray="12 10"/><circle cx="${cx}" cy="${cy}" r="112" fill="#FFF8E9" stroke="#E2A34D" stroke-width="5"/><text x="${cx}" y="${cy-10}" text-anchor="middle" font-size="22" font-family="Noto Sans SC, sans-serif" font-weight="700" fill="#7A5A22">${escapeXml(core.central || "心理、精神、情绪")}</text><text x="${cx}" y="${cy+28}" text-anchor="middle" font-size="14" font-family="Noto Sans SC, sans-serif" fill="#8D7750">核心影响因素</text>`);
  ring.forEach(item => { const content = humanizeMatrixFact(coreById.get(item.id)?.content || ""); output.push(`<rect x="${item.x}" y="${item.y}" width="205" height="58" rx="16" fill="#FFFFFF" stroke="#63A8D8" stroke-width="3"/><text x="${item.x+102}" y="${item.y+26}" text-anchor="middle" font-size="16" font-family="Noto Sans SC, sans-serif" fill="#315C78">${item.title}</text><text x="${item.x+102}" y="${item.y+45}" text-anchor="middle" font-size="10" font-family="Noto Sans SC, sans-serif" fill="#71807A">${escapeXml(String(content).slice(0, 18))}</text>`); });
  const lifestyle = [["sleep-relaxation","睡眠与放松"],["exercise-activity","运动与活动"],["nutrition-water","营养和水分"],["stress","压力"],["social-relationships","人际社交关系"]];
  output.push(`<text x="60" y="960" font-size="22" font-family="Noto Sans SC, sans-serif" font-weight="700" fill="#17231F">可改善的生活方式</text>`);
  lifestyle.forEach(([id,title],index) => output.push(card(60 + index * 342, 985, 315, 220, title, byId.get(id) || {}, colors.lifestyle)));
  return output.join("") + "</svg>";
}
