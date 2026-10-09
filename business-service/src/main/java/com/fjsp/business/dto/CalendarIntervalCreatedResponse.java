package com.fjsp.business.dto;

import java.time.OffsetDateTime;

/** 新增日历区间响应：区间字段 + 变更后生成的日历版本号。 */
public record CalendarIntervalCreatedResponse(String intervalId, String calendarId, String intervalType,
                                              OffsetDateTime startAt, OffsetDateTime endAt, String note,
                                              Integer calendarVersion) {
}
