package com.fjsp.business.dto;

/** 删除日历区间响应：变更后生成的新版本信息与被删区间 id。 */
public record CalendarIntervalDeletedResponse(String calendarId, String calendarCode, Integer calendarVersion,
                                              String removedIntervalId, String changeNote) {
}
