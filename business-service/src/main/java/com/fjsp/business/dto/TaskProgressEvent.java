package com.fjsp.business.dto;

/** SSE progress 事件载荷（订阅回放与状态迁移推送共用）。 */
public record TaskProgressEvent(String taskId, String taskCode, String status, Integer progress,
                                String stage, long elapsedMs, String resultStatus,
                                Boolean feasibleSolution, Boolean cancelRequested,
                                String errorMessage, boolean terminal) {
}
