package com.fjsp.business.config;

import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.List;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

/**
 * FJSP 业务服务配置（prefix=fjsp）。默认值唯一来源为本类字段初始值，
 * YAML 只做覆盖；绑定校验失败（如密钥过短）启动即报错。
 */
@Validated
@ConfigurationProperties(prefix = "fjsp")
public class FjspProperties {

    public enum SimulationMode {
        /** 仿真起点相对当前时间生成（seed 基准 = 种子订单最小到达时间，未 seed 时取 now）。 */
        RELATIVE,
        /** 固定仿真起点：优先 seed json 的 simulationStartAt，其次 fjsp.simulation.start-at。 */
        FIXED
    }

    @Valid
    private final Simulation simulation = new Simulation();
    @Valid
    private final Algorithm algorithm = new Algorithm();
    @Valid
    private final Task task = new Task();
    @Valid
    private final Auth auth = new Auth();
    @Valid
    private final Cors cors = new Cors();

    @NotNull
    private Duration freezeWindow = Duration.ofMinutes(30);
    @NotNull
    private Duration idempotencyTtl = Duration.ofHours(24);

    public Simulation getSimulation() {
        return simulation;
    }

    public Algorithm getAlgorithm() {
        return algorithm;
    }

    public Task getTask() {
        return task;
    }

    public Auth getAuth() {
        return auth;
    }

    public Cors getCors() {
        return cors;
    }

    public Duration getFreezeWindow() {
        return freezeWindow;
    }

    public void setFreezeWindow(Duration freezeWindow) {
        this.freezeWindow = freezeWindow;
    }

    public Duration getIdempotencyTtl() {
        return idempotencyTtl;
    }

    public void setIdempotencyTtl(Duration idempotencyTtl) {
        this.idempotencyTtl = idempotencyTtl;
    }

    public static class Simulation {
        @NotNull
        private SimulationMode mode = SimulationMode.RELATIVE;
        /** 仅 FIXED 模式使用；缺失且 seed json 也无值时使用时抛出明确错误。 */
        private OffsetDateTime startAt;

        public SimulationMode getMode() {
            return mode;
        }

        public void setMode(SimulationMode mode) {
            this.mode = mode;
        }

        public OffsetDateTime getStartAt() {
            return startAt;
        }

        public void setStartAt(OffsetDateTime startAt) {
            this.startAt = startAt;
        }
    }

    public static class Algorithm {
        @NotNull
        private String baseUrl = "http://localhost:8101";
        @NotNull
        private Duration timeout = Duration.ofSeconds(620);
        @NotNull
        private Duration connectTimeout = Duration.ofSeconds(10);

        public String getBaseUrl() {
            return baseUrl;
        }

        public void setBaseUrl(String baseUrl) {
            this.baseUrl = baseUrl;
        }

        public Duration getTimeout() {
            return timeout;
        }

        public void setTimeout(Duration timeout) {
            this.timeout = timeout;
        }

        public Duration getConnectTimeout() {
            return connectTimeout;
        }

        public void setConnectTimeout(Duration connectTimeout) {
            this.connectTimeout = connectTimeout;
        }
    }

    public static class Task {
        @NotNull
        private Duration scanInterval = Duration.ofSeconds(30);
        /** RUNNING 任务 timeoutAt = now + algorithm.timeout + timeoutBuffer。 */
        @NotNull
        private Duration timeoutBuffer = Duration.ofSeconds(60);
        @Valid
        private final Executor executor = new Executor();

        public Duration getScanInterval() {
            return scanInterval;
        }

        public void setScanInterval(Duration scanInterval) {
            this.scanInterval = scanInterval;
        }

        public Duration getTimeoutBuffer() {
            return timeoutBuffer;
        }

        public void setTimeoutBuffer(Duration timeoutBuffer) {
            this.timeoutBuffer = timeoutBuffer;
        }

        public Executor getExecutor() {
            return executor;
        }

        public static class Executor {
            @Min(1)
            private int coreSize = 2;
            @Min(1)
            private int maxSize = 4;
            @Min(0)
            private int queueCapacity = 20;

            public int getCoreSize() {
                return coreSize;
            }

            public void setCoreSize(int coreSize) {
                this.coreSize = coreSize;
            }

            public int getMaxSize() {
                return maxSize;
            }

            public void setMaxSize(int maxSize) {
                this.maxSize = maxSize;
            }

            public int getQueueCapacity() {
                return queueCapacity;
            }

            public void setQueueCapacity(int queueCapacity) {
                this.queueCapacity = queueCapacity;
            }
        }
    }

    public static class Auth {
        /** HS256 密钥，无 Java 默认值：local/test profile 给演示值，生产必须经 FJSP_JWT_SECRET 注入。 */
        @NotNull
        @Size(min = 32)
        private String jwtSecret;
        @NotNull
        private Duration tokenTtl = Duration.ofHours(8);

        public String getJwtSecret() {
            return jwtSecret;
        }

        public void setJwtSecret(String jwtSecret) {
            this.jwtSecret = jwtSecret;
        }

        public Duration getTokenTtl() {
            return tokenTtl;
        }

        public void setTokenTtl(Duration tokenTtl) {
            this.tokenTtl = tokenTtl;
        }
    }

    public static class Cors {
        /** 允许的来源；空列表 = 不允许任何跨域（最严格），local profile 配 localhost 白名单。 */
        private List<String> allowedOrigins = new ArrayList<>();

        public List<String> getAllowedOrigins() {
            return allowedOrigins;
        }

        public void setAllowedOrigins(List<String> allowedOrigins) {
            this.allowedOrigins = allowedOrigins;
        }
    }
}
