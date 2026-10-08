package com.fjsp.business.dto;

import java.time.OffsetDateTime;
import java.util.Map;

/** 计划版本详情：摘要字段 + 工序总数（工序明细由 /operations 分页获取，不内嵌）。 */
public record PlanVersionDetailResponse(String id, String versionCode, String parentId,
                                        String candidateGroupId, String candidateType, String status,
                                        String taskId, Map<String, Object> kpi, Long version,
                                        String reviewComment, String reviewedBy,
                                        OffsetDateTime reviewedAt, String publishedBy,
                                        OffsetDateTime publishedAt, OffsetDateTime createdAt,
                                        long operationCount) {

    public static PlanVersionDetailResponse of(PlanVersionSummaryResponse s, long operationCount) {
        return new PlanVersionDetailResponse(s.id(), s.versionCode(), s.parentId(),
                s.candidateGroupId(), s.candidateType(), s.status(), s.taskId(), s.kpi(), s.version(),
                s.reviewComment(), s.reviewedBy(), s.reviewedAt(), s.publishedBy(), s.publishedAt(),
                s.createdAt(), operationCount);
    }
}
