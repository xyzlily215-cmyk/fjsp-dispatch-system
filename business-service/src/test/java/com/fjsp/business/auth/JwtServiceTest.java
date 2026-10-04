package com.fjsp.business.auth;

import com.fjsp.business.config.FjspProperties;
import com.fjsp.business.entity.AppUser;
import io.jsonwebtoken.Claims;
import io.jsonwebtoken.ExpiredJwtException;
import io.jsonwebtoken.Jws;
import io.jsonwebtoken.JwtException;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class JwtServiceTest {

    private static final String SECRET = "test-jwt-secret-test-jwt-secret-123456";

    private JwtService jwtService(java.time.Duration tokenTtl) {
        FjspProperties properties = new FjspProperties();
        properties.getAuth().setJwtSecret(SECRET);
        properties.getAuth().setTokenTtl(tokenTtl);
        return new JwtService(properties);
    }

    private AppUser user() {
        AppUser user = new AppUser();
        user.setUsername("dispatcher");
        user.setRole("DISPATCHER");
        user.setDisplayName("调度员");
        return user;
    }

    @Test
    void generateAndParse_roundTrip() {
        JwtService service = jwtService(java.time.Duration.ofHours(8));

        String token = service.generateToken(user());
        Jws<Claims> jws = service.parse(token);

        assertEquals("dispatcher", jws.getPayload().getSubject());
        assertEquals("DISPATCHER", jws.getPayload().get("role", String.class));
        assertNotNull(service.expiresAt(jws));
        assertTrue(service.expiresAt(jws).isAfter(java.time.OffsetDateTime.now().plusHours(7)));
    }

    @Test
    void parse_expiredToken_rejected() {
        JwtService service = jwtService(java.time.Duration.ofHours(-1));
        String token = service.generateToken(user());

        assertThrows(ExpiredJwtException.class, () -> service.parse(token));
    }

    @Test
    void parse_tamperedSignature_rejected() {
        JwtService service = jwtService(java.time.Duration.ofHours(8));
        String token = service.generateToken(user());
        String tampered = token.substring(0, token.length() - 2)
                + (token.endsWith("aa") ? "bb" : "aa");

        assertThrows(JwtException.class, () -> service.parse(tampered));
    }

    @Test
    void parse_wrongKey_rejected() {
        String token = jwtService(java.time.Duration.ofHours(8)).generateToken(user());
        FjspProperties other = new FjspProperties();
        other.getAuth().setJwtSecret("another-secret-another-secret-12345678");
        JwtService otherService = new JwtService(other);

        assertThrows(JwtException.class, () -> otherService.parse(token));
    }

    @Test
    void shortSecret_rejected() {
        FjspProperties properties = new FjspProperties();
        properties.getAuth().setJwtSecret("too-short");

        assertThrows(IllegalStateException.class, () -> new JwtService(properties));
    }
}
