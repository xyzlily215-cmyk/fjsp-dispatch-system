package com.fjsp.business.entity;

/**
 * work_calendar.status 的取值集合。数据库列仍为字符串。
 * 日历变更生成新版本行，旧版本归档为 ARCHIVED，仅 ACTIVE 版本可变更。
 */
public final class CalendarStatus {

    public static final String ACTIVE = "ACTIVE";
    public static final String ARCHIVED = "ARCHIVED";

    private CalendarStatus() {
    }
}
