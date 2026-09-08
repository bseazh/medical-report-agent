export const CASE_SCHEMA_VERSION = "1.0.0";
export const REVIEW_STATUSES = ["待审核", "已确认", "已修改", "已排除", "待补充"];
export const SOURCE_KINDS = ["pdf", "screenshot", "manual", "doctor"];
export const caseSchema = {
  version: CASE_SCHEMA_VERSION,
  patient: { name: "string", gender: "string|null", age: "number|null", birthDate: "string|null", heightCm: "number|null", weightKg: "number|null", bmi: "number|null", title: "string|null", chiefComplaint: "string|null", goals: "string[]", reviewStatus: REVIEW_STATUSES },
  history: { confirmed: "Fact[]", selfReported: "Fact[]", unknown: "string[]" },
  symptoms: { confirmed: "Fact[]", selfReported: "Fact[]", unknown: "string[]" },
  medications: "Medication[]", supplements: "Medication[]", foodReactions: "FoodReaction[]", reports: "Report[]", doctorPlan: "Fact[]", sources: "Source[]"
};
export const indicatorSchema = { id: "string", name: "string", value: "string|number|null", unit: "string|null", reference: "string|null", status: ["正常", "异常", "待确认"], severity: "string|null", dimension: "string|null", reportType: "string|null", raw: "string|null", source: "Source", reviewStatus: REVIEW_STATUSES };
export const moduleOutputSchema = { moduleId: "string", status: ["not_applicable", "missing_data", "draft", "confirmed", "excluded"], title: "string", summary: "string", actions: "Action[]", evidence: "Evidence[]", reviewFlags: "string[]", reviewStatus: REVIEW_STATUSES };
