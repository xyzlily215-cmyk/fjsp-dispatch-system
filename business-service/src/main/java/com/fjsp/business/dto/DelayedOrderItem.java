package com.fjsp.business.dto;

import java.time.OffsetDateTime;

/** 看板延期订单异常项。 */
public record DelayedOrderItem(String orderId, String orderCode, OffsetDateTime dueAt,
                               OffsetDateTime plannedCompletionAt) {
}
