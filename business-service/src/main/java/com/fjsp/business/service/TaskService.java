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
import com.fjsp.business.common.HashUtil;
import com.fjsp.business.config.FjspProperties;
import com.fjsp.business.dto.CreateTaskRequest;
import com.fjsp.business.entity.Event;
import com.fjsp.business.entity.InputSnapshot;
import com.fjsp.business.entity.PlanVersion;
import com.fjsp.business.entity.ScheduleOperation;
import com.fjsp.business.entity.ScheduleTask;
import com.fjsp.business.repository.EventRepository;
import com.fjsp.business.repository.InputSnapshotRepository;
import com.fjsp.business.repository.PlanVersionRepository;
import com.fjsp.business.repository.ScheduleOperationRepository;
import com.fjsp.business.repository.ScheduleTaskRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

@Service
public class TaskService {

    private static final Logger log = LoggerFactory.getLogger(TaskService.class);
    private static final List<String> MODES = List.of("BASELINE", "LOCAL_RESCHEDULE", "FULL_RESCHEDULE");

    private final ScheduleTaskRepository taskRepository;
    private final InputSnapshotRepository snapshotRepository;
    private final PlanVersionRepository planVersionRepository;
    private final ScheduleOperationRepository scheduleOperationRepository;
    private final EventRepository eventRepository;
    private final SnapshotBuilder snapshotBuilder;
    private final AlgorithmClient algorithmClient;
    private final CodeGenerator codeGenerator;
    private final AuditService auditService;
    private final IdempotencyService idempotencyService;
    private final FjspProperties properties;
    private final SeedService seedService;
    private final TaskRunner taskRunner;
    private final ScheduleIntegrityGuard integrityGuard;

    public TaskService(ScheduleTaskRepository taskRepository,
                       InputSnapshotRepository snapshotRepository,
                       PlanVersionRepository planVersionRepository,
                       ScheduleOperationRepository scheduleOperationRepository,
                       EventRepository eventRepository,
                       SnapshotBuilder snapshotBuilder,
                       AlgorithmClient algorithmClient,
                       CodeGenerator codeGenerator,
                       AuditService auditService,
                       IdempotencyService idempotencyService,
                       FjspProperties properties,
                       SeedService seedService,
                       @org.springframework.context.annotation.Lazy TaskRunner taskRunner,
                       ScheduleIntegrityGuard integrityGuard) {
        this.taskRepository = taskRepository;
        this.snapshotRepository = snapshotRepository;
        this.planVersionRepository = planVersionRepository;
        this.scheduleOperationRepository = scheduleOperationRepository;
        this.eventRepository = eventRepository;
        this.snapshotBuilder = snapshotBuilder;
        this.algorithmClient = algorithmClient;
        this.codeGenerator = codeGenerator;
        this.auditService = auditService;
        this.idempotencyService = idempotencyService;
        this.properties = properties;
        this.seedService = seedService;
        this.taskRunner = taskRunner;
        this.integrityGuard = integrityGuard;
    }

