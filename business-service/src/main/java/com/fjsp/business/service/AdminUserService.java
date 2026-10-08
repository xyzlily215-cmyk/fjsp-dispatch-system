package com.fjsp.business.service;

import java.util.UUID;

import com.fjsp.business.common.BizException;
import com.fjsp.business.common.PageResponse;
import com.fjsp.business.common.PageSupport;
import com.fjsp.business.common.RequestContext;
import com.fjsp.business.dto.AdminUserResponse;
import com.fjsp.business.dto.UserCreateRequest;
import com.fjsp.business.dto.UserPasswordRequest;
import com.fjsp.business.dto.UserStatusRequest;
import com.fjsp.business.dto.UserUpdateRequest;
import com.fjsp.business.entity.AppUser;
import com.fjsp.business.entity.Role;
import com.fjsp.business.repository.AppUserRepository;
import org.springframework.data.domain.Sort;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** F-12 用户管理（仅 ADMIN）：列表 / 新增 / 编辑 / 启停 / 重置密码，全部写审计。 */
@Service
public class AdminUserService {

    private final AppUserRepository userRepository;
    private final PasswordEncoder passwordEncoder;
    private final AuditService auditService;

    public AdminUserService(AppUserRepository userRepository,
                            PasswordEncoder passwordEncoder,
                            AuditService auditService) {
        this.userRepository = userRepository;
        this.passwordEncoder = passwordEncoder;
        this.auditService = auditService;
    }

    public PageResponse<AdminUserResponse> list(Integer page, Integer size) {
        var pageable = PageSupport.of(page, size, PageSupport.DEFAULT_MAX_SIZE,
                Sort.by(Sort.Direction.ASC, "username"));
        return PageResponse.of(userRepository.findAll(pageable), AdminUserService::toResponse);
    }

    @Transactional
    public AdminUserResponse create(UserCreateRequest req) {
        if (req == null || req.username() == null || req.username().isBlank()) {
            throw BizException.validation("用户名不能为空");
        }
        String username = req.username().trim();
        if (!username.matches("[A-Za-z0-9_.-]{2,32}")) {
            throw BizException.validation("用户名须为 2-32 位字母、数字或 _ . -");
        }
        if (userRepository.existsByUsername(username)) {
            throw BizException.duplicate("用户名已存在: " + username);
        }
        AppUser user = new AppUser();
        user.setId(UUID.randomUUID().toString());
        user.setUsername(username);
        user.setPasswordHash(passwordEncoder.encode(validatedPassword(req.password())));
        user.setRole(validatedRole(req.role()));
        user.setDisplayName(req.displayName() != null && !req.displayName().isBlank()
                ? req.displayName().trim() : username);
        user.setEnabled(true);
        userRepository.save(user);
        auditService.record("USER_CREATE", "app_user", user.getId(),
                "username=" + username + ", role=" + user.getRole());
        return toResponse(user);
    }

    @Transactional
    public AdminUserResponse update(String userId, UserUpdateRequest req) {
        AppUser user = findUser(userId);
        if (req == null) {
            throw BizException.validation("请求体不能为空");
        }
        if (req.role() != null && !req.role().isBlank()) {
            String role = validatedRole(req.role());
            assertNotLastAdmin(user, Role.ADMIN.name().equals(role));
            if (!role.equals(user.getRole())) {
                user.setRole(role);
                // 角色变更立即使旧 token 失效（权限以数据库当前角色为准）
                user.setTokenVersion(user.getTokenVersion() + 1);
            }
        }
        if (req.displayName() != null) {
            user.setDisplayName(req.displayName().isBlank() ? user.getUsername() : req.displayName().trim());
        }
        userRepository.save(user);
        auditService.record("USER_UPDATE", "app_user", user.getId(),
                "username=" + user.getUsername() + ", role=" + user.getRole()
                        + ", displayName=" + user.getDisplayName());
        return toResponse(user);
    }

    @Transactional
    public AdminUserResponse changeStatus(String userId, UserStatusRequest req) {
        AppUser user = findUser(userId);
        if (req == null || req.enabled() == null) {
            throw BizException.validation("enabled 不能为空");
        }
        if (!req.enabled()) {
            if (user.getUsername().equals(RequestContext.operator())) {
                throw BizException.validation("不能停用当前登录账号");
            }
            assertNotLastAdmin(user, false);
        }
        user.setEnabled(req.enabled());
        // 停用/启用都递增：停用立即踢下线，启用后旧 token 也不复活
        user.setTokenVersion(user.getTokenVersion() + 1);
        userRepository.save(user);
        auditService.record(req.enabled() ? "USER_ENABLE" : "USER_DISABLE", "app_user", user.getId(),
                "username=" + user.getUsername());
        return toResponse(user);
    }

    @Transactional
    public AdminUserResponse resetPassword(String userId, UserPasswordRequest req) {
        AppUser user = findUser(userId);
        user.setPasswordHash(passwordEncoder.encode(
                validatedPassword(req != null ? req.password() : null)));
        // 重置密码后旧 token 立即失效
        user.setTokenVersion(user.getTokenVersion() + 1);
        userRepository.save(user);
        auditService.record("USER_RESET_PASSWORD", "app_user", user.getId(),
                "username=" + user.getUsername());
        return toResponse(user);
    }

    private AppUser findUser(String userId) {
        return userRepository.findById(userId)
                .orElseThrow(() -> BizException.notFound("用户不存在: " + userId));
    }

    /** 该操作是否会让 user 失去"启用中 ADMIN"身份（改角色离开 ADMIN，或停用启用中的 ADMIN）。 */
    private void assertNotLastAdmin(AppUser user, boolean remainsEnabledAdmin) {
        if (!Role.ADMIN.name().equals(user.getRole()) || !Boolean.TRUE.equals(user.getEnabled())
                || remainsEnabledAdmin) {
            return;
        }
        long enabledAdmins = userRepository.findAll().stream()
                .filter(u -> Role.ADMIN.name().equals(u.getRole()) && Boolean.TRUE.equals(u.getEnabled()))
                .count();
        if (enabledAdmins <= 1) {
            throw BizException.stateConflict("至少需要保留一个启用中的管理员账号");
        }
    }

    private static String validatedRole(String role) {
        if (role == null || role.isBlank()) {
            throw BizException.validation("角色不能为空，必须是 DISPATCHER / REVIEWER / PRODUCTION_MANAGER / ADMIN");
        }
        try {
            return Role.valueOf(role.trim()).name();
        } catch (IllegalArgumentException e) {
            throw BizException.validation("非法角色: " + role + "，必须是 DISPATCHER / REVIEWER / PRODUCTION_MANAGER / ADMIN");
        }
    }

    /** 密码复杂度：至少 8 位，且同时包含字母与数字（与种子账号 Fj@123456 同一强度）。 */
    private static String validatedPassword(String password) {
        if (password == null || password.length() < 8
                || !password.chars().anyMatch(Character::isLetter)
                || !password.chars().anyMatch(Character::isDigit)) {
            throw BizException.validation("密码至少 8 位，且须同时包含字母与数字");
        }
        return password;
    }

    private static AdminUserResponse toResponse(AppUser user) {
        return new AdminUserResponse(user.getId(), user.getUsername(), user.getRole(),
                user.getDisplayName(), user.getEnabled(), user.getCreatedAt());
    }
}
