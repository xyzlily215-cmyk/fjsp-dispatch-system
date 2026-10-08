package com.fjsp.business.service;

import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import com.fjsp.business.client.AlgorithmClient;
import com.fjsp.business.common.BizException;
import com.fjsp.business.entity.InputSnapshot;
import com.fjsp.business.entity.PlanVersion;
import com.fjsp.business.entity.ScheduleOperation;
import com.fjsp.business.entity.ScheduleTask;
import com.fjsp.business.entity.TaskStatus;
import com.fjsp.business.metrics.FjspMetrics;
import com.fjsp.business.repository.InputSnapshotRepository;
import com.fjsp.business.repository.PlanVersionRepository;
import com.fjsp.business.repository.ScheduleOperationRepository;
import com.fjsp.business.repository.ScheduleTaskRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class ScheduleResultAssembler {

    private static final Logger log = LoggerFactory.getLogger(ScheduleResultAssembler.class);

    private final ScheduleTaskRepository taskRepository;
    private final InputSnapshotRepository snapshotRepository;
    private final PlanVersionRepository planVersionRepository;
    private final ScheduleOperationRepository scheduleOperationRepository;
    private final AlgorithmClient algorithmClient;
    private final CodeGenerator codeGenerator;
    private final AuditService auditService;
    private final ScheduleIntegrityGuard integrityGuard;
    private final TaskEventService taskEventService;
    private final ValidateRequestFactory validateRequestFactory;
    private final ScheduleTaskStateService stateService;
    private final FjspMetrics metrics;

    // 自注入代理：handleSolveResult 的远程复核在事务外执行，落库部分通过代理开启事务
    // （同类自调用 @Transactional 不生效）
    @org.springframework.beans.factory.annotation.Autowired
    @org.springframework.context.annotation.Lazy
    private ScheduleResultAssembler self;

    public ScheduleResultAssembler(ScheduleTaskRepository taskRepository,
                                   InputSnapshotRepository snapshotRepository,
                                   PlanVersionRepository planVersionRepository,
                                   ScheduleOperationRepository scheduleOperationRepository,
                                   AlgorithmClient algorithmClient,
                                   CodeGenerator codeGenerator,
                                   AuditService auditService,
                                   ScheduleIntegrityGuard integrityGuard,
                                   TaskEventService taskEventService,
                                   ValidateRequestFactory validateRequestFactory,
                                   ScheduleTaskStateService stateService,
                                   FjspMetrics metrics) {
        this.taskRepository = taskRepository;
        this.snapshotRepository = snapshotRepository;
        this.planVersionRepository = planVersionRepository;
        this.scheduleOperationRepository = scheduleOperationRepository;
        this.algorithmClient = algorithmClient;
        this.codeGenerator = codeGenerator;
        this.auditService = auditService;
        this.integrityGuard = integrityGuard;
        this.taskEventService = taskEventService;
        this.validateRequestFactory = validateRequestFactory;
        this.stateService = stateService;
        this.metrics = metrics;
    }

    /**
     * 编排求解结果处理：取消/不可解场景直接落库；可解场景先在事务外做远程约束复核
     * （算法服务超时上限 620s，不能在持有数据库连接的事务内调用），复核通过后在事务内落库。
     */
    public void handleSolveResult(String taskId, JsonNode resp) {
        ScheduleTask task = taskRepository.findById(taskId).orElseThrow();
        if (Boolean.TRUE.equals(task.getCancelRequested())
                || !resp.path("feasibleSolution").asBoolean(false)) {
            self.persistSolveResult(taskId, resp, null);
            return;
        }
        Map<String, Object> validateRequest = buildValidateRequest(taskId, resp);
        stateService.updateProgress(taskId, 85);
        JsonNode validation = algorithmClient.validate(validateRequest);
        self.persistSolveResult(taskId, resp, validation);
    }

    private Map<String, Object> buildValidateRequest(String taskId, JsonNode resp) {
        InputSnapshot snapshot = snapshotRepository.findByTaskId(taskId).orElseThrow();
        Map<String, Object> validateRequest =
                validateRequestFactory.baseFromSnapshot(snapshot.getSnapshotJson());
        List<Map<String, Object>> plannedOps = new ArrayList<>();
        for (JsonNode op : resp.path("operations")) {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("operationId", op.path("operationId").asText());
            entry.put("machineId", op.path("machineId").asText());
            entry.put("startAt", op.path("startAt").asText());
            entry.put("endAt", op.path("endAt").asText());
            entry.put("changeoverMinutes", op.path("changeoverMinutes").asInt(0));
            plannedOps.add(entry);
        }
        validateRequest.put("operations", plannedOps);
        return validateRequest;
    }

    /**
     * 求解结果落库（事务内）。validation 为 null 表示无需复核（已取消或不可解）。
     * 取消标记在事务内复检：复核耗时期间操作员可能发起取消，此时丢弃结果不建计划版本。
     */
    @Transactional
    public void persistSolveResult(String taskId, JsonNode resp, JsonNode validation) {
        ScheduleTask task = taskRepository.findById(taskId).orElseThrow();
        if (Boolean.TRUE.equals(task.getCancelRequested())) {
            // 协作式取消：算法 HTTP 调用无法中断，求解结果到达后直接丢弃，不建计划版本
            stateService.applyCancelled(task, "cancel requested while RUNNING; solve result discarded");
            return;
        }
        String solverStatus = resp.path("status").asText("SUCCESS");
        boolean feasible = resp.path("feasibleSolution").asBoolean(false);
        task.setFeasibleSolution(feasible);
        task.setAlgorithmVersion(resp.path("meta").path("algorithmVersion").asText(null));
        task.setElapsedMs(resp.path("meta").path("elapsedMs").asLong(0));
        task.setProgress(70);

        if (!feasible) {
            task.setStatus(solverStatus);
            task.setResultStatus(resp.path("resultStatus").asText("INFEASIBLE"));
            task.setConflicts(writeJson(resp.path("constraintCheck").path("conflicts")));
            task.setProgress(100);
            task.setFinishedAt(OffsetDateTime.now());
            taskRepository.save(task);
            metrics.recordTaskResult(task.getStatus());
            auditService.record("TASK_INFEASIBLE", "schedule_task", taskId,
                    "conflicts=" + task.getConflicts());
            taskEventService.publish(taskId);
            return;
        }

        // 事务外复核未通过：同样按不可解落库
        boolean passed = validation != null && validation.path("passed").asBoolean(false);
        if (!passed) {
            task.setStatus(solverStatus);
            task.setResultStatus("INFEASIBLE");
            task.setFeasibleSolution(false);
            task.setConflicts(writeJson(validation != null ? validation.path("conflicts") : null));
            task.setProgress(100);
            task.setFinishedAt(OffsetDateTime.now());
            taskRepository.save(task);
            metrics.recordTaskResult(task.getStatus());
            auditService.record("TASK_VALIDATION_FAILED", "schedule_task", taskId,
                    "conflicts=" + task.getConflicts());
            taskEventService.publish(taskId);
            return;
        }

        PlanVersion planVersion;
        try {
            planVersion = createPlanVersion(task, resp);
        } catch (BizException e) {
            if (!BizException.CODE_INTEGRITY_VIOLATION.equals(e.getCode())) {
                throw e;
            }
            task.setStatus(TaskStatus.FAILED.name());
            task.setResultStatus("INTEGRITY_VIOLATION");
            task.setFeasibleSolution(false);
            task.setConflicts(writeConflicts(e.getMessage()));
            task.setProgress(100);
            task.setFinishedAt(OffsetDateTime.now());
            taskRepository.save(task);
            metrics.recordTaskResult(task.getStatus());
            auditService.record("TASK_INTEGRITY_VIOLATION", "schedule_task", taskId, e.getMessage());
            taskEventService.publish(taskId);
            return;
        }
        task.setPlanVersionId(planVersion.getId());
        task.setCandidateGroupId(planVersion.getCandidateGroupId());
        task.setKpi(parse(resp.path("kpi")));
        task.setStatus(solverStatus);
        task.setResultStatus("FEASIBLE");
        task.setConflicts("[]");
        task.setProgress(100);
        task.setFinishedAt(OffsetDateTime.now());
        taskRepository.save(task);
        metrics.recordTaskResult(task.getStatus());
        auditService.record("TASK_SUCCESS", "schedule_task", taskId,
                "planVersion=" + planVersion.getVersionCode());
        taskEventService.publish(taskId);
    }

    private PlanVersion createPlanVersion(ScheduleTask task, JsonNode resp) {
        PlanVersion pv = new PlanVersion();
        pv.setId(UUID.randomUUID().toString());
        pv.setVersionCode(codeGenerator.next("PV"));
        pv.setParentId(task.getOldPlanVersionId());
        String groupSeed = task.getEventId() != null ? task.getEventId() : task.getTaskCode();
        pv.setCandidateGroupId("CG-" + groupSeed.substring(0, Math.min(8, groupSeed.length())));
        pv.setCandidateType(switch (task.getMode()) {
            case "LOCAL_RESCHEDULE" -> "LOCAL";
            case "FULL_RESCHEDULE" -> "FULL";
            default -> "BASELINE";
        });
        pv.setStatus(PlanStateMachine.DRAFT);
        pv.setTaskId(task.getId());
        pv.setKpi(parse(resp.path("kpi")));

        List<ScheduleOperation> operations = new ArrayList<>();
        for (JsonNode op : resp.path("operations")) {
            ScheduleOperation so = new ScheduleOperation();
            so.setId(UUID.randomUUID().toString());
            so.setPlanVersionId(pv.getId());
            so.setOperationId(op.path("operationId").asText());
            so.setMachineId(op.path("machineId").asText());
            so.setSetupStartAt(OffsetDateTime.parse(op.path("setupStartAt").asText()));
            so.setProcessStartAt(OffsetDateTime.parse(op.path("processStartAt").asText()));
            so.setStartAt(OffsetDateTime.parse(op.path("startAt").asText()));
            so.setEndAt(OffsetDateTime.parse(op.path("endAt").asText()));
            so.setChangeoverMinutes(op.path("changeoverMinutes").asInt(0));
            so.setFrozen(op.path("frozen").asBoolean(false));
            so.setAffected(op.path("affected").asBoolean(false));
            so.setReasonCode(op.hasNonNull("reasonCode") ? op.path("reasonCode").asText() : null);
            operations.add(so);
        }
        integrityGuard.verifyAgainstExecution(pv, operations);
        planVersionRepository.save(pv);
        scheduleOperationRepository.saveAll(operations);
        log.info("plan version {} created from task {} with {} operations",
                pv.getVersionCode(), task.getTaskCode(), resp.path("operations").size());
        return pv;
    }

    private static final com.fasterxml.jackson.databind.ObjectMapper JSON =
            new com.fasterxml.jackson.databind.ObjectMapper();

    @SuppressWarnings("unchecked")
    private static <T> T parse(JsonNode node) {
        if (node == null || node.isMissingNode() || node.isNull()) {
            return null;
        }
        return (T) JSON.convertValue(node, Object.class);
    }

    private static String writeJson(JsonNode node) {
        try {
            return JSON.writeValueAsString(node);
        } catch (Exception e) {
            throw new IllegalStateException("cannot serialize json", e);
        }
    }

    private static String writeConflicts(String detail) {
        try {
            return JSON.writeValueAsString(List.of(Map.of("rule", "INTEGRITY", "detail", detail)));
        } catch (Exception e) {
            throw new IllegalStateException("cannot serialize json", e);
        }
    }
}
