package com.fjsp.business.common;

import java.io.IOException;
import java.util.UUID;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.MDC;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

@Component
public class RequestIdFilter extends OncePerRequestFilter {

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String requestId = request.getHeader("X-Request-Id");
        if (requestId == null || requestId.isBlank()) {
            requestId = "req-" + UUID.randomUUID();
        }
        MDC.put(RequestContext.MDC_KEY, requestId);
        putIfPresent(request, "X-Operator-Id", RequestContext.OPERATOR_KEY);
        putIfPresent(request, "X-Source", RequestContext.SOURCE_KEY);
        putIfPresent(request, "X-AGH-Session-Id", RequestContext.SESSION_KEY);
        response.setHeader("X-Request-Id", requestId);
        long start = System.currentTimeMillis();
        try {
            chain.doFilter(request, response);
        } finally {
            org.slf4j.LoggerFactory.getLogger("http.access").info("{} {} -> {} ({} ms)",
                    request.getMethod(), request.getRequestURI(), response.getStatus(),
                    System.currentTimeMillis() - start);
            MDC.remove(RequestContext.MDC_KEY);
            MDC.remove(RequestContext.OPERATOR_KEY);
            MDC.remove(RequestContext.SOURCE_KEY);
            MDC.remove(RequestContext.SESSION_KEY);
        }
    }

    private static void putIfPresent(HttpServletRequest request, String header, String mdcKey) {
        String value = request.getHeader(header);
        if (value != null && !value.isBlank()) {
            MDC.put(mdcKey, value);
        }
    }
}
