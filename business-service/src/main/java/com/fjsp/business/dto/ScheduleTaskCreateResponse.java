package com.fjsp.business.dto;

/** 创建调度任务的响应（POST /api/v1/schedule-tasks；幂等回放时由存储 JSON 反序列化还原）。 */
public record ScheduleTaskCreateResponse(String taskId, String taskCode, String status,
                                         String snapshotHash) {
}
