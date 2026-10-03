package com.fjsp.business.controller;

import java.util.Map;

import com.fjsp.business.common.ApiResponse;
import com.fjsp.business.dto.BreakdownEventRequest;
import com.fjsp.business.dto.NewOrderEventRequest;
import com.fjsp.business.service.EventService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/events")
public class EventController {

    private final EventService eventService;

    public EventController(EventService eventService) {
        this.eventService = eventService;
    }

    @PostMapping("/new-orders")
    public ApiResponse<Map<String, Object>> newOrder(
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
            @RequestBody NewOrderEventRequest request) {
        return ApiResponse.ok(eventService.createNewOrderEvent(idempotencyKey, request));
    }

    @PostMapping("/breakdowns")
    public ApiResponse<Map<String, Object>> breakdown(
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
            @RequestBody BreakdownEventRequest request) {
        return ApiResponse.ok(eventService.createBreakdownEvent(idempotencyKey, request));
    }

    @GetMapping("/{eventId}")
    public ApiResponse<Map<String, Object>> get(@PathVariable String eventId) {
        return ApiResponse.ok(eventService.getEvent(eventId));
    }
}
