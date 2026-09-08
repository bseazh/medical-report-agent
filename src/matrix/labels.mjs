const labels = {
  patient: "个人信息", name: "姓名", gender: "性别", age: "年龄", history: "病史资料", chiefComplaint: "主要问题", presentIllness: "现病经过", pastHistory: "既往情况", familyHistory: "家族情况", allergies: "过敏情况", medications: "目前用药", symptoms: "症状表现", visits: "就诊记录", date: "日期", time: "时间", department: "就诊科室", doctor: "接诊医生", visit_id: "就诊编号", diagnosis: "诊断结果", timeline: "健康时间线", exposures: "接触与暴露", foodReactions: "食物反应", sleep: "睡眠情况", exercise: "运动活动", activity: "日常活动", diet: "饮食情况", water: "饮水情况", nutrition: "营养情况", stress: "压力情况", social: "人际关系", relationships: "支持关系", reviewStatus: "审核状态"
};

export function labelFor(key) { return labels[key] || key; }

export function humanizeMatrixFact(value) {
  let text = String(value ?? "").trim();
  if (!text) return "";
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      const parts = [];
      const walk = (item, prefix = "") => {
        if (item === null || item === undefined || item === "") return;
        if (Array.isArray(item)) return item.forEach(entry => walk(entry, prefix));
        if (typeof item === "object") return Object.entries(item).forEach(([key, nested]) => walk(nested, prefix ? `${prefix} ${labelFor(key)}` : labelFor(key)));
        parts.push(`${prefix} ${item}`.trim());
      };
      walk(parsed);
      return parts.join("；");
    }
  } catch {}
  text = text.replace(/^(patient|history|symptoms|allergies|medications|visits|diagnosis|timeline)(?:\.|：|:)?\s*/i, match => `${labelFor(match.replace(/[：:.\s]/g, ""))} `);
  text = text.replace(/(^|[\s；])([A-Za-z_][A-Za-z0-9_-]*)(?=\s|：|:)/g, (_, prefix, key) => `${prefix}${labelFor(key)} `);
  return text.replace(/[{}\[\]"]+/g, "").replace(/\s+/g, " ").trim();
}
