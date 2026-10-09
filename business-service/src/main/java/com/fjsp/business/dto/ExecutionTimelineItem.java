package com.fjsp.business.dto;

import java.time.OffsetDateTime;

/** 工序执行时间线条目。 */
public record ExecutionTimelineItem(String executionRecordId, String operationId, String status,
                                    OffsetDateTime actualStartAt, OffsetDateTime actualEndAt,
                                    OffsetDateTime occurredAt, String reasonCode,
                                    Integer deviationMinutes, String remark, OffsetDateTime createdAt) {
}
