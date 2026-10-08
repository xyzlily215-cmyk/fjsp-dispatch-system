package com.fjsp.business.dto;

import java.util.List;
import java.util.Map;

/** 订单工序项（订单列表内嵌）；candidates 为 JSONB 候选设备快照，保持 Map 结构。 */
public record OrderOperationItem(String operationId, Integer seqNo, String status,
                                 List<Map<String, Object>> candidates) {
}
