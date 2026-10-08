package com.fjsp.business.service;

import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

import com.fjsp.business.common.LookupSupport;
import com.fjsp.business.dto.PlanDiffOperation;
import com.fjsp.business.dto.PlanDiffResponse;
import com.fjsp.business.dto.PlanDiffSummary;
import com.fjsp.business.entity.EventImpact;
import com.fjsp.business.entity.PlanVersion;
import com.fjsp.business.entity.ScheduleOperation;
import com.fjsp.business.entity.ScheduleTask;
import com.fjsp.business.repository.EventImpactRepository;
import com.fjsp.business.repository.PlanVersionRepository;
import com.fjsp.business.repository.ScheduleOperationRepository;
import com.fjsp.business.repository.ScheduleTaskRepository;
import org.springframework.stereotype.Service;

@Service
public class PlanDiffService {

    private final PlanVersionRepository planVersionRepository;
    private final ScheduleOperationRepository scheduleOperationRepository;
    private final EventImpactRepository eventImpactRepository;
    private final ScheduleTaskRepository taskRepository;

    public PlanDiffService(PlanVersionRepository planVersionRepository,
                           ScheduleOperationRepository scheduleOperationRepository,
                           EventImpactRepository eventImpactRepository,
                           ScheduleTaskRepository taskRepository) {
        this.planVersionRepository = planVersionRepository;
        this.scheduleOperationRepository = scheduleOperationRepository;
        this.eventImpactRepository = eventImpactRepository;
        this.taskRepository = taskRepository;
    }

    private PlanVersion find(String idOrCode) {
        return LookupSupport.byIdOrCode(idOrCode, planVersionRepository::findById,
                planVersionRepository::findByVersionCode, "计划版本不存在");
    }

    public PlanDiffResponse diff(String idOrCode, String baselineIdOrCode) {
        PlanVersion candidate = find(idOrCode);
        PlanVersion baseline = find(baselineIdOrCode);
        Map<String, ScheduleOperation> baseOps = scheduleOperationRepository
                .findByPlanVersionId(baseline.getId()).stream()
                .collect(Collectors.toMap(ScheduleOperation::getOperationId, o -> o));
        Map<String, ScheduleOperation> candOps = scheduleOperationRepository
                .findByPlanVersionId(candidate.getId()).stream()
                .collect(Collectors.toMap(ScheduleOperation::getOperationId, o -> o));

        // 影响记录只取触发候选版本的事件（task -> event），不再捞全表。
        // 一个事件对同一工序至多产生一条影响记录（ImpactCalculator 按工序去重），取值确定。
        Map<String, String> impactTypeByOp = new HashMap<>();
        ScheduleTask task = candidate.getTaskId() != null
                ? taskRepository.findById(candidate.getTaskId()).orElse(null) : null;
        if (task != null && task.getEventId() != null) {
            for (EventImpact impact : eventImpactRepository.findByEventId(task.getEventId())) {
                impactTypeByOp.put(impact.getOperationId(), impact.getImpactType());
            }
        }

        Map<String, Map<String, Integer>> baseSeqRank = sequenceRanks(new ArrayList<>(baseOps.values()));
        Map<String, Map<String, Integer>> candSeqRank = sequenceRanks(new ArrayList<>(candOps.values()));

        List<PlanDiffOperation> diffs = new ArrayList<>();
        List<String> added = new ArrayList<>();
        List<String> removed = new ArrayList<>();
        int shifted = 0;
        int machineChanged = 0;
        int sequenceChanged = 0;

        for (ScheduleOperation cand : candOps.values()) {
            ScheduleOperation base = baseOps.get(cand.getOperationId());
            if (base == null) {
                added.add(cand.getOperationId());
                continue;
            }
            long shift = Duration.between(base.getStartAt().toInstant(),
                    cand.getStartAt().toInstant()).toMinutes();
            boolean machineChangedFlag = !base.getMachineId().equals(cand.getMachineId());
            Integer oldRank = rankOf(baseSeqRank, base);
            Integer newRank = rankOf(candSeqRank, cand);
            boolean seqChangedFlag = !machineChangedFlag && oldRank != null && newRank != null
                    && !oldRank.equals(newRank);
            if (shift != 0) {
                shifted++;
            }
            if (machineChangedFlag) {
                machineChanged++;
            }
            if (seqChangedFlag) {
                sequenceChanged++;
            }
            diffs.add(new PlanDiffOperation(cand.getOperationId(), shift, machineChangedFlag,
                    seqChangedFlag, base.getMachineId(), cand.getMachineId(), base.getStartAt(),
                    cand.getStartAt(), cand.getFrozen(), cand.getReasonCode(),
                    impactTypeByOp.get(cand.getOperationId())));
        }
        for (String opId : baseOps.keySet()) {
            if (!candOps.containsKey(opId)) {
                removed.add(opId);
            }
        }
        diffs.sort(Comparator.comparing(PlanDiffOperation::operationId));

        PlanDiffSummary summary = new PlanDiffSummary(diffs.size(), added, removed, shifted,
                machineChanged, sequenceChanged);

        Map<String, Double> kpiDiff = new LinkedHashMap<>();
        Map<String, Object> baseKpi = baseline.getKpi() != null ? baseline.getKpi() : Map.of();
        Map<String, Object> candKpi = candidate.getKpi() != null ? candidate.getKpi() : Map.of();
        for (String key : candKpi.keySet()) {
            Object cv = candKpi.get(key);
            Object bv = baseKpi.get(key);
            if (cv instanceof Number && bv instanceof Number) {
                kpiDiff.put(key, ((Number) cv).doubleValue() - ((Number) bv).doubleValue());
            }
        }

        return new PlanDiffResponse(baseline.getId(), baseline.getVersionCode(), candidate.getId(),
                candidate.getVersionCode(), summary, kpiDiff, diffs);
    }

    private Map<String, Map<String, Integer>> sequenceRanks(List<ScheduleOperation> ops) {
        Map<String, List<ScheduleOperation>> byMachine = ops.stream()
                .collect(Collectors.groupingBy(ScheduleOperation::getMachineId));
        Map<String, Map<String, Integer>> ranks = new HashMap<>();
        byMachine.forEach((machine, list) -> {
            list.sort(Comparator.comparing(ScheduleOperation::getStartAt));
            Map<String, Integer> rank = new HashMap<>();
            for (int i = 0; i < list.size(); i++) {
                rank.put(list.get(i).getOperationId(), i);
            }
            ranks.put(machine, rank);
        });
        return ranks;
    }

    private Integer rankOf(Map<String, Map<String, Integer>> ranks, ScheduleOperation op) {
        Map<String, Integer> machineRanks = ranks.get(op.getMachineId());
        return machineRankNullSafe(machineRanks, op.getOperationId());
    }

    private Integer machineRankNullSafe(Map<String, Integer> machineRanks, String opId) {
        return machineRanks == null ? null : machineRanks.get(opId);
    }
}
