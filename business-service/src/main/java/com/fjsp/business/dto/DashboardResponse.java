package com.fjsp.business.dto;

import java.util.List;

/** F-01 看板聚合响应。 */
public record DashboardResponse(DashboardPlanResponse currentPlan, DashboardTimeWindow timeWindow,
                                DashboardOrderStats orderStats, List<DashboardMachineItem> machines,
                                List<DashboardEventItem> recentEvents, List<DashboardTaskItem> recentTasks,
                                DashboardExceptions exceptions) {
}
