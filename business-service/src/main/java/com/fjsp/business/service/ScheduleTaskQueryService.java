package com.fjsp.business.service;

import com.fjsp.business.common.LookupSupport;
import com.fjsp.business.common.PageResponse;
import com.fjsp.business.common.PageSupport;
import com.fjsp.business.dto.ScheduleTaskDetailResponse;
import com.fjsp.business.dto.ScheduleTaskSummaryResponse;
import com.fjsp.business.entity.ScheduleTask;
import com.fjsp.business.repository.ScheduleTaskRepository;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.stereotype.Service;

@Service
public class ScheduleTaskQueryService {

    private final ScheduleTaskRepository taskRepository;

    public ScheduleTaskQueryService(ScheduleTaskRepository taskRepository) {
        this.taskRepository = taskRepository;
    }

    public ScheduleTaskDetailResponse getTask(String taskId) {
        ScheduleTask task = findTask(taskId);
        return new ScheduleTaskDetailResponse(task.getId(), task.getTaskCode(), task.getMode(),
                task.getStatus(), task.getProgress(), task.getResultStatus(), task.getFeasibleSolution(),
                task.getPlanVersionId(), task.getCandidateGroupId(), task.getRetryCount(),
                task.getMaxRetries(), task.getNextRetryAt(), task.getTimeoutAt(),
                task.getCancelRequested(), task.getCreatedAt(), task.getSnapshotHash(),
                task.getAlgorithmVersion(), task.getRandomSeed(), task.getElapsedMs(), task.getKpi(),
                readJson(task.getConflicts()), task.getErrorMessage(), task.getOldPlanVersionId(),
                task.getEventId(), task.getStartedAt(), task.getFinishedAt());
    }

    public PageResponse<ScheduleTaskSummaryResponse> listTasks(Integer page, Integer size) {
        PageRequest pageable = PageSupport.of(page, size, PageSupport.DEFAULT_MAX_SIZE,
                Sort.by(Sort.Direction.DESC, "createdAt"));
        return PageResponse.of(taskRepository.findAllBy(pageable), this::toSummary);
    }

    private ScheduleTaskSummaryResponse toSummary(ScheduleTask task) {
        return new ScheduleTaskSummaryResponse(task.getId(), task.getTaskCode(), task.getMode(),
                task.getStatus(), task.getProgress(), task.getResultStatus(), task.getFeasibleSolution(),
                task.getPlanVersionId(), task.getCandidateGroupId(), task.getRetryCount(),
                task.getMaxRetries(), task.getNextRetryAt(), task.getTimeoutAt(),
                task.getCancelRequested(), task.getCreatedAt());
    }

    public ScheduleTask findTask(String taskIdOrCode) {
        return LookupSupport.byIdOrCode(taskIdOrCode, taskRepository::findById,
                taskRepository::findByTaskCode, "任务不存在");
    }

    private static final com.fasterxml.jackson.databind.ObjectMapper JSON =
            new com.fasterxml.jackson.databind.ObjectMapper();

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
