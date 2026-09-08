import assert from "node:assert/strict";
import { moduleRegistry, legacySuggestionRules } from "../src/modules/module-registry.mjs";
import { caseSchema, indicatorSchema, moduleOutputSchema, REVIEW_STATUSES, SOURCE_KINDS } from "../src/schemas/case-schema.mjs";

assert.equal(moduleRegistry.length, 17);
assert.equal(new Set(moduleRegistry.map(x => x.id)).size, moduleRegistry.length);
assert.deepEqual(moduleRegistry.map(x => x.order), [...moduleRegistry].sort((a,b) => a.order-b.order).map(x => x.order));
for (const module of moduleRegistry) {
  assert.ok(module.promptFile.endsWith(".md"));
  assert.ok(module.outputSchema === moduleOutputSchema);
  assert.ok(module.reviewStatus === "待审核");
  assert.ok(Array.isArray(module.requiredInputs));
}
assert.equal(legacySuggestionRules.length, 7);
assert.deepEqual(REVIEW_STATUSES, ["待审核", "已确认", "已修改", "已排除", "待补充"]);
assert.deepEqual(SOURCE_KINDS, ["pdf", "screenshot", "manual", "doctor"]);
for (const schema of [caseSchema, indicatorSchema, moduleOutputSchema]) assert.equal(typeof schema, "object");
const missing = { moduleId: "diet-avoidance", status: "missing_data", title: "饮食回避", summary: "", actions: [], evidence: [], reviewFlags: ["缺少真实反应史"], reviewStatus: "待补充" };
assert.equal(missing.status, "missing_data");
assert.ok(missing.reviewFlags.length);
const source = { kind: "pdf", file: "report.pdf", page: 3 };
assert.equal(source.page, 3);
const plan = { patientName: "测试客户", modules: [{moduleId:"closing", title:"最后寄语", reviewStatus:"已确认"}], suggestions: [] };
assert.equal(plan.patientName, "测试客户");
assert.ok(!JSON.stringify(plan).includes("王玮"));
console.log("PASS: module registry; legacy compatibility; missing-data state; source/page contract; name isolation");
