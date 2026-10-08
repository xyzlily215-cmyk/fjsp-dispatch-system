package com.fjsp.business.dto;

import java.time.OffsetDateTime;

/** 日历区间响应（区间列表项）。 */
public record CalendarIntervalResponse(String intervalId, String calendarId, String intervalType,
                                       OffsetDateTime startAt, OffsetDateTime endAt, String note) {
}
