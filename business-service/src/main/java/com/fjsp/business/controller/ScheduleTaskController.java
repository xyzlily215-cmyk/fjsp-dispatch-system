package com.fjsp.business.controller;

import java.time.OffsetDateTime;
import java.util.LinkedHashMap;
import java.util.Map;

import com.fjsp.business.auth.StreamTicketService;
import com.fjsp.business.common.ApiResponse;
import com.fjsp.business.common.PageResponse;
import com.fjsp.business.common.RequestContext;
import com.fjsp.business.dto.CreateTaskRequest;
import com.fjsp.business.dto.ScheduleTaskCreateResponse;
import com.fjsp.business.dto.ScheduleTaskDetailResponse;
import com.fjsp.business.dto.ScheduleTaskSummaryResponse;
import com.fjsp.business.service.TaskEventService;
import com.fjsp.business.service.TaskService;
import org.springframework.http.MediaType;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

@RestController
@RequestMapping("/api/v1/schedule-tasks")
public class ScheduleTaskController {

    private final TaskService taskService;
    private final TaskEventService taskEventService;
    private final StreamTicketService streamTicketService;

    public ScheduleTaskController(TaskService taskService, TaskEventService taskEventService,
                                  StreamTicketService streamTicketService) {
        this.taskService = taskService;
        this.taskEventService = taskEventService;
        this.streamTicketService = streamTicketService;
    }

    @PreAuthorize("hasAnyRole('DISPATCHER','ADMIN')")
    @PostMapping
    public ApiResponse<ScheduleTaskCreateResponse> create(
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
            @RequestBody CreateTaskRequest request) {
        return ApiResponse.ok(taskService.createTask(idempotencyKey, request));
    }

    @GetMapping("/{taskId}")
    public ApiResponse<ScheduleTaskDetailResponse> get(@PathVariable String taskId) {
        return ApiResponse.ok(taskService.getTask(taskId));
    }

    /** SSE 实时进度：与任务查询同级（任意已认证角色），任务到达终态后服务端关闭流。
     *  鉴权用一次性 ?ticket=（由下方的 ticket 端点签发），不再接受 access_token。 */
    @GetMapping(path = "/{taskId}/events", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter events(@PathVariable String taskId) {
        return taskEventService.subscribe(taskService.findTask(taskId));
    }

    /** SSE 一次性 stream ticket：60s 有效、一次性、绑定 taskId；
     *  EventSource 无法自定义请求头，用 ticket 替代 URL 中的 JWT。 */
    @PostMapping("/{taskId}/events/ticket")
    public ApiResponse<Map<String, Object>> eventsTicket(@PathVariable String taskId) {
        taskService.findTask(taskId);
        String ticket = streamTicketService.issue(RequestContext.operator(), taskId);
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("ticket", ticket);
        data.put("expiresAt", OffsetDateTime.now()
                .plusSeconds(StreamTicketService.TICKET_TTL_SECONDS));
        return ApiResponse.ok(data);
    }

    @PreAuthorize("hasAnyRole('DISPATCHER','ADMIN')")
    @PostMapping("/{taskId}/retry")
    public ApiResponse<ScheduleTaskDetailResponse> retry(@PathVariable String taskId) {
        return ApiResponse.ok(taskService.retryTask(taskId));
    }

    @PreAuthorize("hasAnyRole('DISPATCHER','ADMIN')")
    @PostMapping("/{taskId}/cancel")
    public ApiResponse<ScheduleTaskDetailResponse> cancel(@PathVariable String taskId) {
        return ApiResponse.ok(taskService.cancelTask(taskId));
    }

    @GetMapping
    public ApiResponse<PageResponse<ScheduleTaskSummaryResponse>> list(
            @RequestParam(required = false) Integer page,
            @RequestParam(required = false) Integer size) {
        return ApiResponse.ok(taskService.listTasks(page, size));
    }
}
