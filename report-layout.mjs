import { fileURLToPath } from "node:url";

export const PAGE = { width: 7.5, height: 10.8333, font: "Noto Sans CJK SC", green: "00675A", gold: "CA7F42", ink: "303B37" };
const moduleOrder = ["饮食回避", "替代方案", "一日饮食", "身体活动", "科学饮水", "睡眠与减压", "营养支持", "阶段干预", "其他建议"];

export function wrapText(value, capacity = 31) {
  const lines = [];
  for (const paragraph of String(value ?? "").split(/\r?\n/)) {
    let line = "", used = 0;
    for (const char of paragraph) {
      const weight = char.codePointAt(0) < 256 ? 0.6 : 1;
      if (used + weight > capacity && line) { lines.push(line); line = ""; used = 0; }
      line += char; used += weight;
    }
    lines.push(line);
  }
  return lines;
}

function moduleFor(item) {
  if (moduleOrder.includes(item.module)) return item.module;
  if (item.type === "饮食") return /替代/.test(item.title) ? "替代方案" : /每餐|一日/.test(item.title) ? "一日饮食" : "饮食回避";
  return {运动:"身体活动",饮水:"科学饮水",减压:"睡眠与减压",营养支持:"营养支持",阶段计划:"阶段干预"}[item.type] || "其他建议";
}

function sourcesText(sources = []) {
  return sources.map(source => `${source.file || "来源文件待补充"} · 第 ${source.page ?? "?"} 页`).join("；");
}

export function buildReportPages(project, evidence = []) {
  const name = project.caseData?.patient?.name || project.patientName || "患者";
  const indicators = (project.indicators || []).filter(item => item.reviewStatus === "已确认");
  const approved = project.approvedPlan?.modules || [];
  const moduleSuggestions = approved.flatMap(module => (module.suggestions || []).filter(item => item.reviewStatus === "已确认").map(item => ({...item, module: module.moduleTitle || module.title})));
  const approvedSuggestions = project.approvedPlan?.suggestions || [];
  const suggestions = (approvedSuggestions.length ? approvedSuggestions : (moduleSuggestions.length ? moduleSuggestions : (project.suggestions?.suggestions || []))).filter(item => item.reviewStatus === "已确认");
  const pages = [{ kind: "cover", title: "过敏健康改善指导方案", subtitle: name, blocks: [] }];
  function section(title, records) {
    if (!records.length) return;
    let page;
    function newPage() { page = { kind: "content", title, blocks: [] }; pages.push(page); }
    newPage();
    let top = 1.85;
    for (const record of records) {
      const lines = wrapText(record.text);
      for (let offset = 0; offset < lines.length; offset += 22) {
        const text = lines.slice(offset, offset + 22).join("\n");
        const height = Math.min(22, lines.length - offset) * 0.245 + 0.38;
        if (top + height > 9.85) { newPage(); top = 1.85; }
        page.blocks.push({ text, x: 0.55, y: top, w: 6.4, h: height, continuation: offset > 0 });
        top += height + 0.2;
      }
    }
  }
  section("致您的健康管理说明", [{text:`尊敬的${name}，您好！\n\n本方案依据已审核资料整理，用于沟通与健康管理。饮食、生活方式及阶段计划均保留人工审核结果。\n\n资料中没有确认的内容不作推断；本方案不能替代临床诊断、治疗与专业人员建议。`}]);
  section("核心功能评估汇总", indicators.map(item => ({text:`${item.dimension || "待分类"}｜${item.name}\n检测结果：${item.value ?? "未填写"} ${item.unit || ""}\n参考范围：${item.reference || "未提供"}\n报告状态：${item.status || "待补充判断"}\n来源：${sourcesText([item.source || {}])}`})));
  section("功能医学举证", evidence.filter(item=>item.reviewStatus==="已确认").map(item=>({text:`${item.dimension || "待分类"}\n${item.claim || ""}\n判断说明：${item.reasoning || "未填写"}\n来源：${sourcesText(item.sources)}`})));
  for (const module of moduleOrder) {
    section(module, suggestions.filter(item => moduleFor(item) === module).map(item => {
      const basis = (item.basis || []).map(entry=>`${entry.name} ${entry.value ?? ""} ${entry.unit || ""}`).join("；");
      const sources = item.sources?.length ? item.sources : (item.basis || []).map(entry=>entry.source).filter(Boolean);
      return {text:`${item.title || module}\n${item.category || "已确认建议"}\n${item.editableContent ?? item.content ?? ""}\n\n触发指标：${basis || "未记录，请复核"}\n来源：${sourcesText(sources) || "未记录，请复核"}`};
    }));
  }
  section("随访与动态调整", [{text:`干预周期：${project.suggestions?.interventionPeriod || "由专业人员确认"}\n复查周期：${project.suggestions?.reviewPeriod || "由专业人员确认"}\n\n记录执行情况和症状变化，复查后再调整方案；不要自行停药、换药或更改补充剂剂量。`}]);
  section("最后寄语", [{text:"每一步改变，都从可执行的小事开始。\n\n与专业人员一起核对方案，结合耐受情况循序渐进，并及时记录反馈。\n\n如出现新症状或症状加重，请及时就医。感谢您的信任。"}]);
  const counts = new Map();
  for (const page of pages) counts.set(page.title, (counts.get(page.title)||0)+1);
  const seen = new Map();
  return pages.map((page,index)=>{
    seen.set(page.title,(seen.get(page.title)||0)+1);
    return {...page,number:index+1,title:counts.get(page.title)>1?`${page.title}（${seen.get(page.title)}/${counts.get(page.title)}）`:page.title};
  });
}

