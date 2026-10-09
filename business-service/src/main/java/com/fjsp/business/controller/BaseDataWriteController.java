package com.fjsp.business.controller;

import java.util.List;

import com.fjsp.business.common.ApiResponse;
import com.fjsp.business.dto.CalendarIntervalCreatedResponse;
import com.fjsp.business.dto.CalendarIntervalDeletedResponse;
import com.fjsp.business.dto.CalendarIntervalRequest;
import com.fjsp.business.dto.CalendarIntervalResponse;
import com.fjsp.business.dto.CalendarVersionResponse;
import com.fjsp.business.dto.MachineResponse;
import com.fjsp.business.dto.MachineStatusRequest;
import com.fjsp.business.dto.MachineUpsertRequest;
import com.fjsp.business.dto.OrderCreateResponse;
import com.fjsp.business.dto.OrderResponse;
import com.fjsp.business.dto.OrderRevisionRequest;
import com.fjsp.business.dto.OrderRevisionResponse;
import com.fjsp.business.dto.OrderRevisionResultResponse;
import com.fjsp.business.dto.OrderUpdateRequest;
import com.fjsp.business.dto.OrderUpsertRequest;
import com.fjsp.business.dto.ProcessTemplateResponse;
import com.fjsp.business.dto.TemplateStatusRequest;
import com.fjsp.business.dto.TemplateUpsertRequest;
import com.fjsp.business.service.CalendarCommandService;
import com.fjsp.business.service.MachineCommandService;
import com.fjsp.business.service.OrderCommandService;
import com.fjsp.business.service.OrderRevisionService;
import com.fjsp.business.service.ProcessTemplateCommandService;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.DeleteMapping;
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

    private final MachineCommandService machineCommandService;
    private final CalendarCommandService calendarCommandService;
    private final ProcessTemplateCommandService processTemplateCommandService;
    private final OrderCommandService orderCommandService;
    private final OrderRevisionService orderRevisionService;

    public BaseDataWriteController(MachineCommandService machineCommandService,
                                   CalendarCommandService calendarCommandService,
                                   ProcessTemplateCommandService processTemplateCommandService,
                                   OrderCommandService orderCommandService,
                                   OrderRevisionService orderRevisionService) {
        this.machineCommandService = machineCommandService;
        this.calendarCommandService = calendarCommandService;
        this.processTemplateCommandService = processTemplateCommandService;
        this.orderCommandService = orderCommandService;
        this.orderRevisionService = orderRevisionService;
    }

    @PreAuthorize("hasRole('ADMIN')")
    @PostMapping("/machines")
    public ApiResponse<MachineResponse> createMachine(
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
            @RequestBody MachineUpsertRequest request) {
        return ApiResponse.ok(machineCommandService.createMachine(idempotencyKey, request));
    }

    @PreAuthorize("hasRole('ADMIN')")
    @PutMapping("/machines/{machineId}")
    public ApiResponse<MachineResponse> updateMachine(
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
            @PathVariable String machineId,
            @RequestBody MachineUpsertRequest request) {
        return ApiResponse.ok(machineCommandService.updateMachine(idempotencyKey, machineId, request));
    }

    @PreAuthorize("hasRole('ADMIN')")
    @PostMapping("/machines/{machineId}/status")
    public ApiResponse<MachineResponse> changeMachineStatus(
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
            @PathVariable String machineId,
            @RequestBody MachineStatusRequest request) {
        return ApiResponse.ok(machineCommandService.changeMachineStatus(idempotencyKey, machineId, request));
    }

    @GetMapping("/calendars/{calendarId}/intervals")
    public ApiResponse<List<CalendarIntervalResponse>> calendarIntervals(@PathVariable String calendarId) {
        return ApiResponse.ok(calendarCommandService.listCalendarIntervals(calendarId));
    }

    /** F-02 日历版本历史：入参可为该日历的任意版本 id，返回全部版本（新→旧，current 标记当前生效）。 */
    @GetMapping("/calendars/{calendarId}/versions")
    public ApiResponse<List<CalendarVersionResponse>> calendarVersions(@PathVariable String calendarId) {
        return ApiResponse.ok(calendarCommandService.listCalendarVersions(calendarId));
    }

    @PreAuthorize("hasRole('ADMIN')")
    @PostMapping("/calendars/{calendarId}/intervals")
    public ApiResponse<CalendarIntervalCreatedResponse> addCalendarInterval(
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
            @PathVariable String calendarId,
            @RequestBody CalendarIntervalRequest request) {
        return ApiResponse.ok(calendarCommandService.addCalendarInterval(idempotencyKey, calendarId, request));
    }

    /** F-02 删除区间同样生成新日历版本（历史版本区间不改写）。 */
    @PreAuthorize("hasRole('ADMIN')")
    @DeleteMapping("/calendars/{calendarId}/intervals/{intervalId}")
    public ApiResponse<CalendarIntervalDeletedResponse> deleteCalendarInterval(
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
            @PathVariable String calendarId,
            @PathVariable String intervalId) {
        return ApiResponse.ok(calendarCommandService.deleteCalendarInterval(idempotencyKey, calendarId, intervalId));
    }

    @PreAuthorize("hasRole('ADMIN')")
    @PostMapping("/process-templates")
    public ApiResponse<ProcessTemplateResponse> createTemplate(
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
            @RequestBody TemplateUpsertRequest request) {
        return ApiResponse.ok(processTemplateCommandService.createTemplate(idempotencyKey, request));
    }

    @PreAuthorize("hasRole('ADMIN')")
    @PostMapping("/process-templates/{templateId}/status")
    public ApiResponse<ProcessTemplateResponse> changeTemplateStatus(
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
            @PathVariable String templateId,
            @RequestBody TemplateStatusRequest request) {
        return ApiResponse.ok(processTemplateCommandService.changeTemplateStatus(idempotencyKey, templateId, request));
    }

    @PreAuthorize("hasRole('ADMIN')")
    @PostMapping("/process-templates/{templateId}/copy")
    public ApiResponse<ProcessTemplateResponse> copyTemplate(
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
            @PathVariable String templateId) {
        return ApiResponse.ok(processTemplateCommandService.copyTemplate(idempotencyKey, templateId));
    }

    @PreAuthorize("hasRole('ADMIN')")
    @PostMapping("/orders")
    public ApiResponse<OrderCreateResponse> createOrder(
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
            @RequestBody OrderUpsertRequest request) {
        return ApiResponse.ok(orderCommandService.createOrder(idempotencyKey, request));
    }

    @PreAuthorize("hasRole('ADMIN')")
    @PutMapping("/orders/{orderId}")
    public ApiResponse<OrderResponse> updateOrder(
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
            @PathVariable String orderId,
            @RequestBody OrderUpdateRequest request) {
        return ApiResponse.ok(orderCommandService.updateOrder(idempotencyKey, orderId, request));
    }

    /** F-04 已排程订单的工艺字段修订：原因必填，记录前后值差异，提示需重新排程。 */
    @PreAuthorize("hasRole('ADMIN')")
    @PostMapping("/orders/{orderId}/revisions")
    public ApiResponse<OrderRevisionResultResponse> reviseOrder(
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
            @PathVariable String orderId,
            @RequestBody OrderRevisionRequest request) {
        return ApiResponse.ok(orderRevisionService.reviseOrder(idempotencyKey, orderId, request));
    }

    @GetMapping("/orders/{orderId}/revisions")
    public ApiResponse<List<OrderRevisionResponse>> orderRevisions(@PathVariable String orderId) {
        return ApiResponse.ok(orderRevisionService.listOrderRevisions(orderId));
    }
}
