package com.fjsp.business.dto;

import java.util.List;
import java.util.Map;

/** 工艺模板响应（列表项及创建/状态变更/复制响应）。 */
public record ProcessTemplateResponse(String templateId, String templateCode, String productFamily,
                                      Integer templateVersion, String status,
                                      List<TemplateOperationItem> operations) {

    /** 模板工序项；defaultCandidates 为 JSONB 候选设备快照，保持 Map 结构。 */
    public record TemplateOperationItem(Integer sequenceNo, String operationCode,
                                        List<Map<String, Object>> defaultCandidates) {
    }
}
