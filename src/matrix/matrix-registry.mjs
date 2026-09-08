export const MATRIX_REVIEW_STATUSES = ["待审核", "已确认", "已修改", "需补充", "已排除"];

export const matrixSections = [
  { id: "story", title: "复述您的故事", kind: "story", questions: ["本次最希望改善的主要问题是什么？", "症状何时开始，最近有什么变化？", "目前最影响生活的表现是什么？"] },
  { id: "antecedents", title: "前置因素（疾病的种子）", kind: "factor", questions: ["家族中是否有过敏、哮喘、湿疹或自身免疫相关疾病？", "既往是否有长期或反复的健康问题？", "出生、成长、既往治疗或长期用药中有哪些重要信息？"] },
  { id: "triggers", title: "触发因素（疾病的扳机）", kind: "factor", questions: ["近期是否有饮食、感染、环境、季节或接触物变化？", "哪些因素出现后症状会加重？时间关系是否明确？", "是否有明确的食物或药物反应经历？"] },
  { id: "mediators", title: "媒介因素（维持疾病的燃料）", kind: "factor", questions: ["当前哪些症状或检测结果可能在持续维持问题？", "消化、排便、炎症、营养或睡眠方面有哪些持续因素？", "目前正在使用哪些药物、补充剂或治疗方式？"] },
  { id: "sleep-relaxation", title: "睡眠&放松", kind: "lifestyle", questions: ["通常几点睡、几点起？入睡和夜间睡眠情况如何？", "是否有打鼾、夜醒、白天疲劳或睡眠不足？", "目前有哪些稳定的放松方式？"] },
  { id: "exercise-activity", title: "运动&活动", kind: "lifestyle", questions: ["每周运动频率、类型和时长是多少？", "运动后症状是改善、加重还是没有明显变化？", "日常久坐、体力活动或活动限制情况如何？"] },
  { id: "nutrition-water", title: "营养和水分", kind: "lifestyle", questions: ["一日饮食结构、进餐规律和常见食物是什么？", "饮水量、饮水习惯和咖啡/酒精/含糖饮料情况如何？", "是否存在明确忌口、食物反应或营养摄入不足风险？"] },
  { id: "stress", title: "压力", kind: "lifestyle", questions: ["近期主要压力来源是什么？", "压力是否会影响症状、睡眠、饮食或执行方案？", "面对压力时通常如何应对？"] },
  { id: "social-relationships", title: "人际社交关系", kind: "lifestyle", questions: ["家庭、工作或社交环境中有哪些支持或困难？", "健康管理是否会受到家庭饮食、工作安排或社交活动影响？", "谁可以协助记录、执行和复查？"] }
];

export function createMatrixWorkspace() {
  return { version: "1.0.0", status: "待审核", updatedAt: null, sections: matrixSections.map(section => ({
    sectionId: section.id, title: section.title, kind: section.kind,
    questions: section.questions.map((question, index) => ({ id: `${section.id}-${index + 1}`, question, answer: "", candidateFacts: [], confirmedFacts: [], sources: [], sourceType: "unknown", reviewStatus: "待审核", reviewNote: "" })),
    candidateFacts: [], confirmedFacts: [], interpretation: "", sources: [], reviewStatus: "待审核", reviewNote: ""
  })) };
}
