package com.fjsp.business.dto;

/**
 * 已排程订单的工艺字段修订请求：reason 必填；其余为待修订的工艺字段，
 * 未提供的字段保持原值。productFamily 变更时必须同时给出同族的 templateId。
 */
public record OrderRevisionRequest(
        String reason,
        String productFamily,
        String templateId,
        Integer quantity,
        Integer priority,
        String arrivalAt,
        String dueAt) {
}
