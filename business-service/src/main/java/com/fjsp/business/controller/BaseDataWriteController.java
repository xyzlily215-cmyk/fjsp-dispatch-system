package com.fjsp.business.controller;

import java.util.List;
import java.util.Map;

import com.fjsp.business.common.ApiResponse;
import com.fjsp.business.dto.CalendarIntervalRequest;
import com.fjsp.business.dto.MachineStatusRequest;
import com.fjsp.business.dto.MachineUpsertRequest;
import com.fjsp.business.dto.OrderUpdateRequest;
import com.fjsp.business.dto.OrderUpsertRequest;
import com.fjsp.business.dto.TemplateStatusRequest;
import com.fjsp.business.dto.TemplateUpsertRequest;
import com.fjsp.business.service.BaseDataWriteService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1")
public class BaseDataWriteController {

    private final BaseDataWriteService baseDataWriteService;

    public BaseDataWriteController(BaseDataWriteService baseDataWriteService) {
        this.baseDataWriteService = baseDataWriteService;
    }

    @PostMapping("/machines")
    public ApiResponse<Map<String, Object>> createMachine(
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
            @RequestBody MachineUpsertRequest request) {
        return ApiResponse.ok(baseDataWriteService.createMachine(idempotencyKey, request));
    }

    @PutMapping("/machines/{machineId}")
    public ApiResponse<Map<String, Object>> updateMachine(
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
            @PathVariable String machineId,
            @RequestBody MachineUpsertRequest request) {
        return ApiResponse.ok(baseDataWriteService.updateMachine(idempotencyKey, machineId, request));
    }

    @PostMapping("/machines/{machineId}/status")
    public ApiResponse<Map<String, Object>> changeMachineStatus(
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
            @PathVariable String machineId,
            @RequestBody MachineStatusRequest request) {
        return ApiResponse.ok(baseDataWriteService.changeMachineStatus(idempotencyKey, machineId, request));
    }

    @GetMapping("/calendars/{calendarId}/intervals")
    public ApiResponse<List<Map<String, Object>>> calendarIntervals(@PathVariable String calendarId) {
        return ApiResponse.ok(baseDataWriteService.listCalendarIntervals(calendarId));
    }

    @PostMapping("/calendars/{calendarId}/intervals")
    public ApiResponse<Map<String, Object>> addCalendarInterval(
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
            @PathVariable String calendarId,
            @RequestBody CalendarIntervalRequest request) {
        return ApiResponse.ok(baseDataWriteService.addCalendarInterval(idempotencyKey, calendarId, request));
    }

    @PostMapping("/process-templates")
    public ApiResponse<Map<String, Object>> createTemplate(
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
            @RequestBody TemplateUpsertRequest request) {
        return ApiResponse.ok(baseDataWriteService.createTemplate(idempotencyKey, request));
    }

    @PostMapping("/process-templates/{templateId}/status")
    public ApiResponse<Map<String, Object>> changeTemplateStatus(
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
            @PathVariable String templateId,
            @RequestBody TemplateStatusRequest request) {
        return ApiResponse.ok(baseDataWriteService.changeTemplateStatus(idempotencyKey, templateId, request));
    }

    @PostMapping("/process-templates/{templateId}/copy")
    public ApiResponse<Map<String, Object>> copyTemplate(
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
            @PathVariable String templateId) {
        return ApiResponse.ok(baseDataWriteService.copyTemplate(idempotencyKey, templateId));
    }

    @PostMapping("/orders")
    public ApiResponse<Map<String, Object>> createOrder(
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
            @RequestBody OrderUpsertRequest request) {
        return ApiResponse.ok(baseDataWriteService.createOrder(idempotencyKey, request));
    }

    @PutMapping("/orders/{orderId}")
    public ApiResponse<Map<String, Object>> updateOrder(
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
            @PathVariable String orderId,
            @RequestBody OrderUpdateRequest request) {
        return ApiResponse.ok(baseDataWriteService.updateOrder(idempotencyKey, orderId, request));
    }
}
