package com.fjsp.business.controller;

import java.util.List;
import java.util.Map;

import com.fjsp.business.common.ApiResponse;
import com.fjsp.business.dto.CreateTaskRequest;
import com.fjsp.business.service.TaskService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/schedule-tasks")
public class ScheduleTaskController {

    private final TaskService taskService;

    public ScheduleTaskController(TaskService taskService) {
        this.taskService = taskService;
    }

    @PostMapping
    public ApiResponse<Map<String, Object>> create(
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
            @RequestBody CreateTaskRequest request) {
        return ApiResponse.ok(taskService.createTask(idempotencyKey, request));
    }

    @GetMapping("/{taskId}")
    public ApiResponse<Map<String, Object>> get(@PathVariable String taskId) {
        return ApiResponse.ok(taskService.getTask(taskId));
    }

    @GetMapping
    public ApiResponse<List<Map<String, Object>>> list() {
        return ApiResponse.ok(taskService.listTasks());
    }
}
