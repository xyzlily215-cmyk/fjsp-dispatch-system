package com.fjsp.business.controller;

import java.util.Map;

import com.fjsp.business.common.ApiResponse;
import com.fjsp.business.service.DemoService;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/demo")
public class DemoController {

    private final DemoService demoService;

    public DemoController(DemoService demoService) {
        this.demoService = demoService;
    }

    @PreAuthorize("hasRole('ADMIN')")
    @PostMapping("/reset")
    public ApiResponse<Map<String, Object>> reset() {
        return ApiResponse.ok(demoService.reset());
    }
}
