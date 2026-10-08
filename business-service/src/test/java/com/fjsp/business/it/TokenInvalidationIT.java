package com.fjsp.business.it;

import java.util.UUID;

import com.fjsp.business.auth.JwtAuthenticationFilter;
import com.fjsp.business.auth.JwtService;
import com.fjsp.business.auth.StreamTicketService;
import com.fjsp.business.entity.AppUser;
import com.fjsp.business.repository.AppUserRepository;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.crypto.password.PasswordEncoder;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * P1 安全加固真实 DB 版：tokenVersion 实时失效 + SSE 一次性 ticket。
 * 过滤器走真实 JwtService / AppUserRepository / StreamTicketService，
 * 请求用 spring-test 的 MockHttpServletRequest 构造。
 */
class TokenInvalidationIT extends AbstractPostgresIT {

    @Autowired
    private AppUserRepository userRepository;
    @Autowired
    private JwtService jwtService;
    @Autowired
    private StreamTicketService streamTicketService;
    @Autowired
    private PasswordEncoder passwordEncoder;

    private JwtAuthenticationFilter filter;
    private AppUser user;

    @BeforeEach
    void setUp() {
        filter = new JwtAuthenticationFilter(jwtService, userRepository, streamTicketService);
        user = new AppUser();
        user.setId(UUID.randomUUID().toString());
        user.setUsername("it-user");
        user.setPasswordHash(passwordEncoder.encode("Fj@123456"));
        user.setRole("DISPATCHER");
        user.setEnabled(true);
        userRepository.save(user);
    }

    @AfterEach
    void cleanup() {
        SecurityContextHolder.clearContext();
        userRepository.deleteAll();
    }

    private Authentication doFilter(MockHttpServletRequest request) throws Exception {
        SecurityContextHolder.clearContext();
        filter.doFilter(request, new MockHttpServletResponse(), new MockFilterChain());
        return SecurityContextHolder.getContext().getAuthentication();
    }

    private MockHttpServletRequest bearerRequest(String token) {
        MockHttpServletRequest request = new MockHttpServletRequest("GET", "/api/v1/machines");
        request.addHeader("Authorization", "Bearer " + token);
        return request;
    }

    private MockHttpServletRequest sseRequest(String taskId) {
        return new MockHttpServletRequest("GET", "/api/v1/schedule-tasks/" + taskId + "/events");
    }

    @Test
    void validToken_authenticatesWithDatabaseRole() throws Exception {
        String token = jwtService.generateToken(user);

        Authentication auth = doFilter(bearerRequest(token));

        assertNotNull(auth);
        assertEquals("it-user", auth.getPrincipal());
        assertTrue(auth.getAuthorities().stream()
                .anyMatch(a -> a.getAuthority().equals("ROLE_DISPATCHER")));
    }

    @Test
    void disabledUser_tokenRejectedImmediately() throws Exception {
        String token = jwtService.generateToken(user);
        user.setEnabled(false);
        user.setTokenVersion(user.getTokenVersion() + 1);
        userRepository.save(user);

        assertNull(doFilter(bearerRequest(token)), "停用后旧 token 应立即失效");
    }

    @Test
    void passwordReset_tokenVersionBumpRejectsOldToken() throws Exception {
        String token = jwtService.generateToken(user);
        // 重置密码：AdminUserService 会递增 tokenVersion，这里直接模拟其效果
        user.setPasswordHash(passwordEncoder.encode("NewPass123"));
        user.setTokenVersion(user.getTokenVersion() + 1);
        userRepository.save(user);

        assertNull(doFilter(bearerRequest(token)), "重置密码后旧 token 应立即失效");
    }

    @Test
    void roleChangeWithoutBump_newRoleEffectiveOnSameToken() throws Exception {
        String token = jwtService.generateToken(user);
        // 角色以数据库为准：即使 tokenVersion 未变，权限也即时生效
        user.setRole("REVIEWER");
        userRepository.save(user);

        Authentication auth = doFilter(bearerRequest(token));

        assertNotNull(auth);
        assertTrue(auth.getAuthorities().stream()
                .anyMatch(a -> a.getAuthority().equals("ROLE_REVIEWER")));
    }

    @Test
    void deletedUser_tokenRejected() throws Exception {
        String token = jwtService.generateToken(user);
        userRepository.delete(user);

        assertNull(doFilter(bearerRequest(token)), "用户删除后 token 应立即失效");
    }

    @Test
    void otherUserUnaffected_byTokenVersionBump() throws Exception {
        AppUser other = new AppUser();
        other.setId(UUID.randomUUID().toString());
        other.setUsername("it-other");
        other.setPasswordHash(passwordEncoder.encode("Fj@123456"));
        other.setRole("ADMIN");
        other.setEnabled(true);
        userRepository.save(other);
        String otherToken = jwtService.generateToken(other);

        user.setTokenVersion(user.getTokenVersion() + 1);
        userRepository.save(user);

        assertNotNull(doFilter(bearerRequest(otherToken)), "其他用户的 token 不受影响");
    }

    /* ---------------- SSE 一次性 ticket ---------------- */

    @Test
    void ticket_authenticatesOnce() throws Exception {
        String ticket = streamTicketService.issue("it-user", "T-1");

        MockHttpServletRequest req = sseRequest("T-1");
        req.setParameter("ticket", ticket);
        assertNotNull(doFilter(req), "有效 ticket 应建立认证");

        MockHttpServletRequest replay = sseRequest("T-1");
        replay.setParameter("ticket", ticket);
        assertNull(doFilter(replay), "ticket 一次性，重放应失败");
    }

    @Test
    void ticket_boundToTask() throws Exception {
        String ticket = streamTicketService.issue("it-user", "T-1");

        MockHttpServletRequest wrongTask = sseRequest("T-2");
        wrongTask.setParameter("ticket", ticket);
        assertNull(doFilter(wrongTask), "ticket 绑定 taskId，换任务应失败");
    }

    @Test
    void accessTokenQueryParam_noLongerAccepted() throws Exception {
        String token = jwtService.generateToken(user);

        MockHttpServletRequest req = sseRequest("T-1");
        req.setParameter("access_token", token);
        assertNull(doFilter(req), "SSE 端点不再接受 access_token 查询参数");
    }

    @Test
    void ticket_asyncDispatch_reusesRequestAttribute() throws Exception {
        String ticket = streamTicketService.issue("it-user", "T-1");
        MockHttpServletRequest req = sseRequest("T-1");
        req.setParameter("ticket", ticket);
        assertNotNull(doFilter(req));

        // SSE 完成时的 ASYNC dispatch：ticket 已消费，应从请求属性恢复认证
        assertNotNull(doFilter(req), "异步重派发应复用初始认证结果");
    }
}
