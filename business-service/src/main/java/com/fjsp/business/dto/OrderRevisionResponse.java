package com.fjsp.business.dto;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;

/** 订单修订记录（修订链列表项）；changedFields 为 JSONB 前后值差异，保持 Map 结构。 */
public record OrderRevisionResponse(String revisionId, String orderId, Integer revisionNo, String reason,
                                    List<Map<String, Object>> changedFields, String operator,
                                    OffsetDateTime createdAt) {
}
