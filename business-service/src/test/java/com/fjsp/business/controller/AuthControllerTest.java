package com.fjsp.business.controller;

import java.util.Map;

import com.fjsp.business.auth.AuthService;
import com.fjsp.business.auth.CaptchaService;
import com.fjsp.business.auth.JwtAuthenticationFilter;
import com.fjsp.business.auth.JwtService;
import com.fjsp.business.auth.StreamTicketService;
import com.fjsp.business.config.FjspProperties;
import com.fjsp.business.config.SecurityConfig;
import com.fjsp.business.repository.AppUserRepository;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@WebMvcTest(controllers = AuthController.class,
        properties = "fjsp.auth.jwt-secret=test-jwt-secret-test-jwt-secret-123456")
@Import({SecurityConfig.class, JwtAuthenticationFilter.class, AuthControllerTest.TestBeans.class})
class AuthControllerTest {

    @TestConfiguration
    static class TestBeans {
        @Bean
        FjspProperties fjspProperties() {
            FjspProperties properties = new FjspProperties();
            properties.getAuth().setJwtSecret("test-jwt-secret-test-jwt-secret-123456");
            properties.getAuth().setTokenTtl(java.time.Duration.ofHours(8));
            return properties;
        }
    }

    @Autowired private MockMvc mvc;
    @MockitoBean private AuthService authService;
    @MockitoBean private CaptchaService captchaService;
    @MockitoBean private JwtService jwtService;
    @MockitoBean private AppUserRepository userRepository;
    @MockitoBean private StreamTicketService streamTicketService;

    @Test
    void captchaIsAnonymous_andNeverCached() throws Exception {
        when(captchaService.issue()).thenReturn(new CaptchaService.Challenge(
                "test-id", "data:image/png;base64,test", java.time.Instant.now().plusSeconds(120)));
        mvc.perform(get("/api/v1/auth/captcha"))
                .andExpect(status().isOk())
                .andExpect(header().string("Cache-Control", "no-store"))
                .andExpect(jsonPath("$.data.captchaId").value("test-id"))
                .andExpect(jsonPath("$.data.answer").doesNotExist());
    }

    @Test
    void missingOrInvalidCaptchaRejectsBeforePasswordAuthentication() throws Exception {
        doThrow(new com.fjsp.business.common.BizException("E_CAPTCHA_INVALID", "验证码错误或已过期"))
                .when(captchaService).verify(any(), any());
        mvc.perform(post("/api/v1/auth/login").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"admin\",\"password\":\"password\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("E_CAPTCHA_INVALID"));
        verifyNoInteractions(authService);
    }

    @Test
    void validCaptchaThenPasswordAuthentication() throws Exception {
        when(authService.login("admin", "password")).thenReturn(Map.of("token", "test-token"));
        mvc.perform(post("/api/v1/auth/login").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"admin\",\"password\":\"password\",\"captchaId\":\"test-id\",\"captchaCode\":\"abcd\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.token").value("test-token"));
        var order = inOrder(captchaService, authService);
        order.verify(captchaService).verify("test-id", "abcd");
        order.verify(authService).login("admin", "password");
    }
}
