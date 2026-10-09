package com.fjsp.business.actuator;

import java.time.Duration;

import com.fasterxml.jackson.databind.JsonNode;
import com.fjsp.business.config.FjspProperties;
import org.springframework.boot.actuate.health.Health;
import org.springframework.boot.actuate.health.HealthIndicator;
import org.springframework.boot.web.client.ClientHttpRequestFactories;
import org.springframework.boot.web.client.ClientHttpRequestFactorySettings;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

/**
 * 算法服务依赖探活：GET /health，独立 2s 短超时，不影响主求解链路。
 * 不加入 readiness 分组（见 application.yml），算法服务宕机仅在 /actuator/health
 * 全量详情中体现为 DOWN，业务服务保持可用。
 */
@Component("algorithmService")
public class AlgorithmServiceHealthIndicator implements HealthIndicator {

    private static final Duration HEALTH_TIMEOUT = Duration.ofSeconds(2);

    private final RestClient restClient;

    public AlgorithmServiceHealthIndicator(FjspProperties properties, RestClient.Builder builder) {
        ClientHttpRequestFactorySettings settings = ClientHttpRequestFactorySettings.DEFAULTS
                .withConnectTimeout(HEALTH_TIMEOUT)
                .withReadTimeout(HEALTH_TIMEOUT);
        this.restClient = builder
                .baseUrl(properties.getAlgorithm().getBaseUrl())
                .requestFactory(ClientHttpRequestFactories.get(settings))
                .build();
    }

    @Override
    public Health health() {
        try {
            JsonNode node = restClient.get().uri("/health").retrieve().body(JsonNode.class);
            if (node != null && "UP".equals(node.path("status").asText())) {
                return Health.up()
                        .withDetail("version", node.path("version").asText("unknown"))
                        .withDetail("algorithmVersion", node.path("algorithmVersion").asText("unknown"))
                        .build();
            }
            return Health.down()
                    .withDetail("reason", "unexpected /health payload: " + node)
                    .build();
        } catch (Exception e) {
            return Health.down()
                    .withDetail("error", e.getClass().getSimpleName() + ": " + e.getMessage())
                    .build();
        }
    }
}
