package com.fjsp.business.dto;

import java.time.OffsetDateTime;

/** 日历版本历史项（新→旧，current 标记当前生效版本）。 */
public record CalendarVersionResponse(String calendarId, String calendarCode, Integer calendarVersion,
                                      String status, boolean current, String changeNote,
                                      OffsetDateTime createdAt) {
}
