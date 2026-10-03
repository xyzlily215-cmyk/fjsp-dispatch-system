package com.fjsp.business.auth;

import java.io.IOException;
import java.util.List;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import com.fjsp.business.common.RequestContext;
import io.jsonwebtoken.Claims;
import io.jsonwebtoken.Jws;
import io.jsonwebtoken.JwtException;
import org.slf4j.MDC;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * 解析 Authorization: Bearer <token>，校验通过则装载 SecurityContext（principal=username，
 * authority=ROLE_<role>）。无头或非法头直接放行，由授权层（authenticated/PreAuthorize）拒绝。
 */
@Component
public class JwtAuthenticationFilter extends OncePerRequestFilter {

    private final JwtService jwtService;

    public JwtAuthenticationFilter(JwtService jwtService) {
        this.jwtService = jwtService;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String header = request.getHeader("Authorization");
        if (header != null && header.startsWith("Bearer ")) {
            try {
                Jws<Claims> jws = jwtService.parse(header.substring(7));
                Claims claims = jws.getPayload();
                String username = claims.getSubject();
                String role = claims.get("role", String.class);
                if (username != null && role != null) {
                    var authentication = new UsernamePasswordAuthenticationToken(
                            username, null, List.of(new SimpleGrantedAuthority("ROLE_" + role)));
                    SecurityContextHolder.getContext().setAuthentication(authentication);
                    MDC.put(RequestContext.OPERATOR_KEY, username);
                }
            } catch (JwtException | IllegalArgumentException e) {
                // 签名错误/过期/格式非法：不装上下文，视为未认证
                SecurityContextHolder.clearContext();
            }
        }
        chain.doFilter(request, response);
    }
}
