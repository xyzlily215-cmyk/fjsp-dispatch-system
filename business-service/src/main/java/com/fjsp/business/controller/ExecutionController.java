package com.fjsp.business.controller;

import java.util.List;

import com.fjsp.business.common.ApiResponse;
import com.fjsp.business.dto.ExecutionFeedbackResponse;
import com.fjsp.business.dto.ExecutionRequest;
import com.fjsp.business.dto.ExecutionTimelineItem;
import com.fjsp.business.service.ExecutionService;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/operations")
public class ExecutionController {

    private final ExecutionService executionService;

    public ExecutionController(ExecutionService executionService) {
        this.executionService = executionService;
    }

    @PreAuthorize("hasAnyRole('PRODUCTION_MANAGER','ADMIN')")
    @PostMapping("/{operationId}/execution")
    public ApiResponse<ExecutionFeedbackResponse> feedback(@PathVariable String operationId,
                                                           @RequestBody ExecutionRequest request) {
        return ApiResponse.ok(executionService.feedback(operationId, request));
    }

    @GetMapping("/{operationId}/execution")
    public ApiResponse<List<ExecutionTimelineItem>> timeline(@PathVariable String operationId) {
        return ApiResponse.ok(executionService.timeline(operationId));
    }
}
