package com.fjsp.business.dto;

import java.util.List;
import java.util.Map;

/**
 * 看板异常聚合。items 为四类异常的统一排序视图，条目字段随类型（延期订单/故障/不可行任务/执行偏差）
 * 而异构，保持 Map 结构；分类列表各自为强类型 record。
 */
public record DashboardExceptions(List<DelayedOrderItem> delayedOrders,
                                  List<DashboardBreakdownItem> breakdowns,
                                  List<ExecutionDeviationItem> executionDeviations,
                                  List<DashboardTaskItem> infeasibleTasks,
                                  List<Map<String, Object>> items) {
}
