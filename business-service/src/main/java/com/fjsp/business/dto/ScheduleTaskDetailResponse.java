package com.fjsp.business.dto;

import java.time.OffsetDateTime;
import java.util.Map;

/** 调度任务详情（GET /api/v1/schedule-tasks/{taskId}，重试/取消响应同构）。 */
public record ScheduleTaskDetailResponse(String taskId, String taskCode, String mode, String status,
                                         Integer progress, String resultStatus, Boolean feasibleSolution,
                                         String planVersionId, String candidateGroupId,
                                         Integer retryCount, Integer maxRetries,
                                         OffsetDateTime nextRetryAt, OffsetDateTime timeoutAt,
                                         Boolean cancelRequested, OffsetDateTime createdAt,
                                         String snapshotHash, String algorithmVersion, Integer randomSeed,
                                         Long elapsedMs, Map<String, Object> kpi, Object conflicts,
                                         String errorMessage, String oldPlanVersionId, String eventId,
                                         OffsetDateTime startedAt, OffsetDateTime finishedAt) {
}
