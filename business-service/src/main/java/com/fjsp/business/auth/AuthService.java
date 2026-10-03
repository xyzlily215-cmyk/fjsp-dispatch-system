package com.fjsp.business.auth;

import java.util.LinkedHashMap;
import java.util.Map;

import com.fjsp.business.common.BizException;
import com.fjsp.business.entity.AppUser;
import com.fjsp.business.repository.AppUserRepository;
import io.jsonwebtoken.Claims;
import io.jsonwebtoken.Jws;
import org.springframework.http.HttpStatus;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;

@Service
public class AuthService {

    private final AppUserRepository userRepository;
    private final PasswordEncoder passwordEncoder;
    private final JwtService jwtService;

    public AuthService(AppUserRepository userRepository,
                       PasswordEncoder passwordEncoder,
                       JwtService jwtService) {
        this.userRepository = userRepository;
        this.passwordEncoder = passwordEncoder;
        this.jwtService = jwtService;
    }

    public Map<String, Object> login(String username, String password) {
        if (username == null || username.isBlank() || password == null) {
            throw unauthorized();
        }
        AppUser user = userRepository.findByUsername(username).orElse(null);
        // 用户不存在 / 已禁用 / 密码错误统一 401，不泄露具体原因
        if (user == null || !Boolean.TRUE.equals(user.getEnabled())
                || !passwordEncoder.matches(password, user.getPasswordHash())) {
            throw unauthorized();
        }
        String token = jwtService.generateToken(user);
        Jws<Claims> jws = jwtService.parse(token);
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("token", token);
        data.put("username", user.getUsername());
        data.put("role", user.getRole());
        data.put("displayName", user.getDisplayName());
        data.put("expiresAt", jwtService.expiresAt(jws));
        return data;
    }

    public Map<String, Object> me(String username) {
        AppUser user = userRepository.findByUsername(username)
                .orElseThrow(AuthService::unauthorized);
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("username", user.getUsername());
        data.put("role", user.getRole());
        data.put("displayName", user.getDisplayName());
        return data;
    }

    private static BizException unauthorized() {
        return new BizException("E_UNAUTHORIZED", "用户名或密码错误", HttpStatus.UNAUTHORIZED);
    }
}
