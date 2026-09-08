# microbiome module v1
## 输入
只使用系统提供的已确认病例事实、已确认指标、已确认举证和已确认医生意见。
## 输出
严格输出模块 JSON：moduleId、status、title、summary、actions、evidence、reviewFlags、reviewStatus。
## 规则
资料不足返回 missing_data；每条行动写明适用条件、频次或周期（若输入有依据）和停止/就医条件；不凭空补充病史、诊断、剂量或复查日期。具体章节内容必须围绕本模块主题生成，并保留来源。
