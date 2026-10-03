package com.fjsp.business.dto;

public record OrderUpdateRequest(
        Integer quantity,
        Integer priority,
        String arrivalAt,
        String dueAt) {
}
