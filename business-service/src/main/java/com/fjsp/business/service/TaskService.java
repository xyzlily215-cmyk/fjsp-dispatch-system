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
import com.fjsp.business.common.PageResponse;
import com.fjsp.business.common.PageSupport;
import com.fjsp.business.config.FjspProperties;
import com.fjsp.business.dto.CreateTaskRequest;
import com.fjsp.business.entity.Event;
import com.fjsp.business.entity.InputSnapshot;
import com.fjsp.business.entity.PlanVersion;
import com.fjsp.business.entity.ScheduleOperation;
import com.fjsp.business.entity.ScheduleTask;
import com.fjsp.business.entity.TaskStatus;
import com.fjsp.business.repository.EventRepository;
import com.fjsp.business.repository.InputSnapshotRepository;
import com.fjsp.business.repository.PlanVersionRepository;
import com.fjsp.business.repository.ScheduleOperationRepository;
import com.fjsp.business.repository.ScheduleTaskRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
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
                ? req.freezeWindowMinutes() : (int) properties.getFreezeWindow().toMinutes();
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
        var duplicate = taskRepository.findByFingerprintAndStatusIn(fingerprint, TaskStatus.blockingStatuses());
        if (duplicate.isPresent()) {
            throw BizException.duplicate("相同输入的任务已存在: " + duplicate.get().getTaskCode());
        }

        ScheduleTask task = new ScheduleTask();
        task.setId(UUID.randomUUID().toString());
        task.setTaskCode(codeGenerator.next("TSK", taskRepository.findMaxTaskCode()));
        task.setMode(req.mode());
        task.setStatus(TaskStatus.PENDING.name());
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
        dispatchAfterCommit(taskId);
        return data;
    }

    private void dispatchAfterCommit(String taskId) {
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCommit() {
                taskRunner.run(taskId);
            }
        });
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

    public PageResponse<Map<String, Object>> listTasks(Integer page, Integer size) {
        PageRequest pageable = PageSupport.of(page, size, PageSupport.DEFAULT_MAX_SIZE,
                Sort.by(Sort.Direction.DESC, "createdAt"));
        return PageResponse.of(taskRepository.findAllBy(pageable), this::toSummary);
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
        map.put("retryCount", task.getRetryCount());
        map.put("maxRetries", task.getMaxRetries());
        map.put("nextRetryAt", task.getNextRetryAt());
        map.put("timeoutAt", task.getTimeoutAt());
        map.put("cancelRequested", task.getCancelRequested());
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
        task.setStatus(TaskStatus.RUNNING.name());
        task.setProgress(10);
        task.setStartedAt(OffsetDateTime.now());
        task.setNextRetryAt(null);
        task.setTimeoutAt(OffsetDateTime.now()
                .plus(properties.getAlgorithm().getTimeout())
                .plus(properties.getTask().getTimeoutBuffer()));
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
        applyFailed(task, errorMessage);
    }

    /**
     * 瞬时失败（算法服务不可达 / 超时 / 进程中断）的统一入口：
     * retry_count+1 后未超 max_retries → RETRY_WAIT 等待退避重投；否则 FAILED 终态（死信）。
     */
    @Transactional
    public void scheduleRetryOrFail(String taskId, String reason) {
        ScheduleTask task = taskRepository.findById(taskId).orElseThrow();
        if (TaskStatus.CANCELLED.name().equals(task.getStatus())) {
            return;
        }
        if (Boolean.TRUE.equals(task.getCancelRequested())) {
            applyCancelled(task, "cancel requested, transient failure not retried: " + reason);
            return;
        }
        int retries = task.getRetryCount() + 1;
        task.setRetryCount(retries);
        if (retries <= task.getMaxRetries()) {
            long delaySeconds = TaskRetryPolicy.backoffSeconds(retries);
            task.setStatus(TaskStatus.RETRY_WAIT.name());
            task.setTimeoutAt(null);
            task.setNextRetryAt(OffsetDateTime.now().plusSeconds(delaySeconds));
            task.setErrorMessage(truncate(reason));
            taskRepository.save(task);
            auditService.record("TASK_RETRY_SCHEDULED", "schedule_task", taskId,
                    "retryCount=" + retries + ", maxRetries=" + task.getMaxRetries()
                            + ", nextRetryAt=" + task.getNextRetryAt() + ", reason=" + reason);
        } else {
            applyFailed(task, reason + "（重试 " + task.getMaxRetries() + " 次后仍失败，转死信）");
        }
    }

    private void applyFailed(ScheduleTask task, String errorMessage) {
        task.setStatus(TaskStatus.FAILED.name());
        task.setResultStatus("FAILED");
        task.setFeasibleSolution(false);
        task.setErrorMessage(truncate(errorMessage));
        task.setProgress(100);
        task.setFinishedAt(OffsetDateTime.now());
        task.setTimeoutAt(null);
        task.setNextRetryAt(null);
        releaseFingerprint(task);
        taskRepository.save(task);
        auditService.record("TASK_FAILED", "schedule_task", task.getId(), errorMessage);
    }

    private void applyCancelled(ScheduleTask task, String detail) {
        task.setStatus(TaskStatus.CANCELLED.name());
        task.setCancelRequested(false);
        task.setFinishedAt(OffsetDateTime.now());
        task.setTimeoutAt(null);
        task.setNextRetryAt(null);
        releaseFingerprint(task);
        taskRepository.save(task);
        auditService.record("TASK_CANCELLED", "schedule_task", task.getId(), detail);
    }

    // FAILED/CANCELLED 释放指纹：相同输入可重建任务，且 unique 约束在 dev(update) 下依然成立
    private void releaseFingerprint(ScheduleTask task) {
        task.setFingerprint(null);
    }

    private static String truncate(String message) {
        return message != null && message.length() > 1900 ? message.substring(0, 1900) : message;
    }

    // ---- retry / cancel endpoints ----

    @Transactional
    public Map<String, Object> retryTask(String taskIdOrCode) {
        ScheduleTask task = findTask(taskIdOrCode);
        if (!TaskStatus.FAILED.name().equals(task.getStatus())
                && !TaskStatus.CANCELLED.name().equals(task.getStatus())) {
            throw BizException.stateConflict("仅 FAILED/CANCELLED 状态的任务可人工重试，当前: " + task.getStatus());
        }
        String fingerprint = HashUtil.sha256(task.getSnapshotHash() + "|" + task.getMode());
        var blocking = taskRepository.findByFingerprintAndStatusIn(fingerprint, TaskStatus.blockingStatuses());
        if (blocking.isPresent()) {
            throw BizException.duplicate("相同输入的任务已存在: " + blocking.get().getTaskCode());
        }
        task.setStatus(TaskStatus.PENDING.name());
        task.setProgress(0);
        task.setRetryCount(0);
        task.setCancelRequested(false);
        task.setErrorMessage(null);
        task.setResultStatus(null);
        task.setFeasibleSolution(null);
        task.setConflicts(null);
        task.setStartedAt(null);
        task.setFinishedAt(null);
        task.setNextRetryAt(null);
        task.setTimeoutAt(null);
        task.setFingerprint(fingerprint);
        taskRepository.save(task);
        auditService.record("TASK_MANUAL_RETRY", "schedule_task", task.getId(),
                "taskCode=" + task.getTaskCode());
        dispatchAfterCommit(task.getId());
        return getTask(task.getId());
    }

    @Transactional
    public Map<String, Object> cancelTask(String taskIdOrCode) {
        ScheduleTask task = findTask(taskIdOrCode);
        String status = task.getStatus();
        if (TaskStatus.PENDING.name().equals(status) || TaskStatus.RETRY_WAIT.name().equals(status)) {
            applyCancelled(task, "cancelled by operator while " + status);
        } else if (TaskStatus.RUNNING.name().equals(status)) {
            if (!Boolean.TRUE.equals(task.getCancelRequested())) {
                task.setCancelRequested(true);
                taskRepository.save(task);
                auditService.record("TASK_CANCEL_REQUESTED", "schedule_task", task.getId(),
                        "cooperative cancel; solve result will be discarded");
            }
        } else {
            throw BizException.stateConflict("终态任务不可取消，当前: " + status);
        }
        return getTask(task.getId());
    }

    // ---- scheduled scan & startup recovery ----

    @Transactional
    public void processTimeouts() {
        OffsetDateTime now = OffsetDateTime.now();
        for (ScheduleTask task : taskRepository.findByStatusAndTimeoutAtBefore(
                TaskStatus.RUNNING.name(), now)) {
            scheduleRetryOrFail(task.getId(), "TaskTimeout: 执行超过时限 timeoutAt=" + task.getTimeoutAt());
        }
    }

    public int redispatchDueRetries() {
        OffsetDateTime now = OffsetDateTime.now();
        List<ScheduleTask> due = taskRepository.findByStatusAndNextRetryAtLessThanEqual(
                TaskStatus.RETRY_WAIT.name(), now);
        for (ScheduleTask task : due) {
            log.info("redispatch retry-wait task {}", task.getTaskCode());
            taskRunner.run(task.getId());
        }
        return due.size();
    }

    @Transactional
    public void recoverInterruptedTasks() {
        for (ScheduleTask task : taskRepository.findByStatus(TaskStatus.RUNNING.name())) {
            auditService.record("TASK_RECOVERED", "schedule_task", task.getId(),
                    "process restarted while task was RUNNING; applying retry policy");
            scheduleRetryOrFail(task.getId(), "进程重启时任务仍处于 RUNNING，按中断恢复处理");
        }
    }

    public int redispatchPendingTasks() {
        OffsetDateTime now = OffsetDateTime.now();
        List<ScheduleTask> toDispatch = new ArrayList<>(
                taskRepository.findByStatus(TaskStatus.PENDING.name()));
        toDispatch.addAll(taskRepository.findByStatusAndNextRetryAtLessThanEqual(
                TaskStatus.RETRY_WAIT.name(), now));
        for (ScheduleTask task : toDispatch) {
            log.info("redispatch task {} on startup", task.getTaskCode());
            taskRunner.run(task.getId());
        }
        return toDispatch.size();
    }

    @Transactional
    public void handleSolveResult(String taskId, JsonNode resp) {
        ScheduleTask task = taskRepository.findById(taskId).orElseThrow();
        if (Boolean.TRUE.equals(task.getCancelRequested())) {
            // 协作式取消：算法 HTTP 调用无法中断，求解结果到达后直接丢弃，不建计划版本
            applyCancelled(task, "cancel requested while RUNNING; solve result discarded");
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
            task.setStatus(TaskStatus.FAILED.name());
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
