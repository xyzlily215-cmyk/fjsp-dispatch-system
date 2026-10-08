package com.fjsp.business.dto;

import java.time.OffsetDateTime;

/** 看板最近事件项（含影响工序数）。 */
public record DashboardEventItem(String eventId, String eventCode, String eventType, String subType,
                                 String machineId, String orderId, OffsetDateTime occurredAt,
                                 String status, Long impactCount) {
}
