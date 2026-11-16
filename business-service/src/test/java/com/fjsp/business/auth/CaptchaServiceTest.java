package com.fjsp.business.auth;

import java.io.ByteArrayInputStream;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Instant;
import java.util.Base64;

import javax.imageio.ImageIO;

import com.fjsp.business.common.BizException;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.Mockito.*;

class CaptchaServiceTest {
    private final Clock clock = mock(Clock.class);
    private final Instant now = Instant.parse("2026-11-16T00:00:00Z");

    private CaptchaService service() {
        SecureRandom random = mock(SecureRandom.class);
        when(random.nextInt(anyInt())).thenReturn(8); // AAAA
        when(clock.instant()).thenReturn(now);
        return new CaptchaService(random, clock);
    }

    @Test
    void imageIsPng_andChallengeIsUnique() throws Exception {
        var service = service();
        var first = service.issue();
        var second = service.issue();
        assertNotEquals(first.captchaId(), second.captchaId());
        assertEquals(now.plusSeconds(120), first.expiresAt());
        var image = ImageIO.read(new ByteArrayInputStream(Base64.getDecoder()
                .decode(first.image().substring("data:image/png;base64,".length()))));
        assertEquals(136, image.getWidth());
        assertEquals(46, image.getHeight());
    }

    @Test
    void correctAnswerIsCaseInsensitive_andCannotBeReplayed() {
        var service = service();
        var challenge = service.issue();
        assertDoesNotThrow(() -> service.verify(challenge.captchaId(), " aaaa "));
        assertEquals("E_CAPTCHA_INVALID", assertThrows(BizException.class,
                () -> service.verify(challenge.captchaId(), "AAAA")).getCode());
    }

    @Test
    void incorrectOrMissingAnswerConsumesChallenge() {
        var service = service();
        for (String answer : new String[] {"WRNG", null, ""}) {
            var challenge = service.issue();
            assertThrows(BizException.class, () -> service.verify(challenge.captchaId(), answer));
            assertThrows(BizException.class, () -> service.verify(challenge.captchaId(), "AAAA"));
        }
        assertThrows(BizException.class, () -> service.verify(null, "AAAA"));
        assertThrows(BizException.class, () -> service.verify("unknown", "AAAA"));
    }

    @Test
    void expiredChallengeIsRejectedAtExactExpiry() {
        var service = service();
        var challenge = service.issue();
        when(clock.instant()).thenReturn(now.plusSeconds(120));
        assertThrows(BizException.class, () -> service.verify(challenge.captchaId(), "AAAA"));
    }
}
