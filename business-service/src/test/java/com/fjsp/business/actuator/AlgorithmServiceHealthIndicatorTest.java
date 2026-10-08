package com.fjsp.business.actuator;

import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;

import com.fjsp.business.config.FjspProperties;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;
import org.springframework.boot.actuate.health.Health;
import org.springframework.boot.actuate.health.Status;
import org.springframework.web.client.RestClient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class AlgorithmServiceHealthIndicatorTest {

    private AlgorithmServiceHealthIndicator indicator(String baseUrl) {
        FjspProperties properties = new FjspProperties();
        properties.getAlgorithm().setBaseUrl(baseUrl);
        return new AlgorithmServiceHealthIndicator(properties, RestClient.builder());
    }

    private HttpServer stubHealthServer(String body) throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/health", exchange -> {
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, bytes.length);
            exchange.getResponseBody().write(bytes);
            exchange.close();
        });
        server.start();
        return server;
    }

    @Test
    void health_algorithmUp_reportsUpWithVersionDetails() throws Exception {
        HttpServer server = stubHealthServer(
                "{\"status\":\"UP\",\"version\":\"1.0.0\",\"algorithmVersion\":\"event-adaptive-hga-1.0.0\"}");
        try {
            Health health = indicator("http://127.0.0.1:" + server.getAddress().getPort()).health();

            assertEquals(Status.UP, health.getStatus());
            assertEquals("1.0.0", health.getDetails().get("version"));
            assertEquals("event-adaptive-hga-1.0.0", health.getDetails().get("algorithmVersion"));
        } finally {
            server.stop(0);
        }
    }

    @Test
    void health_algorithmUnreachable_reportsDown() {
        // 127.0.0.1:1 必然连接拒绝
        Health health = indicator("http://127.0.0.1:1").health();

        assertEquals(Status.DOWN, health.getStatus());
        assertTrue(health.getDetails().containsKey("error"));
    }

    @Test
    void health_unexpectedPayload_reportsDown() throws Exception {
        HttpServer server = stubHealthServer("{\"status\":\"DOWN\"}");
        try {
            Health health = indicator("http://127.0.0.1:" + server.getAddress().getPort()).health();

            assertEquals(Status.DOWN, health.getStatus());
            assertTrue(health.getDetails().containsKey("reason"));
        } finally {
            server.stop(0);
        }
    }
}
