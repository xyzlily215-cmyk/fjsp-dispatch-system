package com.fjsp.business.dto;

public record UserCreateRequest(
        String username,
        String password,
        String role,
        String displayName) {
}
