package com.fjsp.business.dto;

import java.util.List;

/** 插单事件登记响应：事件 + 新订单与其实例化工序 + 影响汇总。 */
public record NewOrderEventResponse(String eventId, String eventCode, String orderId, String orderCode,
                                    List<String> operationIds, ImpactSummaryResponse impactSummary) {
}
