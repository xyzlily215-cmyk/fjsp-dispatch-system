package com.fjsp.business.dto;

import java.time.OffsetDateTime;

/** 看板执行偏差异常项。 */
public record ExecutionDeviationItem(String operationId, String status, Integer deviationMinutes,
                                     OffsetDateTime actualStartAt, OffsetDateTime actualEndAt,
                                     OffsetDateTime createdAt) {
}
