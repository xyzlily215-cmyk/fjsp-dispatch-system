package com.fjsp.business.dto;

import java.time.OffsetDateTime;

/** 调度任务列表项摘要（GET /api/v1/schedule-tasks 分页 items）。 */
public record ScheduleTaskSummaryResponse(String taskId, String taskCode, String mode, String status,
                                          Integer progress, String resultStatus, Boolean feasibleSolution,
                                          String planVersionId, String candidateGroupId,
                                          Integer retryCount, Integer maxRetries,
                                          OffsetDateTime nextRetryAt, OffsetDateTime timeoutAt,
                                          Boolean cancelRequested, OffsetDateTime createdAt) {
}
