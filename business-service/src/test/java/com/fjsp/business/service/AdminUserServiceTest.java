package com.fjsp.business.service;

import java.util.List;
import java.util.Optional;

import com.fjsp.business.common.BizException;
import com.fjsp.business.dto.AdminUserResponse;
import com.fjsp.business.dto.UserCreateRequest;
import com.fjsp.business.dto.UserPasswordRequest;
import com.fjsp.business.dto.UserStatusRequest;
import com.fjsp.business.dto.UserUpdateRequest;
import com.fjsp.business.entity.AppUser;
import com.fjsp.business.repository.AppUserRepository;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class AdminUserServiceTest {

    @Mock
    private AppUserRepository userRepository;
    @Mock
    private AuditService auditService;

    private AdminUserService service() {
        return new AdminUserService(userRepository, new BCryptPasswordEncoder(), auditService);
    }

    private AppUser existingUser(String id, String username, String role, boolean enabled) {
        AppUser user = new AppUser();
        user.setId(id);
        user.setUsername(username);
        user.setRole(role);
        user.setDisplayName(username);
        user.setEnabled(enabled);
        return user;
    }

    @AfterEach
    void clearSecurityContext() {
        SecurityContextHolder.clearContext();
    }

    private void loginAs(String username) {
        SecurityContextHolder.getContext().setAuthentication(
                new UsernamePasswordAuthenticationToken(username, null, List.of()));
    }

    /* ---------------- 新增 ---------------- */

    @Test
    void create_success() {
        when(userRepository.existsByUsername("dispatcher2")).thenReturn(false);

        AdminUserResponse data = service().create(
                new UserCreateRequest("dispatcher2", "Passw0rd1", "DISPATCHER", "调度员乙"));

        assertEquals("dispatcher2", data.username());
        assertEquals("DISPATCHER", data.role());
        assertEquals(Boolean.TRUE, data.enabled());
        ArgumentCaptor<AppUser> captor = ArgumentCaptor.forClass(AppUser.class);
        verify(userRepository).save(captor.capture());
        assertTrue(new BCryptPasswordEncoder().matches("Passw0rd1", captor.getValue().getPasswordHash()));
        verify(auditService).record(any(), any(), any(), any());
    }

    @Test
    void create_duplicateUsername_conflict() {
        when(userRepository.existsByUsername("admin")).thenReturn(true);

        BizException e = assertThrows(BizException.class, () -> service().create(
                new UserCreateRequest("admin", "Passw0rd1", "ADMIN", null)));
        assertEquals("E_DUPLICATE", e.getCode());
    }

    @Test
    void create_invalidRole_validation() {
        BizException e = assertThrows(BizException.class, () -> service().create(
                new UserCreateRequest("newuser", "Passw0rd1", "SUPER_ADMIN", null)));
        assertEquals("E_VALIDATION", e.getCode());
    }

    @Test
    void create_weakPassword_validation() {
        when(userRepository.existsByUsername("newuser")).thenReturn(false);

        assertEquals("E_VALIDATION", assertThrows(BizException.class, () -> service().create(
                new UserCreateRequest("newuser", "short1", "DISPATCHER", null))).getCode());
        assertEquals("E_VALIDATION", assertThrows(BizException.class, () -> service().create(
                new UserCreateRequest("newuser", "onlyletters", "DISPATCHER", null))).getCode());
        assertEquals("E_VALIDATION", assertThrows(BizException.class, () -> service().create(
                new UserCreateRequest("newuser", "12345678", "DISPATCHER", null))).getCode());
    }

    @Test
    void create_invalidUsername_validation() {
        assertEquals("E_VALIDATION", assertThrows(BizException.class, () -> service().create(
                new UserCreateRequest("a b!", "Passw0rd1", "DISPATCHER", null))).getCode());
    }

    /* ---------------- 编辑 / 启停 ---------------- */

    @Test
    void update_success() {
        AppUser user = existingUser("u1", "dispatcher", "DISPATCHER", true);
        when(userRepository.findById("u1")).thenReturn(Optional.of(user));

        AdminUserResponse data = service().update("u1", new UserUpdateRequest("REVIEWER", "审核员丙"));

        assertEquals("REVIEWER", data.role());
        assertEquals("审核员丙", data.displayName());
        assertEquals(1, user.getTokenVersion(), "角色变更应递增 tokenVersion 使旧 token 失效");
        verify(auditService).record(any(), any(), any(), any());
    }

    @Test
    void update_displayNameOnly_keepsTokenVersion() {
        AppUser user = existingUser("u1", "dispatcher", "DISPATCHER", true);
        when(userRepository.findById("u1")).thenReturn(Optional.of(user));

        service().update("u1", new UserUpdateRequest(null, "调度员甲"));

        assertEquals(0, user.getTokenVersion(), "仅改显示名不应踢用户下线");
    }

    @Test
    void update_notFound() {
        when(userRepository.findById("ghost")).thenReturn(Optional.empty());

        BizException e = assertThrows(BizException.class,
                () -> service().update("ghost", new UserUpdateRequest("REVIEWER", null)));
        assertEquals("E_NOT_FOUND", e.getCode());
    }

    @Test
    void changeStatus_disableSelf_validation() {
        AppUser admin = existingUser("u-admin", "admin", "ADMIN", true);
        when(userRepository.findById("u-admin")).thenReturn(Optional.of(admin));
        loginAs("admin");

        BizException e = assertThrows(BizException.class,
                () -> service().changeStatus("u-admin", new UserStatusRequest(false)));
        assertEquals("E_VALIDATION", e.getCode());
        assertTrue(admin.getEnabled());
    }

    @Test
    void changeStatus_disableLastAdmin_stateConflict() {
        AppUser admin = existingUser("u-admin2", "admin2", "ADMIN", true);
        when(userRepository.findById("u-admin2")).thenReturn(Optional.of(admin));
        when(userRepository.findAll()).thenReturn(List.of(admin));
        loginAs("admin");

        BizException e = assertThrows(BizException.class,
                () -> service().changeStatus("u-admin2", new UserStatusRequest(false)));
        assertEquals("E_STATE_CONFLICT", e.getCode());
        assertTrue(admin.getEnabled());
    }

    @Test
    void changeStatus_disableAndEnable_success() {
        AppUser user = existingUser("u1", "dispatcher", "DISPATCHER", true);
        when(userRepository.findById("u1")).thenReturn(Optional.of(user));

        AdminUserResponse disabled = service().changeStatus("u1", new UserStatusRequest(false));
        assertEquals(Boolean.FALSE, disabled.enabled());
        assertFalse(user.getEnabled());
        assertEquals(1, user.getTokenVersion(), "停用应递增 tokenVersion");

        AdminUserResponse enabled = service().changeStatus("u1", new UserStatusRequest(true));
        assertEquals(Boolean.TRUE, enabled.enabled());
        assertEquals(2, user.getTokenVersion(), "启用也递增，停用期间签发的 token 不复活");
    }

    /* ---------------- 重置密码 ---------------- */

    @Test
    void resetPassword_success() {
        AppUser user = existingUser("u1", "dispatcher", "DISPATCHER", true);
        when(userRepository.findById("u1")).thenReturn(Optional.of(user));

        service().resetPassword("u1", new UserPasswordRequest("NewPass123"));

        assertTrue(new BCryptPasswordEncoder().matches("NewPass123", user.getPasswordHash()));
        assertEquals(1, user.getTokenVersion(), "重置密码应递增 tokenVersion 使旧 token 失效");
        verify(auditService).record(any(), any(), any(), any());
    }

    @Test
    void resetPassword_weakPassword_validation() {
        AppUser user = existingUser("u1", "dispatcher", "DISPATCHER", true);
        when(userRepository.findById("u1")).thenReturn(Optional.of(user));

        BizException e = assertThrows(BizException.class,
                () -> service().resetPassword("u1", new UserPasswordRequest("abc")));
        assertEquals("E_VALIDATION", e.getCode());
    }
}
