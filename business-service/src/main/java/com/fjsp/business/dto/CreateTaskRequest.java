package com.fjsp.business.dto;

import java.util.List;
import java.util.Map;

public record CreateTaskRequest(
        String mode,
        List<String> orderIds,
        String oldPlanVersionId,
        String eventId,
        String simulationStartAt,
        Integer freezeWindowMinutes,
        Map<String, Double> objectiveWeights,
        Map<String, Object> algorithm) {
}
