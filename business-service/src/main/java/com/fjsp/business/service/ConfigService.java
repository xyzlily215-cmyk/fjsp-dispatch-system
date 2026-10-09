package com.fjsp.business.service;

import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

import com.fjsp.business.common.BizException;
import com.fjsp.business.common.RequestContext;
import com.fjsp.business.dto.ConfigResponse;
import com.fjsp.business.entity.SysConfig;
import com.fjsp.business.repository.SysConfigRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * F-12 基础字典：键值型配置读取与维护（仅 ADMIN 可改）。
 * 读取侧带进程内缓存（单实例部署），update 时同步刷新缓存并递增版本、写审计。
 */
@Service
public class ConfigService {

    public static final String EXECUTION_DEVIATION_THRESHOLD_MINUTES = "EXECUTION_DEVIATION_THRESHOLD_MINUTES";
    public static final String DEFAULT_FREEZE_WINDOW_MINUTES = "DEFAULT_FREEZE_WINDOW_MINUTES";
    public static final String EXCEPTION_REASON_CODES = "EXCEPTION_REASON_CODES";

    private final SysConfigRepository configRepository;
    private final AuditService auditService;
    private final Map<String, String> cache = new ConcurrentHashMap<>();

    public ConfigService(SysConfigRepository configRepository, AuditService auditService) {
        this.configRepository = configRepository;
        this.auditService = auditService;
    }

    public List<ConfigResponse> list() {
        return configRepository.findAll().stream()
                .sorted(Comparator.comparing(SysConfig::getConfigKey))
                .map(ConfigService::toResponse)
                .toList();
    }

    @Transactional
    public ConfigResponse update(String key, String configValue) {
        if (configValue == null || configValue.isBlank()) {
            throw BizException.validation("configValue 不能为空");
        }
        SysConfig config = configRepository.findByConfigKey(key)
                .orElseThrow(() -> BizException.notFound("配置项不存在: " + key));
        int newVersion = config.getVersion() + 1;
        config.setConfigValue(configValue.trim());
        config.setVersion(newVersion);
        config.setEffectiveAt(java.time.OffsetDateTime.now());
        config.setUpdatedBy(RequestContext.operator());
        config.setUpdatedAt(java.time.OffsetDateTime.now());
        configRepository.save(config);
        cache.put(key, config.getConfigValue());
        auditService.record("CONFIG_UPDATE", "sys_config", key,
                "version=" + newVersion + ", value=" + config.getConfigValue());
        return toResponse(config);
    }

    /** 按键读取字符串值；键缺失时返回 defaultValue。结果缓存，update 后即时生效。 */
    public String getValue(String key, String defaultValue) {
        String cached = cache.get(key);
        if (cached != null) {
            return cached;
        }
        String value = configRepository.findByConfigKey(key)
                .map(SysConfig::getConfigValue)
                .filter(v -> v != null && !v.isBlank())
                .orElse(defaultValue);
        cache.put(key, value);
        return value;
    }

    /** 按键读取数值；键缺失或值非法时回退 defaultValue。 */
    public long getLong(String key, long defaultValue) {
        try {
            return Long.parseLong(getValue(key, String.valueOf(defaultValue)).trim());
        } catch (NumberFormatException e) {
            return defaultValue;
        }
    }

    static SysConfig newConfig(String key, String value, String description) {
        SysConfig config = new SysConfig();
        config.setId(UUID.randomUUID().toString());
        config.setConfigKey(key);
        config.setConfigValue(value);
        config.setDescription(description);
        config.setVersion(1);
        return config;
    }

    private static ConfigResponse toResponse(SysConfig config) {
        return new ConfigResponse(config.getConfigKey(), config.getConfigValue(),
                config.getDescription(), config.getVersion(), config.getEffectiveAt(),
                config.getUpdatedBy(), config.getUpdatedAt());
    }
}
