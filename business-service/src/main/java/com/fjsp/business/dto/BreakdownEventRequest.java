package com.fjsp.business.dto;

public record BreakdownEventRequest(
        String machineId,
        String occurredAt,
        Integer repairDurationMinutes,
        String source,
        String note) {
}
