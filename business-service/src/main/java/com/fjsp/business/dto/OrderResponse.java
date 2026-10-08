package com.fjsp.business.dto;

import java.time.OffsetDateTime;

/** 订单响应（创建/更新/修订共用的基础字段，见 OrderSupport）。 */
public record OrderResponse(String orderId, String orderCode, String productFamily, Integer quantity,
                            OffsetDateTime arrivalAt, OffsetDateTime dueAt, Integer priority, String status,
                            String templateId, String remark, Integer revisionNo) {
}
