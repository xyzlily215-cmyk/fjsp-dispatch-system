package com.fjsp.business.dto;

public record OrderUpsertRequest(
        String orderCode,
        String productFamily,
        Integer quantity,
        String arrivalAt,
        String dueAt,
        Integer priority,
        String templateId) {
}
