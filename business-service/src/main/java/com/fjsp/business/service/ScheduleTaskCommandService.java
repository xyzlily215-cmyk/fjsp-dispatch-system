package com.fjsp.business.service;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fjsp.business.common.BizException;
import com.fjsp.business.common.HashUtil;
import com.fjsp.business.common.LookupSupport;
import com.fjsp.business.config.FjspProperties;
import com.fjsp.business.dto.CreateTaskRequest;
import com.fjsp.business.dto.ScheduleTaskCreateResponse;
import com.fjsp.business.dto.ScheduleTaskDetailResponse;
import com.fjsp.business.entity.Event;
import com.fjsp.business.entity.InputSnapshot;
import com.fjsp.business.entity.PlanVersion;
import com.fjsp.business.entity.ScheduleTask;
import com.fjsp.business.entity.TaskStatus;
import com.fjsp.business.metrics.FjspMetrics;
import com.fjsp.business.repository.EventRepository;
import com.fjsp.business.repository.InputSnapshotRepository;
import com.fjsp.business.repository.PlanVersionRepository;
import com.fjsp.business.repository.ScheduleTaskRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

@Service
public class ScheduleTaskCommandService {

    private static final List<String> MODES = List.of("BASELINE", "LOCAL_RESCHEDULE", "FULL_RESCHEDULE");

    private final ScheduleTaskRepository taskRepository;
    private final InputSnapshotRepository snapshotRepository;
    private final PlanVersionRepository planVersionRepository;
    private final EventRepository eventRepository;
    private final SnapshotBuilder snapshotBuilder;
    private final CodeGenerator codeGenerator;
    private final AuditService auditService;
    private final IdempotencyService idempotencyService;
    private final FjspProperties properties;
    private final SeedService seedService;
    private final TaskRunner taskRunner;
    private final TaskEventService taskEventService;
    private final ScheduleTaskQueryService queryService;
    private final ScheduleTaskStateService stateService;
    private final FjspMetrics metrics;
    private final ObjectMapper objectMapper;

    public ScheduleTaskCommandService(ScheduleTaskRepository taskRepository,
                                      InputSnapshotRepository snapshotRepository,
                                      PlanVersionRepository planVersionRepository,
                                      EventRepository eventRepository,
                                      SnapshotBuilder snapshotBuilder,
                                      CodeGenerator codeGenerator,
                                      AuditService auditService,
                                      IdempotencyService idempotencyService,
                                      FjspProperties properties,
                                      SeedService seedService,
                                      @org.springframework.context.annotation.Lazy TaskRunner taskRunner,
                                      TaskEventService taskEventService,
                                      ScheduleTaskQueryService queryService,
                                      ScheduleTaskStateService stateService,
                                      FjspMetrics metrics,
                                      ObjectMapper objectMapper) {
        this.taskRepository = taskRepository;
        this.snapshotRepository = snapshotRepository;
        this.planVersionRepository = planVersionRepository;
        this.eventRepository = eventRepository;
        this.snapshotBuilder = snapshotBuilder;
        this.codeGenerator = codeGenerator;
        this.auditService = auditService;
        this.idempotencyService = idempotencyService;
        this.properties = properties;
        this.seedService = seedService;
        this.taskRunner = taskRunner;
        this.taskEventService = taskEventService;
        this.queryService = queryService;
        this.stateService = stateService;
        this.metrics = metrics;
        this.objectMapper = objectMapper;
    }

    @Transactional
    public ScheduleTaskCreateResponse createTask(String idempotencyKey, CreateTaskRequest req) {
        Object result = idempotencyService.execute(idempotencyKey, req, () -> doCreateTask(req));
        if (result instanceof ScheduleTaskCreateResponse response) {
            return response;
        }
        // 幂等回放：execute 返回存储 JSON 反序列化的 Map，转换回响应 DTO
        return objectMapper.convertValue(result, ScheduleTaskCreateResponse.class);
    }

    private ScheduleTaskCreateResponse doCreateTask(CreateTaskRequest req) {
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
            if (Event.STATUS_CLOSED.equals(event.getStatus())) {
                throw BizException.stateConflict("事件已关闭，不可再触发重调度: " + event.getEventCode());
            }
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
        task.setTaskCode(codeGenerator.next("TSK"));
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

        String taskId = task.getId();
        dispatchAfterCommit(taskId);
        return new ScheduleTaskCreateResponse(task.getId(), task.getTaskCode(), task.getStatus(),
                snapshotHash);
    }

    private void dispatchAfterCommit(String taskId) {
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCommit() {
                taskRunner.run(taskId);
            }
        });
    }

    // ---- retry / cancel endpoints ----

    @Transactional
    public ScheduleTaskDetailResponse retryTask(String taskIdOrCode) {
        ScheduleTask task = queryService.findTask(taskIdOrCode);
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
        metrics.recordRetry();
        auditService.record("TASK_MANUAL_RETRY", "schedule_task", task.getId(),
                "taskCode=" + task.getTaskCode());
        taskEventService.publish(task.getId());
        dispatchAfterCommit(task.getId());
        return queryService.getTask(task.getId());
    }

    @Transactional
    public ScheduleTaskDetailResponse cancelTask(String taskIdOrCode) {
        ScheduleTask task = queryService.findTask(taskIdOrCode);
        String status = task.getStatus();
        if (TaskStatus.PENDING.name().equals(status) || TaskStatus.RETRY_WAIT.name().equals(status)) {
            stateService.applyCancelled(task, "cancelled by operator while " + status);
        } else if (TaskStatus.RUNNING.name().equals(status)) {
            if (!Boolean.TRUE.equals(task.getCancelRequested())) {
                task.setCancelRequested(true);
                taskRepository.save(task);
                auditService.record("TASK_CANCEL_REQUESTED", "schedule_task", task.getId(),
                        "cooperative cancel; solve result will be discarded");
                taskEventService.publish(task.getId());
            }
        } else {
            throw BizException.stateConflict("终态任务不可取消，当前: " + status);
        }
        return queryService.getTask(task.getId());
    }

    PlanVersion findPlanVersion(String idOrCode) {
        return LookupSupport.byIdOrCode(idOrCode, planVersionRepository::findById,
                planVersionRepository::findByVersionCode, "计划版本不存在");
    }

    Event findEvent(String idOrCode) {
        return LookupSupport.byIdOrCode(idOrCode, eventRepository::findById,
                eventRepository::findByEventCode, "事件不存在");
    }
}
