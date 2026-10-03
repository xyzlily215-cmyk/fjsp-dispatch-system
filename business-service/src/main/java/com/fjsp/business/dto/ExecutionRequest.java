package com.fjsp.business.dto;

public record ExecutionRequest(
        String status,
        String actualStartAt,
        String actualEndAt,
        String remark) {
}
