package com.fjsp.business.dto;

import java.time.OffsetDateTime;

/** 看板设备故障异常项。 */
public record DashboardBreakdownItem(String eventCode, String machineId, OffsetDateTime occurredAt,
                                     OffsetDateTime repairEndAt) {
}
