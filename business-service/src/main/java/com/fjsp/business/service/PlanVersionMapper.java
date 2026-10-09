package com.fjsp.business.service;

import com.fjsp.business.dto.PlanVersionSummaryResponse;
import com.fjsp.business.entity.PlanVersion;
import org.springframework.stereotype.Component;

@Component
public class PlanVersionMapper {

    public PlanVersionSummaryResponse toSummary(PlanVersion pv) {
        return new PlanVersionSummaryResponse(pv.getId(), pv.getVersionCode(), pv.getParentId(),
                pv.getCandidateGroupId(), pv.getCandidateType(), pv.getStatus(), pv.getTaskId(),
                pv.getKpi(), pv.getVersion(), pv.getReviewComment(), pv.getReviewedBy(),
                pv.getReviewedAt(), pv.getPublishedBy(), pv.getPublishedAt(), pv.getCreatedAt());
    }
}
