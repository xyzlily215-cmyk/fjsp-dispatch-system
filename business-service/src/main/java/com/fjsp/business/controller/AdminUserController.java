package com.fjsp.business.controller;

import com.fjsp.business.common.ApiResponse;
import com.fjsp.business.common.PageResponse;
import com.fjsp.business.dto.AdminUserResponse;
import com.fjsp.business.dto.UserCreateRequest;
import com.fjsp.business.dto.UserPasswordRequest;
import com.fjsp.business.dto.UserStatusRequest;
import com.fjsp.business.dto.UserUpdateRequest;
import com.fjsp.business.service.AdminUserService;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** F-12 用户管理（仅 ADMIN）：列表 / 新增 / 编辑 / 启停 / 重置密码。 */
@RestController
@RequestMapping("/api/v1/admin/users")
public class AdminUserController {

    private final AdminUserService adminUserService;

    public AdminUserController(AdminUserService adminUserService) {
        this.adminUserService = adminUserService;
    }

    @PreAuthorize("hasRole('ADMIN')")
    @GetMapping
    public ApiResponse<PageResponse<AdminUserResponse>> list(
            @RequestParam(required = false) Integer page,
            @RequestParam(required = false) Integer size) {
        return ApiResponse.ok(adminUserService.list(page, size));
    }

    @PreAuthorize("hasRole('ADMIN')")
    @PostMapping
    public ApiResponse<AdminUserResponse> create(@RequestBody UserCreateRequest request) {
        return ApiResponse.ok(adminUserService.create(request));
    }

    @PreAuthorize("hasRole('ADMIN')")
    @PutMapping("/{userId}")
    public ApiResponse<AdminUserResponse> update(@PathVariable String userId,
                                                   @RequestBody UserUpdateRequest request) {
        return ApiResponse.ok(adminUserService.update(userId, request));
    }

    @PreAuthorize("hasRole('ADMIN')")
    @PostMapping("/{userId}/status")
    public ApiResponse<AdminUserResponse> changeStatus(@PathVariable String userId,
                                                         @RequestBody UserStatusRequest request) {
        return ApiResponse.ok(adminUserService.changeStatus(userId, request));
    }

    @PreAuthorize("hasRole('ADMIN')")
    @PostMapping("/{userId}/password")
    public ApiResponse<AdminUserResponse> resetPassword(@PathVariable String userId,
                                                          @RequestBody UserPasswordRequest request) {
        return ApiResponse.ok(adminUserService.resetPassword(userId, request));
    }
}
