package com.fjsp.business.dto;

import java.time.OffsetDateTime;

/** 计划版本工序明细（含订单维度字段与执行聚合标记）。 */
public record PlanOperationResponse(String operationId, String machineId,
                                    OffsetDateTime setupStartAt, OffsetDateTime processStartAt,
                                    OffsetDateTime startAt, OffsetDateTime endAt,
                                    Integer changeoverMinutes, Boolean frozen, Boolean affected,
                                    String reasonCode, String orderId, Integer sequenceNo,
                                    String operationStatus, String orderCode, String productFamily,
                                    Integer priority, OffsetDateTime dueAt,
                                    boolean executionCompleted, boolean executionDeviation,
                                    Integer deviationMinutes, boolean executionException,
                                    boolean executionPaused) {
}
