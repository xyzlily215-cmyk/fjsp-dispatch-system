package com.fjsp.business.dto;

import java.time.OffsetDateTime;
import java.util.Map;

/** 看板当前计划版本卡片；kpi 为 JSONB 扩展指标，保持 Map 结构。 */
public record DashboardPlanResponse(String id, String versionCode, String status, String candidateType,
                                    OffsetDateTime publishedAt, Map<String, Object> kpi) {
}
