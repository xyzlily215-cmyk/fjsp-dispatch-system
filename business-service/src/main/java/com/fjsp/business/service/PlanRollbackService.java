package com.fjsp.business.service;

import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;

import com.fjsp.business.common.BizException;
import com.fjsp.business.common.LookupSupport;
import com.fjsp.business.config.FjspProperties;
import com.fjsp.business.dto.PlanVersionSummaryResponse;
import com.fjsp.business.dto.RollbackRequest;
import com.fjsp.business.entity.ExecutionRecord;
import com.fjsp.business.entity.PlanVersion;
import com.fjsp.business.entity.ScheduleOperation;
import com.fjsp.business.repository.ExecutionRecordRepository;
import com.fjsp.business.repository.PlanVersionRepository;
import com.fjsp.business.repository.ScheduleOperationRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class PlanRollbackService {

    private static final Logger log = LoggerFactory.getLogger(PlanRollbackService.class);

    private final PlanVersionRepository planVersionRepository;
    private final ScheduleOperationRepository scheduleOperationRepository;
    private final ExecutionRecordRepository executionRecordRepository;
    private final AuditService auditService;
    private final CodeGenerator codeGenerator;
    private final FjspProperties properties;
    private final PlanVersionMapper planVersionMapper;

    public PlanRollbackService(PlanVersionRepository planVersionRepository,
                               ScheduleOperationRepository scheduleOperationRepository,
                               ExecutionRecordRepository executionRecordRepository,
                               AuditService auditService,
                               CodeGenerator codeGenerator,
                               FjspProperties properties,
                               PlanVersionMapper planVersionMapper) {
        this.planVersionRepository = planVersionRepository;
        this.scheduleOperationRepository = scheduleOperationRepository;
        this.executionRecordRepository = executionRecordRepository;
        this.auditService = auditService;
        this.codeGenerator = codeGenerator;
        this.properties = properties;
        this.planVersionMapper = planVersionMapper;
    }

    private PlanVersion find(String idOrCode) {
        return LookupSupport.byIdOrCode(idOrCode, planVersionRepository::findById,
                planVersionRepository::findByVersionCode, "计划版本不存在");
    }

    /**
     * 回滚：复制历史已替代版本的排程快照生成新 DRAFT（parentId 指向当前生效版本，
     * 供发布的基准版本/执行完整性校验使用），不复制实际执行记录、不修改历史版本。
     * 与当前已完成/加工中/冻结窗内工序冲突时抛 E_ROLLBACK_CONFLICT，不生成草稿。
     */
    @Transactional
    public PlanVersionSummaryResponse rollback(String idOrCode, RollbackRequest req) {
        PlanVersion source = find(idOrCode);
        if (req == null || req.remark() == null || req.remark().isBlank()) {
            throw BizException.validation("回滚必须填写回滚原因 remark");
        }
        if (!PlanStateMachine.SUPERSEDED.equals(source.getStatus())) {
            throw BizException.stateConflict(
                    "仅已替代（SUPERSEDED）的历史版本可回滚，当前状态: " + source.getStatus());
        }
        List<ScheduleOperation> sourceOps = scheduleOperationRepository.findByPlanVersionId(source.getId());
        Map<String, ScheduleOperation> sourceByOp = new LinkedHashMap<>();
        for (ScheduleOperation op : sourceOps) {
            sourceByOp.put(op.getOperationId(), op);
        }

        // 当前生效版本（PUBLISHED/EXECUTING）的硬锁定工序：已完成、加工中、冻结窗内
        List<PlanVersion> active = planVersionRepository
                .findByStatusIn(List.of(PlanStateMachine.PUBLISHED, PlanStateMachine.EXECUTING));
        PlanVersion current = active.isEmpty() ? null : active.get(0);
        Map<String, ScheduleOperation> currentByOp = new LinkedHashMap<>();
        for (PlanVersion a : active) {
            for (ScheduleOperation op : scheduleOperationRepository.findByPlanVersionId(a.getId())) {
                currentByOp.putIfAbsent(op.getOperationId(), op);
            }
        }
        List<String> currentOpIds = new ArrayList<>(currentByOp.keySet());
        Map<String, List<ExecutionRecord>> recordsByOp = currentOpIds.isEmpty() ? Map.of()
                : executionRecordRepository.findByOperationIdIn(currentOpIds).stream()
                        .collect(Collectors.groupingBy(ExecutionRecord::getOperationId));
        OffsetDateTime now = OffsetDateTime.now();
        OffsetDateTime freezeEnd = now.plus(properties.getFreezeWindow());
        Map<String, HardLock> locks = new LinkedHashMap<>();
        for (ScheduleOperation cur : currentByOp.values()) {
            List<ExecutionRecord> records = recordsByOp.getOrDefault(cur.getOperationId(), List.of());
            if (records.stream().anyMatch(r -> "COMPLETED".equals(r.getStatus()))) {
                locks.put(cur.getOperationId(), new HardLock("COMPLETED", null));
                continue;
            }
            var running = records.stream()
                    .filter(r -> "RUNNING".equals(r.getStatus()) && r.getActualEndAt() == null)
                    .findFirst();
            if (running.isPresent()) {
                locks.put(cur.getOperationId(), new HardLock("RUNNING", running.get().getActualStartAt()));
            } else if (!cur.getStartAt().isBefore(now) && cur.getStartAt().isBefore(freezeEnd)) {
                locks.put(cur.getOperationId(), new HardLock("FROZEN", null));
            }
        }

        List<String> conflicts = new ArrayList<>();
        for (Map.Entry<String, HardLock> entry : locks.entrySet()) {
            String opId = entry.getKey();
            HardLock lock = entry.getValue();
            ScheduleOperation hist = sourceByOp.get(opId);
            ScheduleOperation cur = currentByOp.get(opId);
            if (hist == null) {
                conflicts.add(opId + "(" + lockText(lock.type()) + "工序在历史快照中缺失)");
                continue;
            }
            switch (lock.type()) {
                case "COMPLETED" -> {
                    if (!cur.getMachineId().equals(hist.getMachineId())
                            || !sameInstant(cur.getStartAt(), hist.getStartAt())
                            || !sameInstant(cur.getEndAt(), hist.getEndAt())) {
                        conflicts.add(opId + "(已完成工序在历史快照中的机台/时间与实际不一致)");
                    }
                }
                case "RUNNING" -> {
                    if (!cur.getMachineId().equals(hist.getMachineId())) {
                        conflicts.add(opId + "(加工中工序在历史快照中的机台与实际不一致)");
                    } else if (lock.actualStartAt() != null
                            && !sameInstant(lock.actualStartAt(), hist.getStartAt())) {
                        conflicts.add(opId + "(加工中工序在历史快照中的开始时间与实际上报不一致)");
                    } else if (lock.actualStartAt() == null
                            && !sameInstant(cur.getStartAt(), hist.getStartAt())) {
                        conflicts.add(opId + "(加工中工序在历史快照中的开始时间与当前计划不一致)");
                    } else if (lock.actualStartAt() != null
                            && hist.getEndAt().isBefore(lock.actualStartAt())) {
                        conflicts.add(opId + "(加工中工序在历史快照中的结束时间早于实际开始时间)");
                    }
                }
                default -> {
                    if (!cur.getMachineId().equals(hist.getMachineId())
                            || !sameInstant(cur.getStartAt(), hist.getStartAt())
                            || !sameInstant(cur.getEndAt(), hist.getEndAt())) {
                        conflicts.add(opId + "(冻结窗内工序在历史快照中的机台/时间与当前计划不一致)");
                    }
                }
            }
        }
        if (!conflicts.isEmpty()) {
            throw BizException.rollbackConflict(
                    "历史快照与当前硬锁定工序冲突，未生成回滚草稿: " + String.join("; ", conflicts));
        }

        PlanVersion draft = new PlanVersion();
        draft.setId(UUID.randomUUID().toString());
        draft.setVersionCode(codeGenerator.next("PV"));
        draft.setParentId(current != null ? current.getId() : null);
        draft.setCandidateGroupId("CG-RB-" + source.getVersionCode());
        draft.setCandidateType("ROLLBACK");
        draft.setStatus(PlanStateMachine.DRAFT);
        draft.setKpi(source.getKpi());

        List<ScheduleOperation> operations = new ArrayList<>();
        for (ScheduleOperation src : sourceOps) {
            ScheduleOperation so = new ScheduleOperation();
            so.setId(UUID.randomUUID().toString());
            so.setPlanVersionId(draft.getId());
            so.setOperationId(src.getOperationId());
            HardLock lock = locks.get(src.getOperationId());
            if (lock != null) {
                // 硬锁定工序以当前实际为准：叠加当前生效版本的安排，实际开工时间作为事实锚点
                ScheduleOperation cur = currentByOp.get(src.getOperationId());
                so.setMachineId(cur.getMachineId());
                so.setSetupStartAt(cur.getSetupStartAt());
                so.setProcessStartAt(cur.getProcessStartAt());
                so.setStartAt(lock.actualStartAt() != null ? lock.actualStartAt() : cur.getStartAt());
                so.setEndAt(cur.getEndAt());
                so.setChangeoverMinutes(cur.getChangeoverMinutes());
                so.setFrozen(true);
                so.setAffected(false);
                so.setReasonCode("FROZEN_WINDOW");
            } else {
                so.setMachineId(src.getMachineId());
                so.setSetupStartAt(src.getSetupStartAt());
                so.setProcessStartAt(src.getProcessStartAt());
                so.setStartAt(src.getStartAt());
                so.setEndAt(src.getEndAt());
                so.setChangeoverMinutes(src.getChangeoverMinutes());
                so.setFrozen(false);
                so.setAffected(false);
                so.setReasonCode(src.getReasonCode());
            }
            operations.add(so);
        }
        planVersionRepository.save(draft);
        scheduleOperationRepository.saveAll(operations);
        auditService.record("PLAN_ROLLBACK", "plan_version", draft.getId(),
                source.getVersionCode() + " -> " + draft.getVersionCode()
                        + ", hardLocked=" + locks.size() + ", remark=" + req.remark());
        log.info("rollback {} -> {} ({} operations, {} hard-locked)",
                source.getVersionCode(), draft.getVersionCode(), operations.size(), locks.size());
        return planVersionMapper.toSummary(draft);
    }

    private record HardLock(String type, OffsetDateTime actualStartAt) {
    }

    private static String lockText(String type) {
        return switch (type) {
            case "COMPLETED" -> "已完成";
            case "RUNNING" -> "加工中";
            default -> "冻结窗内";
        };
    }

    private static boolean sameInstant(OffsetDateTime a, OffsetDateTime b) {
        return a != null && b != null && a.isEqual(b);
    }
}
