package com.fjsp.business.dto;

import java.time.OffsetDateTime;

/** 看板算法任务项（最近任务与不可行任务共用）。 */
public record DashboardTaskItem(String taskId, String taskCode, String mode, String status,
                                Integer progress, Long elapsedMs, String resultStatus,
                                String errorMessage, String planVersionId, OffsetDateTime createdAt,
                                OffsetDateTime startedAt, OffsetDateTime finishedAt) {
}
