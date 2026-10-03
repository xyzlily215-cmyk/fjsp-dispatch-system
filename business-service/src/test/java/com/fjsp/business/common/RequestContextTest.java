package com.fjsp.business.common;

import java.util.List;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.slf4j.MDC;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;

import static org.junit.jupiter.api.Assertions.assertEquals;

class RequestContextTest {

    @AfterEach
    void cleanup() {
        SecurityContextHolder.clearContext();
        MDC.clear();
    }

    @Test
    void operator_authenticated_returnsUsername() {
        var auth = new UsernamePasswordAuthenticationToken(
                "reviewer", null, List.of(new SimpleGrantedAuthority("ROLE_REVIEWER")));
        SecurityContextHolder.getContext().setAuthentication(auth);

        assertEquals("reviewer", RequestContext.operator());
    }

    @Test
    void operator_unauthenticatedHttpRequest_anonymous() {
        MDC.put(RequestContext.MDC_KEY, "req-1");

        assertEquals("anonymous", RequestContext.operator());
    }

    @Test
    void operator_noRequestContext_system() {
        assertEquals("system", RequestContext.operator());
    }
}
