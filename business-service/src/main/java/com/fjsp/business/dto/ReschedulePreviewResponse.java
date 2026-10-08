package com.fjsp.business.dto;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;

/** F-08 重调度影响范围预览：锁定分类计数 + 影响订单 + 两种重排模式的预计求解规模。 */
public record ReschedulePreviewResponse(String eventId, String eventCode, String eventType,
                                        OffsetDateTime occurredAt, String planVersionId,
                                        String planVersionCode, int freezeWindowMinutes,
                                        int hardLockedCount, int softLockedCount,
                                        int impactedOperationCount, int impactedOrderCount,
                                        List<String> impactedOrders, ImpactSummaryResponse impactSummary,
                                        Map<String, ModeEstimate> modeEstimates) {

    /** 单个重排模式（LOCAL_RESCHEDULE / FULL_RESCHEDULE）的预计求解规模。 */
    public record ModeEstimate(int estimatedOperationCount) {
    }
}
