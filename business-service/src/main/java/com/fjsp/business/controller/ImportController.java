package com.fjsp.business.controller;

import java.io.IOException;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

import com.fjsp.business.common.ApiResponse;
import com.fjsp.business.common.BizException;
import com.fjsp.business.dto.ImportBatchResponse;
import com.fjsp.business.dto.ImportCommitRequest;
import com.fjsp.business.service.ImportService;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

/** F-05 批量导入与校验（订单/设备，CSV）。仅 ADMIN：与基础数据写接口同级权限。 */
@RestController
@RequestMapping("/api/v1/import")
public class ImportController {

    private static final MediaType TEXT_CSV_UTF8 = new MediaType("text", "csv", StandardCharsets.UTF_8);

    private final ImportService importService;

    public ImportController(ImportService importService) {
        this.importService = importService;
    }

    @PreAuthorize("hasRole('ADMIN')")
    @GetMapping("/templates/{type}")
    public ResponseEntity<byte[]> template(@PathVariable String type) {
        ImportService.TemplateFile file = importService.template(type);
        String encoded = URLEncoder.encode(file.filename(), StandardCharsets.UTF_8);
        return ResponseEntity.ok()
                .contentType(TEXT_CSV_UTF8)
                .header(HttpHeaders.CONTENT_DISPOSITION,
                        "attachment; filename=\"" + file.filename() + "\"; filename*=UTF-8''" + encoded)
                .body(file.content());
    }

    @PreAuthorize("hasRole('ADMIN')")
    @PostMapping("/{type}/preview")
    public ApiResponse<ImportBatchResponse> preview(@PathVariable String type,
                                                    @RequestParam("file") MultipartFile file) {
        try {
            return ApiResponse.ok(importService.preview(type, file.getOriginalFilename(), file.getBytes()));
        } catch (IOException e) {
            throw BizException.validation("读取上传文件失败: " + e.getMessage());
        }
    }

    @PreAuthorize("hasRole('ADMIN')")
    @PostMapping("/{type}/commit")
    public ApiResponse<ImportBatchResponse> commit(
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
            @PathVariable String type,
            @RequestBody ImportCommitRequest request) {
        return ApiResponse.ok(importService.commit(type, idempotencyKey, request));
    }
}
