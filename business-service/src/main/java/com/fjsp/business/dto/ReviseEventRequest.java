package com.fjsp.business.dto;

/**
 * 事件修订请求：reason 必填；其余字段为可选覆盖项（null 表示沿用原事件值）。
 * BREAKDOWN 可覆盖 occurredAt / repairDurationMinutes / source / note；
 * NEW_ORDER 可覆盖 occurredAt / subType / note（订单本体不随事件修订重建）。
 */
public record ReviseEventRequest(
        String reason,
        String occurredAt,
        Integer repairDurationMinutes,
        String source,
        String subType,
        String note) {
}
