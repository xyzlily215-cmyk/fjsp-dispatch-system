package com.fjsp.business.controller;

import java.util.Map;

import com.fjsp.business.common.ApiResponse;
import com.fjsp.business.dto.ExecutionRequest;
import com.fjsp.business.service.ExecutionService;
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

    @PostMapping("/{operationId}/execution")
    public ApiResponse<Map<String, Object>> feedback(@PathVariable String operationId,
                                                     @RequestBody ExecutionRequest request) {
        return ApiResponse.ok(executionService.feedback(operationId, request));
    }
}
