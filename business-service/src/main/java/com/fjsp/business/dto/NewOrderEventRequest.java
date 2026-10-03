package com.fjsp.business.dto;

public record NewOrderEventRequest(
        String subType,
        String orderCode,
        String productFamily,
        Integer quantity,
        String arrivalAt,
        String dueAt,
        Integer priority,
        String occurredAt,
        String note) {
}
