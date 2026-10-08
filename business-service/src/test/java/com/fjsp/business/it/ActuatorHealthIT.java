package com.fjsp.business.it;

import com.fasterxml.jackson.databind.JsonNode;
import com.fjsp.business.entity.TaskStatus;
import com.fjsp.business.metrics.FjspMetrics;
import io.micrometer.core.instrument.MeterRegistry;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Actuator 端点集成测试：算法服务指向必然拒绝连接的 127.0.0.1:1（DOWN），
 * 验证 readiness 分组不受影响、algorithmService 仅在全量健康详情中体现。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = "fjsp.algorithm.base-url=http://127.0.0.1:1")
class ActuatorHealthIT extends AbstractPostgresIT {

    @Autowired
    private TestRestTemplate restTemplate;
    @Autowired
    private MeterRegistry meterRegistry;

    @Test
    void liveness_upWithOnlyLivenessState() {
        ResponseEntity<JsonNode> resp = restTemplate.getForEntity("/actuator/health/liveness", JsonNode.class);

        assertEquals(HttpStatus.OK, resp.getStatusCode());
        JsonNode body = resp.getBody();
        assertNotNull(body);
        assertEquals("UP", body.path("status").asText());
        JsonNode components = body.path("components");
        assertTrue(components.has("livenessState"));
        assertFalse(components.has("db"), "liveness 不应包含外部依赖探针");
        assertFalse(components.has("algorithmService"));
    }

    @Test
    void readiness_upWithStateDbFlyway_evenWhenAlgorithmDown() {
        ResponseEntity<JsonNode> resp = restTemplate.getForEntity("/actuator/health/readiness", JsonNode.class);

        assertEquals(HttpStatus.OK, resp.getStatusCode(), "算法服务 DOWN 不应影响 readiness");
        JsonNode body = resp.getBody();
        assertNotNull(body);
        assertEquals("UP", body.path("status").asText());
        JsonNode components = body.path("components");
        assertTrue(components.has("readinessState"));
        assertEquals("UP", components.path("db").path("status").asText());
        assertEquals("UP", components.path("flyway").path("status").asText());
        assertFalse(components.has("algorithmService"), "readiness 分组不应包含算法服务探针");
    }

    @Test
    void fullHealth_algorithmDown_showsComponentDetail() {
        ResponseEntity<JsonNode> resp = restTemplate.getForEntity("/actuator/health", JsonNode.class);

        assertEquals(HttpStatus.SERVICE_UNAVAILABLE, resp.getStatusCode());
        JsonNode body = resp.getBody();
        assertNotNull(body);
        assertEquals("DOWN", body.path("status").asText());
        JsonNode algorithm = body.path("components").path("algorithmService");
        assertEquals("DOWN", algorithm.path("status").asText());
        assertTrue(algorithm.path("details").has("error"));
    }

    @Test
    void metricsAndPrometheusRequireAuthentication() {
        assertEquals(HttpStatus.UNAUTHORIZED,
                restTemplate.getForEntity("/actuator/metrics", String.class).getStatusCode());
        assertEquals(HttpStatus.UNAUTHORIZED,
                restTemplate.getForEntity("/actuator/prometheus", String.class).getStatusCode());
    }

    @Test
    void businessAndHikariMetricsRegistered() {
        for (TaskStatus status : TaskStatus.values()) {
            assertNotNull(meterRegistry.find(FjspMetrics.TASKS_TOTAL).tag("status", status.name()).gauge(),
                    "缺少 status=" + status.name() + " 的 fjsp.tasks.total Gauge");
        }
        assertNotNull(meterRegistry.find(FjspMetrics.TASKS_QUEUE).gauge());
        assertNotNull(meterRegistry.find(FjspMetrics.SSE_CONNECTIONS).gauge());
        assertNotNull(meterRegistry.find("hikaricp.connections").gauge(),
                "HikariCP 连接池指标应由 micrometer 自动采集");
    }
}
