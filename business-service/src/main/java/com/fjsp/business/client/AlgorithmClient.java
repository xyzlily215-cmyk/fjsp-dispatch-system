package com.fjsp.business.client;

import java.time.Duration;
import java.util.Map;

import com.fasterxml.jackson.databind.JsonNode;
import com.fjsp.business.config.FjspProperties;
import org.springframework.boot.web.client.ClientHttpRequestFactories;
import org.springframework.boot.web.client.ClientHttpRequestFactorySettings;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

@Component
public class AlgorithmClient {

    private final RestClient restClient;

    public AlgorithmClient(FjspProperties properties, RestClient.Builder builder) {
        Duration timeout = Duration.ofSeconds(properties.getAlgorithm().getTimeoutSeconds());
        ClientHttpRequestFactorySettings settings = ClientHttpRequestFactorySettings.DEFAULTS
                .withConnectTimeout(Duration.ofSeconds(10))
                .withReadTimeout(timeout);
        this.restClient = builder
                .baseUrl(properties.getAlgorithm().getBaseUrl())
                .requestFactory(ClientHttpRequestFactories.get(settings))
                .build();
    }

    public JsonNode solve(Map<String, Object> solveRequest) {
        return restClient.post()
                .uri("/solve")
                .contentType(MediaType.APPLICATION_JSON)
                .body(solveRequest)
                .retrieve()
                .body(JsonNode.class);
    }

    public JsonNode validate(Map<String, Object> validateRequest) {
        return restClient.post()
                .uri("/validate")
                .contentType(MediaType.APPLICATION_JSON)
                .body(validateRequest)
                .retrieve()
                .body(JsonNode.class);
    }

    public String health() {
        JsonNode node = restClient.get().uri("/health").retrieve().body(JsonNode.class);
        return node != null ? node.toString() : "{}";
    }
}
