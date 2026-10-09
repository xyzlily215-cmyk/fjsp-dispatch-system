package com.fjsp.business.dto;

import java.time.OffsetDateTime;

/** 看板实际应用的时间窗口（未过滤时各字段为 null）。 */
public record DashboardTimeWindow(String window, OffsetDateTime from, OffsetDateTime to) {
}