    @Transactional
    public Map<String, Object> createTask(String idempotencyKey, CreateTaskRequest req) {
        var replay = idempotencyService.findReplay(idempotencyKey, req);
        if (replay.isPresent()) {
            @SuppressWarnings("unchecked")
            Map<String, Object> stored = (Map<String, Object>) replay.get();
            return stored;
        }
        if (req == null || req.mode() == null || !MODES.contains(req.mode())) {
            throw BizException.validation("mode 必须是 BASELINE / LOCAL_RESCHEDULE / FULL_RESCHEDULE");
        }
        boolean reschedule = !"BASELINE".equals(req.mode());
        int freezeWindow = req.freezeWindowMinutes() != null
                ? req.freezeWindowMinutes() : properties.getFreezeWindowMinutes();
        if (freezeWindow < 0 || freezeWindow > 1440) {
            throw BizException.validation("freezeWindowMinutes 必须在 0-1440 之间");
        }
        Integer timeLimit = req.algorithm() != null && req.algorithm().get("timeLimitSeconds") != null
                ? ((Number) req.algorithm().get("timeLimitSeconds")).intValue() : null;
        if (timeLimit != null && (timeLimit < 1 || timeLimit > 600)) {
            throw BizException.validation("algorithm.timeLimitSeconds 必须在 1-600 之间");
        }

        PlanVersion oldPlan = null;
        Event event = null;
        if (reschedule) {
            if (req.oldPlanVersionId() == null || req.eventId() == null) {
                throw BizException.validation("重调度任务必须提供 oldPlanVersionId 和 eventId");
            }
            oldPlan = findPlanVersion(req.oldPlanVersionId());
            event = findEvent(req.eventId());
        } else if (req.oldPlanVersionId() != null || req.eventId() != null) {
            throw BizException.validation("BASELINE 任务不应携带 oldPlanVersionId / eventId");
        }

        OffsetDateTime simStart = req.simulationStartAt() != null
                ? OffsetDateTime.parse(req.simulationStartAt())
                : seedService.defaultSimulationStartAt();

        Map<String, Object> snapshot = snapshotBuilder.buildSolveRequest(
                req.mode(), req.orderIds(),
                oldPlan != null ? oldPlan.getId() : null, event,
                simStart, freezeWindow, req.objectiveWeights(), req.algorithm());
        String snapshotHash = HashUtil.sha256OfJson(snapshot);
        String fingerprint = HashUtil.sha256(snapshotHash + "|" + req.mode());
        var duplicate = taskRepository.findByFingerprint(fingerprint);
        if (duplicate.isPresent()) {
            throw BizException.duplicate("相同输入的任务已存在: " + duplicate.get().getTaskCode());
        }

        ScheduleTask task = new ScheduleTask();
        task.setId(UUID.randomUUID().toString());
        task.setTaskCode(codeGenerator.next("TSK", taskRepository.findMaxTaskCode()));
        task.setMode(req.mode());
        task.setStatus("PENDING");
        task.setProgress(0);
        task.setSnapshotHash(snapshotHash);
        task.setFingerprint(fingerprint);
        task.setOldPlanVersionId(oldPlan != null ? oldPlan.getId() : null);
        task.setEventId(event != null ? event.getId() : null);
        Object seed = ((Map<?, ?>) snapshot.get("algorithm")).get("randomSeed");
        task.setRandomSeed(seed instanceof Number ? ((Number) seed).intValue() : null);
        taskRepository.save(task);

        InputSnapshot inputSnapshot = new InputSnapshot();
        inputSnapshot.setId(UUID.randomUUID().toString());
        inputSnapshot.setTaskId(task.getId());
        inputSnapshot.setSnapshotJson(snapshot);
        inputSnapshot.setSnapshotHash(snapshotHash);
        snapshotRepository.save(inputSnapshot);

        if (event != null && "CONFIRMED".equals(event.getStatus())) {
            event.setStatus("USED_FOR_SOLVE");
            eventRepository.save(event);
        }
        auditService.record("TASK_CREATE", "schedule_task", task.getId(),
                "taskCode=" + task.getTaskCode() + ", mode=" + task.getMode());

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("taskId", task.getId());
        data.put("taskCode", task.getTaskCode());
        data.put("status", task.getStatus());
        data.put("snapshotHash", snapshotHash);
        idempotencyService.store(idempotencyKey, req, data);

        String taskId = task.getId();
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCommit() {
                taskRunner.run(taskId);
            }
        });
        return data;
    }

    public Map<String, Object> getTask(String taskId) {
        ScheduleTask task = findTask(taskId);
        Map<String, Object> data = toSummary(task);
        data.put("progress", task.getProgress());
        data.put("snapshotHash", task.getSnapshotHash());
        data.put("algorithmVersion", task.getAlgorithmVersion());
        data.put("randomSeed", task.getRandomSeed());
        data.put("elapsedMs", task.getElapsedMs());
        data.put("kpi", task.getKpi());
        data.put("conflicts", readJson(task.getConflicts()));
        data.put("errorMessage", task.getErrorMessage());
        data.put("oldPlanVersionId", task.getOldPlanVersionId());
        data.put("eventId", task.getEventId());
        data.put("createdAt", task.getCreatedAt());
        data.put("startedAt", task.getStartedAt());
        data.put("finishedAt", task.getFinishedAt());
        return data;
    }

    public List<Map<String, Object>> listTasks() {
        List<Map<String, Object>> result = new ArrayList<>();
        for (ScheduleTask task : taskRepository.findAllByOrderByCreatedAtDesc(PageRequest.of(0, 20))) {
            result.add(toSummary(task));
        }
        return result;
    }

    private Map<String, Object> toSummary(ScheduleTask task) {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("taskId", task.getId());
        map.put("taskCode", task.getTaskCode());
        map.put("mode", task.getMode());
        map.put("status", task.getStatus());
        map.put("progress", task.getProgress());
        map.put("resultStatus", task.getResultStatus());
        map.put("feasibleSolution", task.getFeasibleSolution());
        map.put("planVersionId", task.getPlanVersionId());
        map.put("candidateGroupId", task.getCandidateGroupId());
        map.put("createdAt", task.getCreatedAt());
        return map;
    }

    public ScheduleTask findTask(String taskIdOrCode) {
        return taskRepository.findById(taskIdOrCode)
                .or(() -> taskRepository.findByTaskCode(taskIdOrCode))
                .orElseThrow(() -> BizException.notFound("任务不存在: " + taskIdOrCode));
    }

    PlanVersion findPlanVersion(String idOrCode) {
        return planVersionRepository.findById(idOrCode)
                .or(() -> planVersionRepository.findByVersionCode(idOrCode))
                .orElseThrow(() -> BizException.notFound("计划版本不存在: " + idOrCode));
    }

    Event findEvent(String idOrCode) {
        return eventRepository.findById(idOrCode)
                .or(() -> eventRepository.findByEventCode(idOrCode))
                .orElseThrow(() -> BizException.notFound("事件不存在: " + idOrCode));
    }

    // ---- async runner support (called from TaskRunner thread) ----

    @Transactional
    public void markRunning(String taskId) {
        ScheduleTask task = taskRepository.findById(taskId).orElseThrow();
        task.setStatus("RUNNING");
        task.setProgress(10);
        task.setStartedAt(OffsetDateTime.now());
        taskRepository.save(task);
    }

    @Transactional
    public void updateProgress(String taskId, int progress) {
        taskRepository.findById(taskId).ifPresent(t -> {
            t.setProgress(progress);
            taskRepository.save(t);
        });
    }

    @Transactional
    public void markFailed(String taskId, String errorMessage) {
        ScheduleTask task = taskRepository.findById(taskId).orElseThrow();
        task.setStatus("FAILED");
        task.setResultStatus("FAILED");
        task.setFeasibleSolution(false);
        task.setErrorMessage(errorMessage != null && errorMessage.length() > 1900
                ? errorMessage.substring(0, 1900) : errorMessage);
        task.setProgress(100);
        task.setFinishedAt(OffsetDateTime.now());
        taskRepository.save(task);
        auditService.record("TASK_FAILED", "schedule_task", taskId, errorMessage);
    }

    @Transactional
    public void handleSolveResult(String taskId, JsonNode resp) {
        ScheduleTask task = taskRepository.findById(taskId).orElseThrow();
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
            auditService.record("TASK_INFEASIBLE", "schedule_task", taskId,
                    "conflicts=" + task.getConflicts());
            return;
        }

        // re-validate against the algorithm service before persisting a plan version
        InputSnapshot snapshot = snapshotRepository.findByTaskId(taskId).orElseThrow();
        Map<String, Object> validateRequest = new LinkedHashMap<>();
        Map<String, Object> snap = snapshot.getSnapshotJson();
        validateRequest.put("simulationStartAt", snap.get("simulationStartAt"));
        validateRequest.put("machines", snap.get("machines"));
        validateRequest.put("orders", snap.get("orders"));
        validateRequest.put("changeoverDefault", snap.get("changeoverDefault"));
        validateRequest.put("changeoverMatrix", snap.get("changeoverMatrix"));
        validateRequest.put("mode", snap.get("mode"));
        if (snap.get("oldPlan") != null) {
            validateRequest.put("oldPlan", snap.get("oldPlan"));
        }
        if (snap.get("lockings") != null) {
            validateRequest.put("lockings", snap.get("lockings"));
        }
        if (snap.get("affectedOperationIds") != null) {
            validateRequest.put("affectedOperationIds", snap.get("affectedOperationIds"));
        }
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
        task.setProgress(85);
        taskRepository.save(task);

        JsonNode validation = algorithmClient.validate(validateRequest);
        boolean passed = validation.path("passed").asBoolean(false);
        if (!passed) {
            task.setStatus(solverStatus);
            task.setResultStatus("INFEASIBLE");
            task.setFeasibleSolution(false);
            task.setConflicts(writeJson(validation.path("conflicts")));
            task.setProgress(100);
            task.setFinishedAt(OffsetDateTime.now());
            taskRepository.save(task);
            auditService.record("TASK_VALIDATION_FAILED", "schedule_task", taskId,
                    "conflicts=" + task.getConflicts());
            return;
        }

        PlanVersion planVersion;
        try {
            planVersion = createPlanVersion(task, resp);
        } catch (BizException e) {
            if (!BizException.CODE_INTEGRITY_VIOLATION.equals(e.getCode())) {
                throw e;
            }
            task.setStatus("FAILED");
            task.setResultStatus("INTEGRITY_VIOLATION");
            task.setFeasibleSolution(false);
            task.setConflicts(writeConflicts(e.getMessage()));
            task.setProgress(100);
            task.setFinishedAt(OffsetDateTime.now());
            taskRepository.save(task);
            auditService.record("TASK_INTEGRITY_VIOLATION", "schedule_task", taskId, e.getMessage());
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
        auditService.record("TASK_SUCCESS", "schedule_task", taskId,
                "planVersion=" + planVersion.getVersionCode());
    }

    private PlanVersion createPlanVersion(ScheduleTask task, JsonNode resp) {
        PlanVersion pv = new PlanVersion();
        pv.setId(UUID.randomUUID().toString());
        pv.setVersionCode(codeGenerator.next("PV", planVersionRepository.findMaxVersionCode()));
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

    private static Object readJson(String text) {
        if (text == null) {
            return null;
        }
        try {
            return JSON.readValue(text, Object.class);
        } catch (Exception e) {
            return text;
        }
    }
}
