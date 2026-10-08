package com.fjsp.business.controller;

import java.nio.charset.StandardCharsets;
import java.util.Optional;

import com.fjsp.business.auth.JwtAuthenticationFilter;
import com.fjsp.business.auth.JwtService;
import com.fjsp.business.auth.StreamTicketService;
import com.fjsp.business.config.FjspProperties;
import com.fjsp.business.config.SecurityConfig;
import com.fjsp.business.entity.AppUser;
import com.fjsp.business.repository.AppUserRepository;
import com.fjsp.business.service.PlanExportService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpHeaders;
import org.springframework.test.web.servlet.MockMvc;

import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** 导出端点：未认证 401；登录即可导出（与现有 GET 读接口同级权限）；响应为 text/csv 附件且带 BOM。 */
@WebMvcTest(controllers = PlanExportController.class,
        properties = "fjsp.auth.jwt-secret=test-jwt-secret-test-jwt-secret-123456")
@Import({SecurityConfig.class, JwtAuthenticationFilter.class, JwtService.class,
        PlanExportControllerTest.TestBeans.class})
class PlanExportControllerTest {

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
    private PlanExportService planExportService;
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
    void unauthenticated_export_401() throws Exception {
        mvc.perform(get("/api/v1/plan-versions/P1/export"))
                .andExpect(status().isUnauthorized());
    }

    @Test
    void authenticated_export_csvAttachmentWithBom() throws Exception {
        byte[] csv = ("\uFEFF版本号,PV-001\r\n").getBytes(StandardCharsets.UTF_8);
        when(planExportService.exportPlanCsv("P1"))
                .thenReturn(new PlanExportService.ExportFile("plan-PV-001.csv", csv));

        mvc.perform(get("/api/v1/plan-versions/P1/export")
                        .header("Authorization", "Bearer " + token("reviewer", "REVIEWER")))
                .andExpect(status().isOk())
                .andExpect(content().contentType("text/csv;charset=UTF-8"))
                .andExpect(header().string(HttpHeaders.CONTENT_DISPOSITION,
                        org.hamcrest.Matchers.containsString("filename=\"plan-PV-001.csv\"")))
                .andExpect(content().bytes(csv));
    }

    @Test
    void productionManager_export_allowed() throws Exception {
        when(planExportService.exportPlanCsv("PV-001"))
                .thenReturn(new PlanExportService.ExportFile("plan-PV-001.csv",
                        "\uFEFF".getBytes(StandardCharsets.UTF_8)));

        // 版本号也可作为路径参数（LookupSupport 按 id 或 code 定位）
        mvc.perform(get("/api/v1/plan-versions/PV-001/export")
                        .header("Authorization", "Bearer " + token("manager", "PRODUCTION_MANAGER")))
                .andExpect(status().isOk());
    }
}
