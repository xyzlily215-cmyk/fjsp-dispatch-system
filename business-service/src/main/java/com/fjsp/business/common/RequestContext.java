package com.fjsp.business.common;

import org.slf4j.MDC;

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

    public static String operator() {
        String operator = MDC.get(OPERATOR_KEY);
        return operator != null ? operator : "anonymous";
    }

    public static String source() {
        String source = MDC.get(SOURCE_KEY);
        return source != null ? source : "api";
    }

    public static String sessionId() {
        return MDC.get(SESSION_KEY);
    }
}
