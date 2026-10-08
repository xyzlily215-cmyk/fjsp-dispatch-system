package com.fjsp.business.dto;

/**
 * 订单编辑请求。quantity/priority/arrivalAt/dueAt 为工艺字段：仅未排程订单可直接改；
 * remark 为基础字段：任何状态下都可改。未提供的字段保持原值。
 */
public record OrderUpdateRequest(
        Integer quantity,
        Integer priority,
        String arrivalAt,
        String dueAt,
        String remark) {
}
