package com.fjsp.business.controller;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

import com.fjsp.business.service.PlanExportService;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 计划版本 CSV 导出（F-09 数据导出）。权限与现有 GET 读接口一致：登录用户均可导出
 * （系统当前无更细粒度数据范围），导出行为由 PlanExportService 写审计。
 */
@RestController
@RequestMapping("/api/v1/plan-versions")
public class PlanExportController {

    private static final MediaType TEXT_CSV_UTF8 = new MediaType("text", "csv", StandardCharsets.UTF_8);

    private final PlanExportService planExportService;

    public PlanExportController(PlanExportService planExportService) {
        this.planExportService = planExportService;
    }

    @GetMapping("/{id}/export")
    public ResponseEntity<byte[]> export(@PathVariable String id) {
        PlanExportService.ExportFile file = planExportService.exportPlanCsv(id);
        String encoded = URLEncoder.encode(file.filename(), StandardCharsets.UTF_8);
        return ResponseEntity.ok()
                .contentType(TEXT_CSV_UTF8)
                .header(HttpHeaders.CONTENT_DISPOSITION,
                        "attachment; filename=\"" + file.filename() + "\"; filename*=UTF-8''" + encoded)
                .body(file.content());
    }
}
