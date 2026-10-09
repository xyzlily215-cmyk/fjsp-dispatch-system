package com.fjsp.business.dto;

import java.time.OffsetDateTime;
import java.util.List;

/** 订单列表项：基础字段 + scheduled 标记 + 工序列表。 */
public record OrderListItemResponse(String orderId, String orderCode, String productFamily, Integer quantity,
                                    OffsetDateTime arrivalAt, OffsetDateTime dueAt, Integer priority,
                                    String status, String templateId, String remark, Integer revisionNo,
                                    boolean scheduled, List<OrderOperationItem> operations) {
}
