package com.fjsp.business.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "fjsp")
public class FjspProperties {

    private final Algorithm algorithm = new Algorithm();
    private final Auth auth = new Auth();
    private String simulationStartAt = "2026-09-16T08:00:00+08:00";
    private int freezeWindowMinutes = 30;
    private int idempotencyTtlHours = 24;

    public Algorithm getAlgorithm() {
        return algorithm;
    }

    public Auth getAuth() {
        return auth;
    }

    public String getSimulationStartAt() {
        return simulationStartAt;
    }

    public void setSimulationStartAt(String simulationStartAt) {
        this.simulationStartAt = simulationStartAt;
    }

    public int getFreezeWindowMinutes() {
        return freezeWindowMinutes;
    }

    public void setFreezeWindowMinutes(int freezeWindowMinutes) {
        this.freezeWindowMinutes = freezeWindowMinutes;
    }

    public int getIdempotencyTtlHours() {
        return idempotencyTtlHours;
    }

    public void setIdempotencyTtlHours(int idempotencyTtlHours) {
        this.idempotencyTtlHours = idempotencyTtlHours;
    }

    public static class Algorithm {
        private String baseUrl = "http://localhost:8101";
        private int timeoutSeconds = 620;

        public String getBaseUrl() {
            return baseUrl;
        }

        public void setBaseUrl(String baseUrl) {
            this.baseUrl = baseUrl;
        }

        public int getTimeoutSeconds() {
            return timeoutSeconds;
        }

        public void setTimeoutSeconds(int timeoutSeconds) {
            this.timeoutSeconds = timeoutSeconds;
        }
    }

    public static class Auth {
        private String jwtSecret;
        private int tokenTtlHours = 8;

        public String getJwtSecret() {
            return jwtSecret;
        }

        public void setJwtSecret(String jwtSecret) {
            this.jwtSecret = jwtSecret;
        }

        public int getTokenTtlHours() {
            return tokenTtlHours;
        }

        public void setTokenTtlHours(int tokenTtlHours) {
            this.tokenTtlHours = tokenTtlHours;
        }
    }
}
