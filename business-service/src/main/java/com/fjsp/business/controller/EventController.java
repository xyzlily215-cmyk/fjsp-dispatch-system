package com.fjsp.business.controller;

import com.fjsp.business.common.ApiResponse;
import com.fjsp.business.common.PageResponse;
import com.fjsp.business.dto.BreakdownEventRequest;
import com.fjsp.business.dto.BreakdownEventResponse;
import com.fjsp.business.dto.EventDetailResponse;
import com.fjsp.business.dto.EventResponse;
import com.fjsp.business.dto.EventRevisionResponse;
import com.fjsp.business.dto.NewOrderEventRequest;
import com.fjsp.business.dto.NewOrderEventResponse;
import com.fjsp.business.dto.ReschedulePreviewResponse;
import com.fjsp.business.dto.ReviseEventRequest;
import com.fjsp.business.service.EventService;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/events")
public class EventController {

    private final EventService eventService;

    public EventController(EventService eventService) {
        this.eventService = eventService;
    }

    @PreAuthorize("hasAnyRole('DISPATCHER','ADMIN')")
    @PostMapping("/new-orders")
    public ApiResponse<NewOrderEventResponse> newOrder(
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
            @RequestBody NewOrderEventRequest request) {
        return ApiResponse.ok(eventService.createNewOrderEvent(idempotencyKey, request));
    }

    @PreAuthorize("hasAnyRole('DISPATCHER','ADMIN')")
    @PostMapping("/breakdowns")
    public ApiResponse<BreakdownEventResponse> breakdown(
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
            @RequestBody BreakdownEventRequest request) {
        return ApiResponse.ok(eventService.createBreakdownEvent(idempotencyKey, request));
    }

    @GetMapping("/{eventId}")
    public ApiResponse<EventDetailResponse> get(@PathVariable String eventId) {
        return ApiResponse.ok(eventService.getEvent(eventId));
    }

    /** 重调度向导的影响范围预览：不指定 planVersionId 时默认取当前发布计划。 */
    @GetMapping("/{eventId}/reschedule-preview")
    public ApiResponse<ReschedulePreviewResponse> reschedulePreview(
            @PathVariable String eventId,
            @RequestParam(required = false) String planVersionId,
            @RequestParam(required = false) Integer freezeWindowMinutes) {
        return ApiResponse.ok(eventService.reschedulePreview(eventId, planVersionId, freezeWindowMinutes));
    }

    /** 关闭事件：存在未终态关联任务时返回 409；关闭后不可再触发重调度。 */
    @PreAuthorize("hasAnyRole('DISPATCHER','ADMIN')")
    @PostMapping("/{eventId}/close")
    public ApiResponse<EventResponse> close(@PathVariable String eventId) {
        return ApiResponse.ok(eventService.closeEvent(eventId));
    }

    /** 修订事件：创建携带 revisionOf 与修订原因的新事件，原事件自动关闭。 */
    @PreAuthorize("hasAnyRole('DISPATCHER','ADMIN')")
    @PostMapping("/{eventId}/revise")
    public ApiResponse<EventRevisionResponse> revise(
            @PathVariable String eventId,
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
            @RequestBody ReviseEventRequest request) {
        return ApiResponse.ok(eventService.reviseEvent(idempotencyKey, eventId, request));
    }

    @GetMapping
    public ApiResponse<PageResponse<EventResponse>> list(
            @RequestParam(required = false) String status,
            @RequestParam(required = false) String eventType,
            @RequestParam(required = false) String from,
            @RequestParam(required = false) String to,
            @RequestParam(required = false) Integer page,
            @RequestParam(required = false) Integer size) {
        return ApiResponse.ok(eventService.listEvents(status, eventType, from, to, page, size));
    }
}
