package com.fjsp.business.auth;

import java.security.SecureRandom;
import java.time.Instant;
import java.util.Base64;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import org.springframework.stereotype.Service;

/**
 * SSE 一次性 stream ticket：EventSource 无法自定义请求头，为避免把 JWT 放进 URL
 * （浏览器历史/代理日志/截图均有泄露面），客户端先用正常 JWT 换取 60s 有效、
 * 一次性、绑定指定任务的 ticket，再以 ?ticket= 建立 SSE 连接。
 * 内存实现：服务重启后 ticket 全部失效，前端重新获取即可。
 */
@Service
public class StreamTicketService {

    public static final long TICKET_TTL_SECONDS = 60;

    private static final SecureRandom RANDOM = new SecureRandom();

    private final Map<String, Ticket> tickets = new ConcurrentHashMap<>();

    public record Ticket(String username, String taskId, Instant expiresAt) {
    }

    public String issue(String username, String taskId) {
        purgeExpired();
        byte[] bytes = new byte[32];
        RANDOM.nextBytes(bytes);
        String ticket = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
        tickets.put(ticket, new Ticket(username, taskId,
                Instant.now().plusSeconds(TICKET_TTL_SECONDS)));
        return ticket;
    }

    /**
     * 一次性消费：取出即删除。校验过期与 taskId 绑定；任何失败都返回 null。
     */
    public Ticket consume(String ticket, String taskId) {
        if (ticket == null || ticket.isBlank()) {
            return null;
        }
        Ticket t = tickets.remove(ticket);
        if (t == null || Instant.now().isAfter(t.expiresAt()) || !t.taskId().equals(taskId)) {
            return null;
        }
        return t;
    }

    /** 惰性清理过期 ticket（由签发动作触发，避免常驻线程）。 */
    void purgeExpired() {
        Instant now = Instant.now();
        tickets.entrySet().removeIf(e -> now.isAfter(e.getValue().expiresAt()));
    }
}
