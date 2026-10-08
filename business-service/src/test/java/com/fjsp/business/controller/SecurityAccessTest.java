package com.fjsp.business.controller;

import java.util.Map;

import com.fjsp.business.auth.JwtAuthenticationFilter;
import com.fjsp.business.auth.JwtService;
import com.fjsp.business.config.FjspProperties;
import com.fjsp.business.config.SecurityConfig;
import com.fjsp.business.entity.AppUser;
import com.fjsp.business.service.DemoService;
import com.fjsp.business.service.PlanVersionService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** 角色-端点访问矩阵：401（未认证）/403（角色不足）/放行（角色匹配） */
@WebMvcTest(controllers = {PlanVersionController.class, DemoController.class, AuditLogController.class},
        properties = "fjsp.auth.jwt-secret=test-jwt-secret-test-jwt-secret-123456")
@Import({SecurityConfig.class, JwtAuthenticationFilter.class, JwtService.class,
        SecurityAccessTest.TestBeans.class})
class SecurityAccessTest {

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

    @Autowired
    private MockMvc mvc;
    @Autowired
    private JwtService jwtService;
    @MockBean
    private PlanVersionService planVersionService;
    @MockBean
    private DemoService demoService;
    @MockBean
    private com.fjsp.business.service.AuditService auditService;

    private String token(String username, String role) {
        AppUser user = new AppUser();
        user.setUsername(username);
        user.setRole(role);
        return jwtService.generateToken(user);
    }

    @Test
    void unauthenticated_protectedEndpoint_401() throws Exception {
        mvc.perform(get("/api/v1/plan-versions"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value("E_UNAUTHORIZED"));
    }

    @Test
    void unauthenticated_publish_401() throws Exception {
        mvc.perform(post("/api/v1/plan-versions/pv-1/publish")
                        .contentType(MediaType.APPLICATION_JSON).content("{\"version\":1}"))
                .andExpect(status().isUnauthorized());
    }

    @Test
    void invalidToken_401() throws Exception {
        mvc.perform(get("/api/v1/plan-versions").header("Authorization", "Bearer not-a-token"))
                .andExpect(status().isUnauthorized());
    }

    @Test
    void expiredToken_401() throws Exception {
        FjspProperties expired = new FjspProperties();
        expired.getAuth().setJwtSecret("test-jwt-secret-test-jwt-secret-123456");
        expired.getAuth().setTokenTtl(java.time.Duration.ofHours(-1));
        AppUser user = new AppUser();
        user.setUsername("admin");
        user.setRole("ADMIN");
        String expiredToken = new JwtService(expired).generateToken(user);

        mvc.perform(get("/api/v1/plan-versions").header("Authorization", "Bearer " + expiredToken))
                .andExpect(status().isUnauthorized());
    }

    @Test
    void authenticatedAnyRole_getEndpoints_allowed() throws Exception {
        when(planVersionService.list(any(), any()))
                .thenReturn(new com.fjsp.business.common.PageResponse<>(java.util.List.of(), 0, 20, 0, 0));
        mvc.perform(get("/api/v1/plan-versions")
                        .header("Authorization", "Bearer " + token("reviewer", "REVIEWER")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value("OK"));
    }

    @Test
    void dispatcher_auditLogs_403() throws Exception {
        mvc.perform(get("/api/v1/audit-logs")
                        .header("Authorization", "Bearer " + token("dispatcher", "DISPATCHER")))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("E_FORBIDDEN"));
    }

    @Test
    void admin_auditLogs_allowed() throws Exception {
        when(auditService.query(any(), any(), any(), any(), any(), any()))
                .thenReturn(new com.fjsp.business.common.PageResponse<>(java.util.List.of(), 0, 20, 0, 0));
        mvc.perform(get("/api/v1/audit-logs")
                        .header("Authorization", "Bearer " + token("admin", "ADMIN")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value("OK"));
    }

    @Test
    void unauthenticated_auditLogs_401() throws Exception {
        mvc.perform(get("/api/v1/audit-logs"))
                .andExpect(status().isUnauthorized());
    }

    @Test
    void reviewer_publish_403() throws Exception {
        mvc.perform(post("/api/v1/plan-versions/pv-1/publish")
                        .header("Authorization", "Bearer " + token("reviewer", "REVIEWER"))
                        .contentType(MediaType.APPLICATION_JSON).content("{\"version\":1}"))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("E_FORBIDDEN"));
    }

    @Test
    void manager_publish_allowed() throws Exception {
        when(planVersionService.publish(anyString(), any())).thenReturn(Map.of("status", "PUBLISHED"));
        mvc.perform(post("/api/v1/plan-versions/pv-1/publish")
                        .header("Authorization", "Bearer " + token("manager", "PRODUCTION_MANAGER"))
                        .contentType(MediaType.APPLICATION_JSON).content("{\"version\":1}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.status").value("PUBLISHED"));
    }

    @Test
    void dispatcher_review_403() throws Exception {
        mvc.perform(post("/api/v1/plan-versions/pv-1/review")
                        .header("Authorization", "Bearer " + token("dispatcher", "DISPATCHER"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"decision\":\"APPROVE\",\"version\":1}"))
                .andExpect(status().isForbidden());
    }

    @Test
    void reviewer_review_allowed() throws Exception {
        when(planVersionService.review(anyString(), any())).thenReturn(Map.of("status", "REVIEWED"));
        mvc.perform(post("/api/v1/plan-versions/pv-1/review")
                        .header("Authorization", "Bearer " + token("reviewer", "REVIEWER"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"decision\":\"APPROVE\",\"version\":1}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.status").value("REVIEWED"));
    }

    @Test
    void dispatcher_demoReset_403() throws Exception {
        mvc.perform(post("/api/v1/demo/reset")
                        .header("Authorization", "Bearer " + token("dispatcher", "DISPATCHER")))
                .andExpect(status().isForbidden());
    }

    @Test
    void admin_demoReset_allowed() throws Exception {
        when(demoService.reset()).thenReturn(Map.of("reset", true));
        mvc.perform(post("/api/v1/demo/reset")
                        .header("Authorization", "Bearer " + token("admin", "ADMIN")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.reset").value(true));
    }

    @Test
    void admin_inheritsAllPermissions() throws Exception {
        when(planVersionService.publish(anyString(), any())).thenReturn(Map.of("status", "PUBLISHED"));
        mvc.perform(post("/api/v1/plan-versions/pv-1/publish")
                        .header("Authorization", "Bearer " + token("admin", "ADMIN"))
                        .contentType(MediaType.APPLICATION_JSON).content("{\"version\":1}"))
                .andExpect(status().isOk());
    }
}
