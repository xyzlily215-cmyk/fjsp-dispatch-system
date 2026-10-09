package com.fjsp.business.dto;

import java.time.OffsetDateTime;
import java.util.List;

/** 订单创建响应：订单基础字段 + 实例化工序 id 列表。 */
public record OrderCreateResponse(String orderId, String orderCode, String productFamily, Integer quantity,
                                  OffsetDateTime arrivalAt, OffsetDateTime dueAt, Integer priority,
                                  String status, String templateId, String remark, Integer revisionNo,
                                  List<String> operationIds) {

    public static OrderCreateResponse of(OrderResponse order, List<String> operationIds) {
        return new OrderCreateResponse(order.orderId(), order.orderCode(), order.productFamily(),
                order.quantity(), order.arrivalAt(), order.dueAt(), order.priority(), order.status(),
                order.templateId(), order.remark(), order.revisionNo(), operationIds);
    }
}
