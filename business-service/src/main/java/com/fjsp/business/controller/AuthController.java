package com.fjsp.business.controller;

import java.util.Map;

import com.fjsp.business.auth.AuthService;
import com.fjsp.business.auth.CaptchaService;
import com.fjsp.business.common.ApiResponse;
import com.fjsp.business.common.BizException;
import com.fjsp.business.dto.LoginRequest;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/auth")
public class AuthController {

    private final AuthService authService;
    private final CaptchaService captchaService;

    public AuthController(AuthService authService, CaptchaService captchaService) {
        this.authService = authService;
        this.captchaService = captchaService;
    }

    @GetMapping("/captcha")
    public ResponseEntity<ApiResponse<CaptchaService.Challenge>> captcha() {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
                .body(ApiResponse.ok(captchaService.issue()));
    }

    @PostMapping("/login")
    public ApiResponse<Map<String, Object>> login(@RequestBody LoginRequest request) {
        if (request == null) {
            throw BizException.validation("请求体必填");
        }
        captchaService.verify(request.captchaId(), request.captchaCode());
        return ApiResponse.ok(authService.login(request.username(), request.password()));
    }

    @GetMapping("/me")
    public ApiResponse<Map<String, Object>> me(@AuthenticationPrincipal String username) {
        return ApiResponse.ok(authService.me(username));
    }
}
