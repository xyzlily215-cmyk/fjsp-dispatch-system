package com.fjsp.business.service;

import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;
import java.util.stream.Collectors;

import com.fjsp.business.common.BizException;
import com.fjsp.business.config.FjspProperties;
import com.fjsp.business.entity.Event;
import com.fjsp.business.entity.EventImpact;
import com.fjsp.business.entity.ExecutionRecord;
import com.fjsp.business.entity.InputSnapshot;
import com.fjsp.business.entity.PlanVersion;
import com.fjsp.business.entity.ScheduleOperation;
import com.fjsp.business.entity.ScheduleTask;
import com.fjsp.business.repository.EventImpactRepository;
import com.fjsp.business.repository.EventRepository;
import com.fjsp.business.repository.ExecutionRecordRepository;
import com.fjsp.business.repository.InputSnapshotRepository;
import com.fjsp.business.repository.ScheduleOperationRepository;
import com.fjsp.business.repository.ScheduleTaskRepository;
import org.springframework.stereotype.Service;

@Service
public class ScheduleIntegrityGuard {

    private final ScheduleOperationRepository scheduleOperationRepository;
    private final ExecutionRecordRepository executionRecordRepository;
    private final EventImpactRepository eventImpactRepository;
    private final EventRepository eventRepository;
    private final ScheduleTaskRepository taskRepository;
    private final InputSnapshotRepository inputSnapshotRepository;
    private final FjspProperties properties;

    public ScheduleIntegrityGuard(ScheduleOperationRepository scheduleOperationRepository,
                                  ExecutionRecordRepository executionRecordRepository,
                                  EventImpactRepository eventImpactRepository,
                                  EventRepository eventRepository,
                                  ScheduleTaskRepository taskRepository,
                                  InputSnapshotRepository inputSnapshotRepository,
                                  FjspProperties properties) {
        this.scheduleOperationRepository = scheduleOperationRepository;
        this.executionRecordRepository = executionRecordRepository;
        this.eventImpactRepository = eventImpactRepository;
        this.eventRepository = eventRepository;
        this.taskRepository = taskRepository;
        this.inputSnapshotRepository = inputSnapshotRepository;
        this.properties = properties;
    }

    public void verifyAgainstExecution(PlanVersion pv) {
        if (pv.getParentId() == null) {
            return;
        }
        verifyAgainstExecution(pv, scheduleOperationRepository.findByPlanVersionId(pv.getId()));
    }

    public void verifyAgainstExecution(PlanVersion pv, List<ScheduleOperation> candidateOps) {
        if (pv.getParentId() == null) {
            return;
        }
        List<ScheduleOperation> oldOps = scheduleOperationRepository.findByPlanVersionId(pv.getParentId());
        Map<String, ScheduleOperation> candByOp = candidateOps.stream()
                .collect(Collectors.toMap(ScheduleOperation::getOperationId, Function.identity(), (a, b) -> a));

        ScheduleTask task = pv.getTaskId() != null
                ? taskRepository.findById(pv.getTaskId()).orElse(null) : null;
        Event event = task != null && task.getEventId() != null
                ? eventRepository.findById(task.getEventId()).orElse(null) : null;
        Set<String> affected = new HashSet<>();
        if (event != null) {
            for (EventImpact impact : eventImpactRepository.findByEventId(event.getId())) {
                if (!"HARD_LOCKED".equals(impact.getLockType())) {
                    affected.add(impact.getOperationId());
                }
            }
        }
        InputSnapshot snapshot = pv.getTaskId() != null
                ? inputSnapshotRepository.findByTaskId(pv.getTaskId()).orElse(null) : null;
        OffsetDateTime freezeStart = event != null ? event.getOccurredAt() : simStartOf(snapshot);
        int freezeWindowMinutes = freezeWindowOf(snapshot);
        OffsetDateTime freezeEnd = freezeStart != null ? freezeStart.plusMinutes(freezeWindowMinutes) : null;

        List<String> violations = new ArrayList<>();
        for (ScheduleOperation old : oldOps) {
            String opId = old.getOperationId();
            ScheduleOperation cand = candByOp.get(opId);
            if (executionRecordRepository.existsByOperationIdAndStatus(opId, "COMPLETED")) {
                if (cand == null) {
                    violations.add(opId + "(已完成工序被移除)");
                } else if (!old.getMachineId().equals(cand.getMachineId())
                        || !sameInstant(old.getStartAt(), cand.getStartAt())
                        || !sameInstant(old.getEndAt(), cand.getEndAt())) {
                    violations.add(opId + "(已完成工序的机台/时间被修改)");
                }
                continue;
            }
            var running = executionRecordRepository
                    .findFirstByOperationIdAndStatusAndActualEndAtIsNull(opId, "RUNNING");
            if (running.isPresent()) {
                ExecutionRecord record = running.get();
                if (cand == null) {
                    violations.add(opId + "(执行中工序被移除)");
                } else if (!old.getMachineId().equals(cand.getMachineId())) {
                    violations.add(opId + "(执行中工序的机台被修改)");
                } else if (record.getActualStartAt() != null
                        && !sameInstant(record.getActualStartAt(), cand.getStartAt())) {
                    // 实际开工即事实：候选窗口必须以实际上报的开始时间为锚
                    violations.add(opId + "(执行中工序的开始时间与实际上报不一致)");
                } else if (record.getActualStartAt() == null
                        && !sameInstant(old.getStartAt(), cand.getStartAt())) {
                    violations.add(opId + "(执行中工序的开始时间被修改)");
                } else if (record.getActualStartAt() != null
                        && cand.getEndAt().isBefore(record.getActualStartAt())) {
                    violations.add(opId + "(执行中工序的结束时间早于实际开始时间)");
                }
                continue;
            }
            if (freezeStart != null && !affected.contains(opId)
                    && !old.getStartAt().isBefore(freezeStart)
                    && old.getStartAt().isBefore(freezeEnd)) {
                if (cand == null) {
                    violations.add(opId + "(冻结窗内工序被移除)");
                } else if (!old.getMachineId().equals(cand.getMachineId())
                        || !sameInstant(old.getStartAt(), cand.getStartAt())
                        || !sameInstant(old.getEndAt(), cand.getEndAt())) {
                    violations.add(opId + "(冻结窗内工序的机台/时间被修改)");
                }
            }
        }
        if (!violations.isEmpty()) {
            throw BizException.integrityViolation(
                    "新方案违反执行完整性约束: " + String.join("; ", violations));
        }
    }

    private static boolean sameInstant(OffsetDateTime a, OffsetDateTime b) {
        return a != null && b != null && a.isEqual(b);
    }

    private static OffsetDateTime simStartOf(InputSnapshot snapshot) {
        if (snapshot == null || snapshot.getSnapshotJson() == null) {
            return null;
        }
        Object value = snapshot.getSnapshotJson().get("simulationStartAt");
        return value != null ? OffsetDateTime.parse(value.toString()) : null;
    }

    private int freezeWindowOf(InputSnapshot snapshot) {
        if (snapshot != null && snapshot.getSnapshotJson() != null) {
            Object value = snapshot.getSnapshotJson().get("freezeWindowMinutes");
            if (value instanceof Number) {
                return ((Number) value).intValue();
            }
        }
        return (int) properties.getFreezeWindow().toMinutes();
    }
}
