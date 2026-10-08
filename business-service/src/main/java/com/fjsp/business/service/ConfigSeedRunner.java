package com.fjsp.business.service;

import java.util.List;

import com.fjsp.business.entity.SysConfig;
import com.fjsp.business.repository.SysConfigRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Component;

/**
 * 启动时补齐预置配置项（按 configKey 幂等）。
 * 生产路径由 Flyway V9 建表+预置；local profile（Flyway 关闭）由本 runner 保证配置存在。
 */
@Component
public class ConfigSeedRunner implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(ConfigSeedRunner.class);

    private record SeedConfig(String key, String value, String description) {
    }

    private static final List<SeedConfig> SEED_CONFIGS = List.of(
            new SeedConfig(ConfigService.EXECUTION_DEVIATION_THRESHOLD_MINUTES, "15",
                    "执行偏差阈值（分钟）：实际开/完工与计划偏差超过该值时标记 EXECUTION_DEVIATION"),
            new SeedConfig(ConfigService.DEFAULT_FREEZE_WINDOW_MINUTES, "30",
                    "重调度冻结窗口默认值（分钟），与 fjsp.freeze-window 一致；可在任务参数中覆盖"),
            new SeedConfig(ConfigService.EXCEPTION_REASON_CODES,
                    "MACHINE_BREAKDOWN,MATERIAL_SHORTAGE,QUALITY_ISSUE,CALENDAR_BLOCKED,PREDECESSOR_WAIT,OPERATOR_ERROR,OTHER",
                    "执行异常原因码字典（逗号分隔）"));

    private final SysConfigRepository configRepository;

    public ConfigSeedRunner(SysConfigRepository configRepository) {
        this.configRepository = configRepository;
    }

    @Override
    public void run(ApplicationArguments args) {
        for (SeedConfig seed : SEED_CONFIGS) {
            if (configRepository.existsByConfigKey(seed.key())) {
                continue;
            }
            SysConfig config = ConfigService.newConfig(seed.key(), seed.value(), seed.description());
            config.setUpdatedBy("system");
            configRepository.save(config);
            log.info("seeded config {} = {}", seed.key(), seed.value());
        }
    }
}
