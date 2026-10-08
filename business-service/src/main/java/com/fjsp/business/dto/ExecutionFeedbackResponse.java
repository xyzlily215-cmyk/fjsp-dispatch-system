package com.fjsp.business.dto;

import java.time.OffsetDateTime;

/** 执行反馈响应：本次反馈落库的执行记录 + 所属计划版本状态。 */
public record ExecutionFeedbackResponse(String executionRecordId, String operationId, String status,
                                        OffsetDateTime actualStartAt, OffsetDateTime actualEndAt,
                                        OffsetDateTime occurredAt, String reasonCode,
                                        Integer deviationMinutes, String planVersionId,
                                        String planVersionStatus) {
}
