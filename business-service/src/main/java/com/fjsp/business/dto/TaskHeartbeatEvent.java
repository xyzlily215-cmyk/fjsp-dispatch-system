package com.fjsp.business.dto;

/** SSE heartbeat 事件载荷。 */
public record TaskHeartbeatEvent(String taskId, String status, Integer progress, long elapsedMs) {
}
