package com.fjsp.business.auth;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.Date;

import javax.crypto.SecretKey;

import com.fjsp.business.config.FjspProperties;
import com.fjsp.business.entity.AppUser;
import io.jsonwebtoken.Claims;
import io.jsonwebtoken.Jws;
import io.jsonwebtoken.JwtException;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import org.springframework.stereotype.Service;

/**
 * HS256 JWT 签发与校验。密钥来自 fjsp.auth.jwt-secret（环境变量 FJSP_JWT_SECRET），
 * 有效期 fjsp.auth.token-ttl（默认 8h）。
 */
@Service
public class JwtService {

    private final SecretKey key;
    private final Duration tokenTtl;

    public JwtService(FjspProperties properties) {
        String secret = properties.getAuth().getJwtSecret();
        if (secret == null || secret.getBytes(StandardCharsets.UTF_8).length < 32) {
            throw new IllegalStateException("fjsp.auth.jwt-secret 至少需要 32 字节（HS256）");
        }
        this.key = Keys.hmacShaKeyFor(secret.getBytes(StandardCharsets.UTF_8));
        this.tokenTtl = properties.getAuth().getTokenTtl();
    }

    public String generateToken(AppUser user) {
        OffsetDateTime now = OffsetDateTime.now();
        return Jwts.builder()
                .subject(user.getUsername())
                .claim("role", user.getRole())
                .claim("displayName", user.getDisplayName() != null ? user.getDisplayName() : "")
                // tokenVersion：停用/改角色/重置密码时递增，过滤器比对后旧 token 立即失效
                .claim("tv", user.getTokenVersion())
                .issuedAt(Date.from(now.toInstant()))
                .expiration(Date.from(now.plus(tokenTtl).toInstant()))
                .signWith(key)
                .compact();
    }

    /** 校验签名与有效期；非法或过期抛 JwtException。 */
    public Jws<Claims> parse(String token) throws JwtException {
        return Jwts.parser().verifyWith(key).build().parseSignedClaims(token);
    }

    public OffsetDateTime expiresAt(Jws<Claims> jws) {
        return OffsetDateTime.ofInstant(jws.getPayload().getExpiration().toInstant(), ZoneOffset.UTC);
    }

    public Duration getTokenTtl() {
        return tokenTtl;
    }
}
