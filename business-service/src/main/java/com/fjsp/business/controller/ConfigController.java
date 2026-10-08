package com.fjsp.business.controller;

import java.util.List;

import com.fjsp.business.common.ApiResponse;
import com.fjsp.business.dto.ConfigResponse;
import com.fjsp.business.dto.ConfigUpdateRequest;
import com.fjsp.business.service.ConfigService;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** F-12 基础字典维护：键值型配置（仅 ADMIN），更新递增配置版本并写审计。 */
@RestController
@RequestMapping("/api/v1/admin/configs")
public class ConfigController {

    private final ConfigService configService;

    public ConfigController(ConfigService configService) {
        this.configService = configService;
    }

    @PreAuthorize("hasRole('ADMIN')")
    @GetMapping
    public ApiResponse<List<ConfigResponse>> list() {
        return ApiResponse.ok(configService.list());
    }

    @PreAuthorize("hasRole('ADMIN')")
    @PutMapping("/{key}")
    public ApiResponse<ConfigResponse> update(@PathVariable String key,
                                                   @RequestBody ConfigUpdateRequest request) {
        return ApiResponse.ok(configService.update(key, request != null ? request.configValue() : null));
    }
}
