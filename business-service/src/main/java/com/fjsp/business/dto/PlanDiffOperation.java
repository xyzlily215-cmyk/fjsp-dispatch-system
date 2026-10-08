package com.fjsp.business.dto;

import java.time.OffsetDateTime;

/** 计划版本对比的单工序差异。 */
public record PlanDiffOperation(String operationId, long timeShiftMinutes, boolean machineChanged,
                                boolean sequenceChanged, String oldMachineId, String newMachineId,
                                OffsetDateTime oldStartAt, OffsetDateTime newStartAt,
                                Boolean frozen, String reasonCode, String impactType) {
}
