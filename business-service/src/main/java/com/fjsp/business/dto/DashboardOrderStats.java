package com.fjsp.business.dto;

import java.util.Map;

/** 看板订单统计卡片：订单总数 + 按状态分组计数（byStatus 键为动态状态值，保持 Map）。 */
public record DashboardOrderStats(long total, Map<String, Long> byStatus) {
}
