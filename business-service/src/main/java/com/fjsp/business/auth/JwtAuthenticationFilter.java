package com.fjsp.business.auth;

import java.io.IOException;
import java.util.List;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import com.fjsp.business.common.RequestContext;
import com.fjsp.business.entity.AppUser;
import com.fjsp.business.repository.AppUserRepository;
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
 * 解析 Authorization: Bearer <token>（SSE /events 路径为一次性 ?ticket=），
 * 校验通过则装载 SecurityContext（principal=username，authority=ROLE_<role>）。
 * 无头或非法头直接放行，由授权层（authenticated/PreAuthorize）拒绝。
 *
 * 实时失效：JWT 解析后按 username 查 app_user——用户被删除、被停用、或 tv
 * （tokenVersion）与库中不一致（停用/改角色/重置密码时递增）都视为未认证；
 * 通过时使用数据库中的当前角色，角色修改即时生效。
 */
@Component
public class JwtAuthenticationFilter extends OncePerRequestFilter {

    private final JwtService jwtService;
    private final AppUserRepository userRepository;
    private final StreamTicketService streamTicketService;

    public JwtAuthenticationFilter(JwtService jwtService,
                                   AppUserRepository userRepository,
                                   StreamTicketService streamTicketService) {
        this.jwtService = jwtService;
        this.userRepository = userRepository;
        this.streamTicketService = streamTicketService;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String username = resolveAuthenticatedUsername(request);
        if (username != null) {
            AppUser user = userRepository.findByUsername(username).orElse(null);
            if (user != null && Boolean.TRUE.equals(user.getEnabled())) {
                var authentication = new UsernamePasswordAuthenticationToken(
                        username, null,
                        List.of(new SimpleGrantedAuthority("ROLE_" + user.getRole())));
                SecurityContextHolder.getContext().setAuthentication(authentication);
                MDC.put(RequestContext.OPERATOR_KEY, username);
            } else {
                SecurityContextHolder.clearContext();
            }
        }
        chain.doFilter(request, response);
    }

    /**
     * 返回通过校验的用户名；任何一步失败返回 null。
     * JWT 路径额外比对 tv claim；ticket 路径在签发时已绑定当前用户，这里仍查库校验启用状态。
     */
    /** ticket 一次性消费后，ASYNC dispatch（SSE 完成时）复用请求属性完成二次认证。 */
    private static final String SSE_USER_ATTR = "fjsp.sse.authenticatedUser";

    private String resolveAuthenticatedUsername(HttpServletRequest request) {
        String header = request.getHeader("Authorization");
        if (header != null && header.startsWith("Bearer ")) {
            return authenticateJwt(header.substring(7));
        }
        // EventSource 不支持自定义请求头，SSE 端点（/events 结尾）只接受一次性 ticket，
        // 不再接受 access_token 查询参数携带 JWT
        if (request.getRequestURI().endsWith("/events")) {
            // ticket 已在初始 dispatch 消费：异步重派发时从请求属性取回
            Object prior = request.getAttribute(SSE_USER_ATTR);
            if (prior instanceof String) {
                return (String) prior;
            }
            String taskId = extractTaskId(request.getRequestURI());
            if (taskId == null) {
                return null;
            }
            StreamTicketService.Ticket ticket =
                    streamTicketService.consume(request.getParameter("ticket"), taskId);
            if (ticket == null) {
                return null;
            }
            request.setAttribute(SSE_USER_ATTR, ticket.username());
            return ticket.username();
        }
        return null;
    }

    private String authenticateJwt(String token) {
        try {
            Jws<Claims> jws = jwtService.parse(token);
            Claims claims = jws.getPayload();
            String username = claims.getSubject();
            Number tv = claims.get("tv", Number.class);
            if (username == null || tv == null) {
                return null;
            }
            AppUser user = userRepository.findByUsername(username).orElse(null);
            if (user == null || !user.getTokenVersion().equals(tv.intValue())) {
                return null;
            }
            return username;
        } catch (JwtException | IllegalArgumentException e) {
            // 签名错误/过期/格式非法：视为未认证
            return null;
        }
    }

    /** 从 /api/v1/schedule-tasks/{taskId}/events 提取 taskId。 */
    private static String extractTaskId(String uri) {
        String marker = "/schedule-tasks/";
        int i = uri.indexOf(marker);
        if (i < 0) {
            return null;
        }
        String rest = uri.substring(i + marker.length());
        return rest.endsWith("/events") && rest.length() > "/events".length()
                ? rest.substring(0, rest.length() - "/events".length())
                : null;
    }

    /**
     * 异步分发（SSE 流完成时的 ASYNC dispatch）默认被 OncePerRequestFilter 跳过，
     * 会导致 SecurityContext 为空、授权过滤器对已提交的响应再抛 403；这里重新按请求头装载。
     */
    @Override
    protected boolean shouldNotFilterAsyncDispatch() {
        return false;
    }
}
