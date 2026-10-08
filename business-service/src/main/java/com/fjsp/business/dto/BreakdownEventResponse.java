package com.fjsp.business.dto;

import java.time.OffsetDateTime;

/** 故障事件登记响应：事件 + 维修区间 + 影响汇总。 */
public record BreakdownEventResponse(String eventId, String eventCode, String machineId,
                                     OffsetDateTime occurredAt, OffsetDateTime repairEndAt,
                                     ImpactSummaryResponse impactSummary) {
}
