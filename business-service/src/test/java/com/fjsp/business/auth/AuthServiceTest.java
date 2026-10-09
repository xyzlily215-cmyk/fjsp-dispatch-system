package com.fjsp.business.auth;

import java.util.Map;
import java.util.Optional;

import com.fjsp.business.common.BizException;
import com.fjsp.business.config.FjspProperties;
import com.fjsp.business.entity.AppUser;
import com.fjsp.business.repository.AppUserRepository;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.http.HttpStatus;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class AuthServiceTest {

    @Mock
    private AppUserRepository userRepository;

    private AuthService authService() {
        FjspProperties properties = new FjspProperties();
        properties.getAuth().setJwtSecret("test-jwt-secret-test-jwt-secret-123456");
        return new AuthService(userRepository, new BCryptPasswordEncoder(), new JwtService(properties));
    }

    private AppUser user(boolean enabled) {
        AppUser user = new AppUser();
        user.setUsername("admin");
        user.setPasswordHash(new BCryptPasswordEncoder().encode("Fj@123456"));
        user.setRole("ADMIN");
        user.setDisplayName("管理员");
        user.setEnabled(enabled);
        return user;
    }

    @Test
    void login_success_returnsTokenAndProfile() {
        when(userRepository.findByUsername("admin")).thenReturn(Optional.of(user(true)));

        Map<String, Object> data = authService().login("admin", "Fj@123456");

        assertNotNull(data.get("token"));
        assertEquals("admin", data.get("username"));
        assertEquals("ADMIN", data.get("role"));
        assertEquals("管理员", data.get("displayName"));
        assertNotNull(data.get("expiresAt"));
    }

    @Test
    void login_wrongPassword_unauthorized() {
        when(userRepository.findByUsername("admin")).thenReturn(Optional.of(user(true)));

        BizException e = assertThrows(BizException.class, () -> authService().login("admin", "wrong"));
        assertEquals("E_UNAUTHORIZED", e.getCode());
        assertEquals(HttpStatus.UNAUTHORIZED, e.getStatus());
    }

    @Test
    void login_unknownUser_unauthorized() {
        when(userRepository.findByUsername("ghost")).thenReturn(Optional.empty());

        BizException e = assertThrows(BizException.class, () -> authService().login("ghost", "Fj@123456"));
        assertEquals("E_UNAUTHORIZED", e.getCode());
    }

    @Test
    void login_disabledUser_unauthorized() {
        when(userRepository.findByUsername("admin")).thenReturn(Optional.of(user(false)));

        BizException e = assertThrows(BizException.class, () -> authService().login("admin", "Fj@123456"));
        assertEquals("E_UNAUTHORIZED", e.getCode());
    }

    @Test
    void login_fiveConsecutiveFailures_locksAccount() {
        AuthService service = authService();
        when(userRepository.findByUsername("admin")).thenReturn(Optional.of(user(true)));

        for (int i = 0; i < 5; i++) {
            BizException e = assertThrows(BizException.class, () -> service.login("admin", "wrong"));
            assertEquals("E_UNAUTHORIZED", e.getCode());
        }

        // 锁定期内即使密码正确也直接拒绝（429）
        BizException locked = assertThrows(BizException.class, () -> service.login("admin", "Fj@123456"));
        assertEquals("E_LOGIN_LOCKED", locked.getCode());
        assertEquals(HttpStatus.TOO_MANY_REQUESTS, locked.getStatus());
    }

    @Test
    void login_success_clearsFailureCount() {
        AuthService service = authService();
        when(userRepository.findByUsername("admin")).thenReturn(Optional.of(user(true)));

        // 连续失败 4 次后成功一次，计数清零；再失败 4 次仍未锁定
        for (int i = 0; i < 4; i++) {
            assertThrows(BizException.class, () -> service.login("admin", "wrong"));
        }
        assertNotNull(service.login("admin", "Fj@123456").get("token"));
        for (int i = 0; i < 4; i++) {
            BizException e = assertThrows(BizException.class, () -> service.login("admin", "wrong"));
            assertEquals("E_UNAUTHORIZED", e.getCode());
        }
        assertNotNull(service.login("admin", "Fj@123456").get("token"));
    }

    @Test
    void login_failuresAreScopedPerUsername() {
        AuthService service = authService();
        when(userRepository.findByUsername("admin")).thenReturn(Optional.of(user(true)));
        when(userRepository.findByUsername("ghost")).thenReturn(Optional.empty());

        for (int i = 0; i < 5; i++) {
            assertThrows(BizException.class, () -> service.login("ghost", "wrong"));
        }

        // ghost 已锁定不影响 admin 正常登录
        assertNotNull(service.login("admin", "Fj@123456").get("token"));
    }

    @Test
    void me_returnsProfile() {
        when(userRepository.findByUsername("admin")).thenReturn(Optional.of(user(true)));

        Map<String, Object> data = authService().me("admin");

        assertEquals("admin", data.get("username"));
        assertEquals("ADMIN", data.get("role"));
    }
}
