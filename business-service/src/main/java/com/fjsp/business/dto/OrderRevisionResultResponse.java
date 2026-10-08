package com.fjsp.business.dto;

import java.time.OffsetDateTime;

/** 订单修订响应：订单基础字段 + 重排提示。 */
public record OrderRevisionResultResponse(String orderId, String orderCode, String productFamily,
                                          Integer quantity, OffsetDateTime arrivalAt, OffsetDateTime dueAt,
                                          Integer priority, String status, String templateId, String remark,
                                          Integer revisionNo, Boolean needsReschedule, String message) {

    public static OrderRevisionResultResponse of(OrderResponse order, Boolean needsReschedule, String message) {
        return new OrderRevisionResultResponse(order.orderId(), order.orderCode(), order.productFamily(),
                order.quantity(), order.arrivalAt(), order.dueAt(), order.priority(), order.status(),
                order.templateId(), order.remark(), order.revisionNo(), needsReschedule, message);
    }
}
