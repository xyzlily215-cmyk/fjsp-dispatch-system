package com.fjsp.business.dto;

import java.util.List;
import java.util.Map;

/** 计划版本对比响应（候选版本 vs 基准版本）。 */
public record PlanDiffResponse(String baselineVersionId, String baselineVersionCode,
                               String candidateVersionId, String candidateVersionCode,
                               PlanDiffSummary summary, Map<String, Double> kpiDiff,
                               List<PlanDiffOperation> operations) {
}
