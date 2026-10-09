package com.fjsp.business.common;

import org.slf4j.MDC;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;

public final class RequestContext {

    public static final String MDC_KEY = "requestId";
    public static final String OPERATOR_KEY = "operatorId";
    public static final String SOURCE_KEY = "source";
    public static final String SESSION_KEY = "sessionId";

    private RequestContext() {
    }

    public static String requestId() {
        String id = MDC.get(MDC_KEY);
        return id != null ? id : "no-request";
    }

    /**
     * 操作者身份只认认证上下文：已认证请求返回登录用户名；
     * 未认证的 HTTP 请求（如登录接口本身）记 anonymous；无请求上下文（异步线程/启动恢复）记 system。
     * 客户端自报的 X-Operator-Id 头不再可信，不再作为身份来源。
     */
    public static String operator() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth != null && auth.isAuthenticated() && auth.getPrincipal() instanceof String username
                && !username.isBlank()) {
            return username;
        }
        return MDC.get(MDC_KEY) != null ? "anonymous" : "system";
    }

    public static String source() {
        String source = MDC.get(SOURCE_KEY);
        return source != null ? source : "api";
    }

    public static String sessionId() {
        return MDC.get(SESSION_KEY);
    }
}
