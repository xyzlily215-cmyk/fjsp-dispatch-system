package com.fjsp.business.dto;

import java.time.OffsetDateTime;

/** 用户管理响应（列表项及新增/编辑/启停/重置密码响应）。 */
public record AdminUserResponse(String id, String username, String role, String displayName,
                                Boolean enabled, OffsetDateTime createdAt) {
}
