package com.fjsp.business.dto;

import java.time.OffsetDateTime;

/** 事件修订响应：新事件基础字段 + 影响汇总。 */
public record EventRevisionResponse(String eventId, String eventCode, String eventType, String subType,
                                    String machineId, String orderId, OffsetDateTime occurredAt,
                                    OffsetDateTime recordedAt, Integer repairDurationMinutes,
                                    OffsetDateTime repairEndAt, String source, String note, String status,
                                    String revisionOf, String revisionReason, OffsetDateTime closedAt,
                                    ImpactSummaryResponse impactSummary) {

    public static EventRevisionResponse of(EventResponse event, ImpactSummaryResponse impactSummary) {
        return new EventRevisionResponse(event.eventId(), event.eventCode(), event.eventType(),
                event.subType(), event.machineId(), event.orderId(), event.occurredAt(),
                event.recordedAt(), event.repairDurationMinutes(), event.repairEndAt(), event.source(),
                event.note(), event.status(), event.revisionOf(), event.revisionReason(),
                event.closedAt(), impactSummary);
    }
}
