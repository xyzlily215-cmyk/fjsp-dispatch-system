package com.fjsp.business.dto;

import java.time.OffsetDateTime;

/** 事件响应（列表项、关闭结果等事件基础字段视图）。 */
public record EventResponse(String eventId, String eventCode, String eventType, String subType,
                            String machineId, String orderId, OffsetDateTime occurredAt,
                            OffsetDateTime recordedAt, Integer repairDurationMinutes,
                            OffsetDateTime repairEndAt, String source, String note, String status,
                            String revisionOf, String revisionReason, OffsetDateTime closedAt) {
}
