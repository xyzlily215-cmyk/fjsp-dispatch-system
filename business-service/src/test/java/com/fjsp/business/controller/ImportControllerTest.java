package com.fjsp.business.controller;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Optional;

import com.fjsp.business.auth.JwtAuthenticationFilter;
import com.fjsp.business.auth.JwtService;
import com.fjsp.business.auth.StreamTicketService;
import com.fjsp.business.common.BizException;
import com.fjsp.business.config.FjspProperties;
import com.fjsp.business.config.SecurityConfig;
import com.fjsp.business.dto.ImportBatchResponse;
import com.fjsp.business.dto.ImportRowError;
import com.fjsp.business.entity.AppUser;
import com.fjsp.business.repository.AppUserRepository;
import com.fjsp.business.service.ImportService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.web.servlet.MockMvc;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** F-05 导入端点：模板下载（CSV 附件带 BOM）、预览错误行、权限矩阵（401/403/200）。 */
@WebMvcTest(controllers = ImportController.class,
        properties = "fjsp.auth.jwt-secret=test-jwt-secret-test-jwt-secret-123456")
@Import({SecurityConfig.class, JwtAuthenticationFilter.class, JwtService.class,
        ImportControllerTest.TestBeans.class})
class ImportControllerTest {

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
    @MockitoBean
    private ImportService importService;
    @MockitoBean
    private AppUserRepository userRepository;
    @MockitoBean
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
    void unauthenticated_template_401() throws Exception {
        mvc.perform(get("/api/v1/import/templates/orders"))
                .andExpect(status().isUnauthorized());
    }

    @Test
    void dispatcher_template_403() throws Exception {
        mvc.perform(get("/api/v1/import/templates/orders")
                        .header("Authorization", "Bearer " + token("dispatcher", "DISPATCHER")))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("E_FORBIDDEN"));
    }

    @Test
    void admin_template_csvAttachment() throws Exception {
        byte[] csv = ("﻿orderCode,productFamily,quantity,arrivalAt,dueAt,priority,templateId\r\n")
                .getBytes(StandardCharsets.UTF_8);
        when(importService.template("orders"))
                .thenReturn(new ImportService.TemplateFile("import-orders-template.csv", csv));

        mvc.perform(get("/api/v1/import/templates/orders")
                        .header("Authorization", "Bearer " + token("admin", "ADMIN")))
                .andExpect(status().isOk())
                .andExpect(content().contentType("text/csv;charset=UTF-8"))
                .andExpect(header().string(HttpHeaders.CONTENT_DISPOSITION,
                        org.hamcrest.Matchers.containsString("filename=\"import-orders-template.csv\"")))
                .andExpect(content().bytes(csv));
    }

    @Test
    void admin_template_unknownType_400() throws Exception {
        when(importService.template("calendars"))
                .thenThrow(BizException.validation("不支持的导入类型: calendars（仅支持 orders / machines）"));

        mvc.perform(get("/api/v1/import/templates/calendars")
                        .header("Authorization", "Bearer " + token("admin", "ADMIN")))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("E_VALIDATION"));
    }

    @Test
    void admin_preview_returnsBatchAndRowErrors() throws Exception {
        MockMultipartFile file = new MockMultipartFile("file", "orders.csv", "text/csv",
                "orderCode,productFamily,quantity,arrivalAt,dueAt,priority,templateId\r\n".getBytes(StandardCharsets.UTF_8));
        when(importService.preview(eq("orders"), eq("orders.csv"), any(byte[].class)))
                .thenReturn(new ImportBatchResponse("IMP-000001", "orders", "PENDING", "orders.csv",
                        "abc", 1, 0, 1, null, null, null,
                        List.of(new ImportRowError(2, "E_DUPLICATE", "orderCode", "PO-1",
                                "订单编号已存在")), null));

        mvc.perform(multipart("/api/v1/import/orders/preview").file(file)
                        .header("Authorization", "Bearer " + token("admin", "ADMIN")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value("OK"))
                .andExpect(jsonPath("$.data.batchCode").value("IMP-000001"))
                .andExpect(jsonPath("$.data.errorRows").value(1))
                .andExpect(jsonPath("$.data.errors[0].row").value(2))
                .andExpect(jsonPath("$.data.errors[0].code").value("E_DUPLICATE"))
                // 预览响应不带 committedRows 键（与原 Map 响应键集合一致）
                .andExpect(jsonPath("$.data.committedRows").doesNotExist());
    }

    @Test
    void dispatcher_preview_403() throws Exception {
        MockMultipartFile file = new MockMultipartFile("file", "orders.csv", "text/csv",
                "x".getBytes(StandardCharsets.UTF_8));
        mvc.perform(multipart("/api/v1/import/orders/preview").file(file)
                        .header("Authorization", "Bearer " + token("dispatcher", "DISPATCHER")))
                .andExpect(status().isForbidden());
    }

    @Test
    void admin_commit_returnsBatchResult() throws Exception {
        when(importService.commit(eq("orders"), eq("key-1"), any()))
                .thenReturn(new ImportBatchResponse("IMP-000001", "orders", "COMMITTED", null, null,
                        2, 2, 0, null, null, null, null, 2));

        mvc.perform(post("/api/v1/import/orders/commit")
                        .header("Authorization", "Bearer " + token("admin", "ADMIN"))
                        .header("Idempotency-Key", "key-1")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"batchCode\":\"IMP-000001\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.status").value("COMMITTED"))
                .andExpect(jsonPath("$.data.committedRows").value(2))
                // 入库成功响应不带 errors 键（与原 Map 响应键集合一致）
                .andExpect(jsonPath("$.data.errors").doesNotExist());
    }

    @Test
    void admin_commit_batchConflict_409() throws Exception {
        when(importService.commit(eq("orders"), any(), any()))
                .thenThrow(BizException.stateConflict("批次已入库，请勿重复提交: IMP-000001"));

        mvc.perform(post("/api/v1/import/orders/commit")
                        .header("Authorization", "Bearer " + token("admin", "ADMIN"))
                        .header("Idempotency-Key", "key-1")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"batchCode\":\"IMP-000001\"}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("E_STATE_CONFLICT"));
    }
}
