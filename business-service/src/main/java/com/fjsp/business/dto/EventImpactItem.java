package com.fjsp.business.dto;

/** 事件影响明细项。 */
public record EventImpactItem(String operationId, String impactType, String impactReason,
                              String lockType, String reasonCode) {
}
