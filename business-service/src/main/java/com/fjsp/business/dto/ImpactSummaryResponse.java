package com.fjsp.business.dto;

import java.util.Map;

/** 事件影响汇总：影响工序总数 + 按影响类型分组计数（byType 键为动态影响类型，保持 Map）。 */
public record ImpactSummaryResponse(int total, Map<String, Long> byType) {
}
