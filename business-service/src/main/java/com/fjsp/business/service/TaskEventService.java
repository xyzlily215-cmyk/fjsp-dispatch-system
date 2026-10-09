package com.fjsp.business.service;

import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;

import com.fjsp.business.config.FjspProperties;
import com.fjsp.business.dto.TaskHeartbeatEvent;
import com.fjsp.business.dto.TaskProgressEvent;
import com.fjsp.business.entity.ScheduleTask;
import com.fjsp.business.entity.TaskStatus;
import com.fjsp.business.repository.ScheduleTaskRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

/**
 * 任务进度 SSE 推送。订阅时先回放当前状态快照；之后由任务服务（ScheduleTaskStateService /
 * ScheduleTaskCommandService / ScheduleResultAssembler）的状态迁移钩子调用
 * publish 推送 progress 事件，并按 fjsp.task.sse-heartbeat 周期发送 heartbeat（携带最新耗时）。
 * 任务到达终态后推送最终事件并关闭流。算法服务为同步调用，中间进度以 阶段+耗时+心跳 表达。
 */
@Service
public class TaskEventService {

    private static final Logger log = LoggerFactory.getLogger(TaskEventService.class);

    private final ScheduleTaskRepository taskRepository;
    private final FjspProperties properties;
    private final Map<String, CopyOnWriteArrayList<SseEmitter>> emitters = new ConcurrentHashMap<>();

    public TaskEventService(ScheduleTaskRepository taskRepository, FjspProperties properties) {
        this.taskRepository = taskRepository;
        this.properties = properties;
    }

    public SseEmitter subscribe(ScheduleTask task) {
        SseEmitter emitter = new SseEmitter(properties.getTask().getSseTimeout().toMillis());
        emitters.computeIfAbsent(task.getId(), k -> new CopyOnWriteArrayList<>()).add(emitter);
        emitter.onCompletion(() -> remove(task.getId(), emitter));
        emitter.onTimeout(() -> remove(task.getId(), emitter));
        emitter.onError(e -> remove(task.getId(), emitter));
        send(emitter, task.getId(), "progress", progressPayload(task));
        if (TaskStatus.isTerminal(task.getStatus())) {
            // 终态快照推送后即关流；remove 幂等，容器随后触发的 onCompletion 不重复清理
            emitter.complete();
            remove(task.getId(), emitter);
        }
        return emitter;
    }

    /** 状态迁移钩子：向该任务的订阅者推送当前快照，终态推送后关闭全部连接。 */
    public void publish(String taskId) {
        List<SseEmitter> subscribers = emitters.get(taskId);
        if (subscribers == null || subscribers.isEmpty()) {
            return;
        }
        taskRepository.findById(taskId).ifPresent(task -> {
            for (SseEmitter emitter : subscribers) {
                send(emitter, taskId, "progress", progressPayload(task));
            }
            if (TaskStatus.isTerminal(task.getStatus())) {
                completeAll(taskId);
            }
        });
    }

    @Scheduled(fixedDelayString =
            "#{@'fjsp-com.fjsp.business.config.FjspProperties'.task.sseHeartbeat.toMillis()}")
    public void heartbeat() {
        for (String taskId : List.copyOf(emitters.keySet())) {
            List<SseEmitter> subscribers = emitters.get(taskId);
            if (subscribers == null || subscribers.isEmpty()) {
                continue;
            }
            var found = taskRepository.findById(taskId);
            if (found.isEmpty()) {
                completeAll(taskId);
                continue;
            }
            ScheduleTask task = found.get();
            if (TaskStatus.isTerminal(task.getStatus())) {
                // 终态兜底：状态迁移钩子未触达（如恢复扫描改态）时由心跳补发终态事件并关流
                publish(taskId);
                continue;
            }
            TaskHeartbeatEvent data = new TaskHeartbeatEvent(taskId, task.getStatus(),
                    task.getProgress(), elapsedMs(task));
            for (SseEmitter emitter : subscribers) {
                send(emitter, taskId, "heartbeat", data);
            }
        }
    }

    private void send(SseEmitter emitter, String taskId, String event, Object data) {
        try {
            emitter.send(SseEmitter.event().name(event).data(data, MediaType.APPLICATION_JSON));
        } catch (Exception e) {
            log.debug("sse send failed for task {}, dropping subscriber", taskId);
            remove(taskId, emitter);
            emitter.completeWithError(e);
        }
    }

    private void remove(String taskId, SseEmitter emitter) {
        List<SseEmitter> subscribers = emitters.get(taskId);
        if (subscribers != null) {
            subscribers.remove(emitter);
            if (subscribers.isEmpty()) {
                emitters.remove(taskId, subscribers);
            }
        }
    }

    int subscriberCount(String taskId) {
        List<SseEmitter> subscribers = emitters.get(taskId);
        return subscribers != null ? subscribers.size() : 0;
    }

    /** 当前全部任务的活跃 SSE 连接总数（fjsp.sse.connections 指标数据源）。 */
    public int activeEmitterCount() {
        int total = 0;
        for (List<SseEmitter> subscribers : emitters.values()) {
            total += subscribers.size();
        }
        return total;
    }

    private void completeAll(String taskId) {        List<SseEmitter> subscribers = emitters.remove(taskId);
        if (subscribers != null) {
            for (SseEmitter emitter : subscribers) {
                try {
                    emitter.complete();
                } catch (Exception e) {
                    log.debug("sse complete failed for task {}", taskId);
                }
            }
        }
    }

    private TaskProgressEvent progressPayload(ScheduleTask task) {
        return new TaskProgressEvent(task.getId(), task.getTaskCode(), task.getStatus(),
                task.getProgress(), stageOf(task), elapsedMs(task), task.getResultStatus(),
                task.getFeasibleSolution(), task.getCancelRequested(), task.getErrorMessage(),
                TaskStatus.isTerminal(task.getStatus()));
    }

    private static String stageOf(ScheduleTask task) {
        if (TaskStatus.PENDING.name().equals(task.getStatus())) {
            return "QUEUED";
        }
        if (TaskStatus.RUNNING.name().equals(task.getStatus())) {
            return task.getProgress() != null && task.getProgress() >= 85 ? "VALIDATING" : "SOLVING";
        }
        if (TaskStatus.RETRY_WAIT.name().equals(task.getStatus())) {
            return "RETRY_WAIT";
        }
        return "DONE";
    }

    private static long elapsedMs(ScheduleTask task) {
        if (TaskStatus.isTerminal(task.getStatus()) && task.getElapsedMs() != null) {
            return task.getElapsedMs();
        }
        if (task.getStartedAt() == null) {
            return 0L;
        }
        OffsetDateTime end = task.getFinishedAt() != null ? task.getFinishedAt() : OffsetDateTime.now();
        return Duration.between(task.getStartedAt(), end).toMillis();
    }
}
