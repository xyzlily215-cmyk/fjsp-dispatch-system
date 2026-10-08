package com.fjsp.business.dto;

/** 导入行级错误明细（预览/提交响应中的 errors 条目）。 */
public record ImportRowError(int row, String code, String field, String value, String suggestion) {
}
