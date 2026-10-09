package com.fjsp.business.dto;

public record CalendarIntervalRequest(
        String intervalType,
        String startAt,
        String endAt,
        String note) {
}
