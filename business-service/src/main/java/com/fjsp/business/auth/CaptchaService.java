package com.fjsp.business.auth;

import java.awt.Color;
import java.awt.Font;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Instant;
import java.util.Base64;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

import javax.imageio.ImageIO;

import com.fjsp.business.common.BizException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

/** 单实例登录图形验证码：答案只存服务端，2 分钟有效，每次校验均消费。 */
@Service
public class CaptchaService {

    static final int TTL_SECONDS = 120;
    static final int MAX_ENTRIES = 1000;
    private static final String ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
    private final Map<String, Entry> entries = new HashMap<>();
    private final SecureRandom random;
    private final Clock clock;

    private record Entry(String answer, Instant expiresAt) { }
    public record Challenge(String captchaId, String image, Instant expiresAt) { }

    public CaptchaService() {
        this(new SecureRandom(), Clock.systemUTC());
    }

    CaptchaService(SecureRandom random, Clock clock) {
        this.random = random;
        this.clock = clock;
    }

    public synchronized Challenge issue() {
        Instant now = clock.instant();
        entries.entrySet().removeIf(e -> !now.isBefore(e.getValue().expiresAt()));
        if (entries.size() >= MAX_ENTRIES) {
            throw new BizException("E_CAPTCHA_BUSY", "验证码请求较多，请稍后重试", HttpStatus.TOO_MANY_REQUESTS);
        }
        StringBuilder answer = new StringBuilder(4);
        for (int i = 0; i < 4; i++) {
            answer.append(ALPHABET.charAt(random.nextInt(ALPHABET.length())));
        }
        String image = render(answer.toString());
        String id = UUID.randomUUID().toString();
        Instant expiresAt = now.plusSeconds(TTL_SECONDS);
        entries.put(id, new Entry(answer.toString(), expiresAt));
        return new Challenge(id, image, expiresAt);
    }

    public synchronized void verify(String id, String code) {
        Entry entry = id == null ? null : entries.remove(id);
        if (entry == null || !clock.instant().isBefore(entry.expiresAt()) || code == null
                || !entry.answer().equals(code.trim().toUpperCase(Locale.ROOT))) {
            throw new BizException("E_CAPTCHA_INVALID", "验证码错误或已过期，请输入新的验证码");
        }
    }

    private String render(String answer) {
        BufferedImage image = new BufferedImage(136, 46, BufferedImage.TYPE_INT_RGB);
        var graphics = image.createGraphics();
        try {
            graphics.setColor(new Color(239, 247, 246));
            graphics.fillRect(0, 0, 136, 46);
            graphics.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
            for (int i = 0; i < 7; i++) {
                graphics.setColor(new Color(150 + random.nextInt(60), 190, 185));
                graphics.drawLine(random.nextInt(136), random.nextInt(46),
                        random.nextInt(136), random.nextInt(46));
            }
            graphics.setFont(new Font(Font.SANS_SERIF, Font.BOLD, 28));
            for (int i = 0; i < answer.length(); i++) {
                var transform = graphics.getTransform();
                int x = 12 + i * 30;
                int y = 32 + random.nextInt(5);
                graphics.rotate((random.nextInt(25) - 12) * Math.PI / 180, x + 10, 23);
                graphics.setColor(new Color(20 + random.nextInt(60), 90 + random.nextInt(40), 95));
                graphics.drawString(String.valueOf(answer.charAt(i)), x, y);
                graphics.setTransform(transform);
            }
        } finally {
            graphics.dispose();
        }
        try (var output = new ByteArrayOutputStream()) {
            ImageIO.write(image, "png", output);
            return "data:image/png;base64," + Base64.getEncoder().encodeToString(output.toByteArray());
        } catch (IOException e) {
            throw new IllegalStateException("生成验证码失败", e);
        }
    }
}
