package com.fjsp.business.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fjsp.business.common.PageResponse;
import com.fjsp.business.dto.CreateTaskRequest;
import com.fjsp.business.dto.ScheduleTaskCreateResponse;
import com.fjsp.business.dto.ScheduleTaskDetailResponse;
import com.fjsp.business.dto.ScheduleTaskSummaryResponse;
import com.fjsp.business.entity.ScheduleTask;
import org.springframework.stereotype.Service;

/**
 * 任务用例委托门面，public 签名保持不变：
 * 创建/取消/重试 → ScheduleTaskCommandService；详情/列表 → ScheduleTaskQueryService；
 * 状态机流转与恢复/扫描 → ScheduleTaskStateService；求解结果落库 → ScheduleResultAssembler。
 */
@Service
public class TaskService {

    private final ScheduleTaskCommandService commandService;
    private final ScheduleTaskQueryService queryService;
    private final ScheduleTaskStateService stateService;
    private final ScheduleResultAssembler resultAssembler;

    public TaskService(ScheduleTaskCommandService commandService,
                       ScheduleTaskQueryService queryService,
                       ScheduleTaskStateService stateService,
                       ScheduleResultAssembler resultAssembler) {
        this.commandService = commandService;
        this.queryService = queryService;
        this.stateService = stateService;
        this.resultAssembler = resultAssembler;
    }

    public ScheduleTaskCreateResponse createTask(String idempotencyKey, CreateTaskRequest req) {
        return commandService.createTask(idempotencyKey, req);
    }

    public ScheduleTaskDetailResponse retryTask(String taskIdOrCode) {
        return commandService.retryTask(taskIdOrCode);
    }

    public ScheduleTaskDetailResponse cancelTask(String taskIdOrCode) {
        return commandService.cancelTask(taskIdOrCode);
    }

    public ScheduleTaskDetailResponse getTask(String taskId) {
        return queryService.getTask(taskId);
    }

    public PageResponse<ScheduleTaskSummaryResponse> listTasks(Integer page, Integer size) {
        return queryService.listTasks(page, size);
    }

    public ScheduleTask findTask(String taskIdOrCode) {
        return queryService.findTask(taskIdOrCode);
    }

    public boolean markRunning(String taskId) {
        return stateService.markRunning(taskId);
    }

    public void updateProgress(String taskId, int progress) {
        stateService.updateProgress(taskId, progress);
    }

    public void markFailed(String taskId, String errorMessage) {
        stateService.markFailed(taskId, errorMessage);
    }

    public void scheduleRetryOrFail(String taskId, String reason) {
        stateService.scheduleRetryOrFail(taskId, reason);
    }

    public void processTimeouts() {
        stateService.processTimeouts();
    }

    public int redispatchDueRetries() {
        return stateService.redispatchDueRetries();
    }

    public void recoverInterruptedTasks() {
        stateService.recoverInterruptedTasks();
    }

    public int redispatchPendingTasks() {
        return stateService.redispatchPendingTasks();
    }

    public void handleSolveResult(String taskId, JsonNode resp) {
        resultAssembler.handleSolveResult(taskId, resp);
    }

    public void persistSolveResult(String taskId, JsonNode resp, JsonNode validation) {
        resultAssembler.persistSolveResult(taskId, resp, validation);
    }
}