export function renderReport(pptx, pages) {
  pptx.defineLayout({name:"MEDICAL_PORTRAIT",width:PAGE.width,height:PAGE.height});
  pptx.layout="MEDICAL_PORTRAIT";
  pptx.author="敏医康"; pptx.title="过敏健康改善指导方案"; pptx.lang="zh-CN";
  pptx.theme={headFontFace:PAGE.font,bodyFontFace:PAGE.font,lang:"zh-CN"};
  const logo=fileURLToPath(new URL("./assets/ppt/logo.png",import.meta.url));
  for (const page of pages) {
    const slide=pptx.addSlide(); slide.background={color:"FFFFFF"};
    const text=(value,options)=>slide.addText(value,{fontFace:PAGE.font,color:PAGE.ink,margin:0,breakLine:false,valign:"top",...options});
    slide.addImage({path:logo,x:0.55,y:0.3,w:1.3,h:0.45});
    text("专注过敏诊疗 · 托举健康人生",{x:3.8,y:0.48,w:3.1,h:0.25,fontSize:9,color:PAGE.green,align:"right"});
    if(page.kind==="cover") {
      slide.addShape(pptx.ShapeType.rect,{x:0.55,y:2.25,w:0.07,h:2.55,line:{color:PAGE.gold},fill:{color:PAGE.gold}});
      text(wrapText(page.subtitle,15).join("\n"),{x:0.85,y:2.4,w:5.8,h:1,fontSize:24,color:PAGE.gold,fit:"shrink"});
      text("过敏健康改善\n指导方案",{x:0.85,y:3.55,w:5.8,h:1.65,fontSize:34,bold:true,color:PAGE.green});
      slide.addShape(pptx.ShapeType.rect,{x:0,y:6.4,w:7.5,h:3.1,line:{color:PAGE.green},fill:{color:PAGE.green}});
      text("个性化健康管理",{x:0.85,y:7.05,w:5.8,h:0.55,fontSize:26,bold:true,color:"FFFFFF"});
      text("已审核资料 · 行动建议 · 随访调整",{x:0.85,y:7.92,w:5.8,h:0.4,fontSize:14,color:"FFFFFF"});
    } else {
      text(page.title,{x:0.55,y:1.05,w:6.4,h:0.52,fontSize:22,bold:true,color:PAGE.green});
      slide.addShape(pptx.ShapeType.rect,{x:0.55,y:1.65,w:6.4,h:0.035,line:{color:PAGE.gold},fill:{color:PAGE.gold}});
      for (const block of page.blocks) {
        slide.addShape(pptx.ShapeType.rect,{x:block.x,y:block.y,w:block.w,h:block.h,line:{color:"CCDCD7",width:0.6},fill:{color:"F3F8F6"}});
        slide.addShape(pptx.ShapeType.rect,{x:block.x,y:block.y,w:0.045,h:block.h,line:{color:PAGE.green},fill:{color:PAGE.green}});
        text(block.text,{x:block.x+0.18,y:block.y+0.16,w:block.w-0.36,h:block.h-0.25,fontSize:13,lineSpacingMultiple:1.08,paraSpaceAfter:0});
      }
    }
    text("敏医康 · 仅供健康管理沟通，不能替代临床诊疗",{x:0.55,y:10.25,w:5.8,h:0.25,fontSize:8,color:"64746B"});
    text(`${page.number} / ${pages.length}`,{x:6.35,y:10.25,w:0.6,h:0.25,fontSize:9,color:PAGE.gold,align:"right"});
  }
  return pptx;
}
