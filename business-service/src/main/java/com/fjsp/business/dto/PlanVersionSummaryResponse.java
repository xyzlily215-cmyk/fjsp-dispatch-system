package com.fjsp.business.dto;

import java.time.OffsetDateTime;
import java.util.Map;

/** 计划版本摘要（列表项及提交审核/修订/审批/发布/回滚等操作响应）。 */
public record PlanVersionSummaryResponse(String id, String versionCode, String parentId,
                                         String candidateGroupId, String candidateType, String status,
                                         String taskId, Map<String, Object> kpi, Long version,
                                         String reviewComment, String reviewedBy,
                                         OffsetDateTime reviewedAt, String publishedBy,
                                         OffsetDateTime publishedAt, OffsetDateTime createdAt) {
}
