package com.fjsp.business.dto;

import java.time.OffsetDateTime;
import java.util.List;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * 导入批次响应（预览与提交共用）：批次基础字段恒在；
 * errors 仅预览/提交复检失败时出现，committedRows 仅整批入库成功时出现（与原 Map 响应的键集合一致）。
 */
public record ImportBatchResponse(String batchCode, String importType, String status, String fileName,
                                  String fileSha256, int totalRows, int successRows, int errorRows,
                                  String operator, OffsetDateTime createdAt, OffsetDateTime committedAt,
                                  @JsonInclude(JsonInclude.Include.NON_NULL) List<ImportRowError> errors,
                                  @JsonInclude(JsonInclude.Include.NON_NULL) Integer committedRows) {
}
