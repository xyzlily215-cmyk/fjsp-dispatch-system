package com.fjsp.business.controller;

import java.util.List;
import java.util.Optional;

import com.fjsp.business.auth.JwtAuthenticationFilter;
import com.fjsp.business.auth.JwtService;
import com.fjsp.business.auth.StreamTicketService;
import com.fjsp.business.common.PageResponse;
import com.fjsp.business.config.FjspProperties;
import com.fjsp.business.dto.AdminUserResponse;
import com.fjsp.business.dto.ConfigResponse;
import com.fjsp.business.config.SecurityConfig;
import com.fjsp.business.entity.AppUser;
import com.fjsp.business.repository.AppUserRepository;
import com.fjsp.business.service.AdminUserService;
import com.fjsp.business.service.ConfigService;
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
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** F-12 管理端点角色矩阵：/api/v1/admin/** 仅 ADMIN，其余角色 403、未认证 401。 */
@WebMvcTest(controllers = {AdminUserController.class, ConfigController.class},
        properties = "fjsp.auth.jwt-secret=test-jwt-secret-test-jwt-secret-123456")
@Import({SecurityConfig.class, JwtAuthenticationFilter.class, JwtService.class,
        AdminSecurityAccessTest.TestBeans.class})
class AdminSecurityAccessTest {

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
    private AdminUserService adminUserService;
    @MockBean
    private ConfigService configService;
    @MockBean
    private AppUserRepository userRepository;
    @MockBean
    private StreamTicketService streamTicketService;

    private String token(String username, String role) {
        // 过滤器实时查库校验启用状态与 tokenVersion：返回与 JWT tv claim（默认 0）一致的启用用户
        AppUser user = new AppUser();
        user.setUsername(username);
        user.setRole(role);
        when(userRepository.findByUsername(username)).thenReturn(Optional.of(user));
        return jwtService.generateToken(user);
    }

    @Test
    void unauthenticated_adminUsers_401() throws Exception {
        mvc.perform(get("/api/v1/admin/users"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value("E_UNAUTHORIZED"));
    }

    @Test
    void dispatcher_adminUsers_403() throws Exception {
        mvc.perform(get("/api/v1/admin/users")
                        .header("Authorization", "Bearer " + token("dispatcher", "DISPATCHER")))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("E_FORBIDDEN"));
    }

    @Test
    void admin_adminUsers_allowed() throws Exception {
        when(adminUserService.list(any(), any()))
                .thenReturn(new PageResponse<>(List.of(), 0, 20, 0, 0));
        mvc.perform(get("/api/v1/admin/users")
                        .header("Authorization", "Bearer " + token("admin", "ADMIN")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value("OK"));
    }

    @Test
    void dispatcher_createUser_403() throws Exception {
        mvc.perform(post("/api/v1/admin/users")
                        .header("Authorization", "Bearer " + token("dispatcher", "DISPATCHER"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"u1\",\"password\":\"Passw0rd1\",\"role\":\"DISPATCHER\"}"))
                .andExpect(status().isForbidden());
    }

    @Test
    void admin_createUser_allowed() throws Exception {
        when(adminUserService.create(any()))
                .thenReturn(new AdminUserResponse(null, "u1", null, null, null, null));
        mvc.perform(post("/api/v1/admin/users")
                        .header("Authorization", "Bearer " + token("admin", "ADMIN"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"u1\",\"password\":\"Passw0rd1\",\"role\":\"DISPATCHER\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.username").value("u1"));
    }

    @Test
    void admin_resetPassword_allowed() throws Exception {
        when(adminUserService.resetPassword(anyString(), any()))
                .thenReturn(new AdminUserResponse(null, "u1", null, null, null, null));
        mvc.perform(post("/api/v1/admin/users/u1/password")
                        .header("Authorization", "Bearer " + token("admin", "ADMIN"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"password\":\"NewPass123\"}"))
                .andExpect(status().isOk());
    }

    @Test
    void dispatcher_configs_403() throws Exception {
        mvc.perform(get("/api/v1/admin/configs")
                        .header("Authorization", "Bearer " + token("dispatcher", "DISPATCHER")))
                .andExpect(status().isForbidden());
    }

    @Test
    void admin_configs_allowed() throws Exception {
        when(configService.list()).thenReturn(List.of());
        mvc.perform(get("/api/v1/admin/configs")
                        .header("Authorization", "Bearer " + token("admin", "ADMIN")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value("OK"));
    }

    @Test
    void reviewer_updateConfig_403() throws Exception {
        mvc.perform(put("/api/v1/admin/configs/EXECUTION_DEVIATION_THRESHOLD_MINUTES")
                        .header("Authorization", "Bearer " + token("reviewer", "REVIEWER"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"configValue\":\"20\"}"))
                .andExpect(status().isForbidden());
    }

    @Test
    void admin_updateConfig_allowed() throws Exception {
        when(configService.update(anyString(), any()))
                .thenReturn(new ConfigResponse("EXECUTION_DEVIATION_THRESHOLD_MINUTES", "20", null, 2,
                        null, null, null));
        mvc.perform(put("/api/v1/admin/configs/EXECUTION_DEVIATION_THRESHOLD_MINUTES")
                        .header("Authorization", "Bearer " + token("admin", "ADMIN"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"configValue\":\"20\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.version").value(2));
    }
}
