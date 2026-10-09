package com.fjsp.business.dto;

import java.time.OffsetDateTime;
import java.util.List;

/** 事件详情：事件基础字段 + 影响明细/汇总 + 关联任务 + 修订链。 */
public record EventDetailResponse(String eventId, String eventCode, String eventType, String subType,
                                  String machineId, String orderId, OffsetDateTime occurredAt,
                                  OffsetDateTime recordedAt, Integer repairDurationMinutes,
                                  OffsetDateTime repairEndAt, String source, String note, String status,
                                  String revisionOf, String revisionReason, OffsetDateTime closedAt,
                                  List<EventImpactItem> impacts, ImpactSummaryResponse impactSummary,
                                  List<EventRelatedTaskItem> relatedTasks, List<EventRevisionItem> revisions) {

    public static EventDetailResponse of(EventResponse event, List<EventImpactItem> impacts,
                                         ImpactSummaryResponse impactSummary,
                                         List<EventRelatedTaskItem> relatedTasks,
                                         List<EventRevisionItem> revisions) {
        return new EventDetailResponse(event.eventId(), event.eventCode(), event.eventType(),
                event.subType(), event.machineId(), event.orderId(), event.occurredAt(),
                event.recordedAt(), event.repairDurationMinutes(), event.repairEndAt(), event.source(),
                event.note(), event.status(), event.revisionOf(), event.revisionReason(),
                event.closedAt(), impacts, impactSummary, relatedTasks, revisions);
    }
}
