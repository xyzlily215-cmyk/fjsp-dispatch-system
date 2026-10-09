package com.fjsp.business.dto;

public record UserUpdateRequest(
        String role,
        String displayName) {
}
