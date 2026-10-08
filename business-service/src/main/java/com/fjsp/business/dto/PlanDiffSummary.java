package com.fjsp.business.dto;

import java.util.List;

/** 计划版本对比的汇总计数。 */
public record PlanDiffSummary(int comparedOperations, List<String> addedOperations,
                              List<String> removedOperations, int timeShiftedCount,
                              int machineChangedCount, int sequenceChangedCount) {
}
