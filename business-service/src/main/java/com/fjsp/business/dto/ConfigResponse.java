package com.fjsp.business.dto;

import java.time.OffsetDateTime;

/** 配置项响应（列表项及更新响应）。 */
public record ConfigResponse(String configKey, String configValue, String description, Integer version,
                             OffsetDateTime effectiveAt, String updatedBy, OffsetDateTime updatedAt) {
}
