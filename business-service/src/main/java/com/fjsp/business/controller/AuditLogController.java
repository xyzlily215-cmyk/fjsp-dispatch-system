package com.fjsp.business.controller;

import java.util.Map;

import com.fjsp.business.common.ApiResponse;
import com.fjsp.business.common.PageResponse;
import com.fjsp.business.service.AuditService;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/audit-logs")
public class AuditLogController {

    private final AuditService auditService;

    public AuditLogController(AuditService auditService) {
        this.auditService = auditService;
    }

    @PreAuthorize("hasRole('ADMIN')")
    @GetMapping
    public ApiResponse<PageResponse<Map<String, Object>>> list(
            @RequestParam(required = false) String objectType,
            @RequestParam(required = false) String objectId,
            @RequestParam(required = false) String operator,
            @RequestParam(required = false) String requestId,
            @RequestParam(required = false) String source,
            @RequestParam(required = false) String sessionId,
            @RequestParam(required = false) Integer page,
            @RequestParam(required = false) Integer size) {
        return ApiResponse.ok(auditService.query(objectType, objectId, operator, requestId, source, sessionId, page, size));
    }
}
