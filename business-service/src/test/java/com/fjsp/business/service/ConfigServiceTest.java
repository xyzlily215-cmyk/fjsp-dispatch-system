package com.fjsp.business.service;

import java.util.Optional;

import com.fjsp.business.common.BizException;
import com.fjsp.business.entity.SysConfig;
import com.fjsp.business.repository.SysConfigRepository;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class ConfigServiceTest {

    @Mock
    private SysConfigRepository configRepository;
    @Mock
    private AuditService auditService;

    private ConfigService service() {
        return new ConfigService(configRepository, auditService);
    }

    private SysConfig config(String key, String value, int version) {
        SysConfig config = new SysConfig();
        config.setId("cfg-1");
        config.setConfigKey(key);
        config.setConfigValue(value);
        config.setVersion(version);
        return config;
    }

    @Test
    void update_incrementsVersionAndAudits() {
        SysConfig config = config(ConfigService.EXECUTION_DEVIATION_THRESHOLD_MINUTES, "15", 1);
        when(configRepository.findByConfigKey(ConfigService.EXECUTION_DEVIATION_THRESHOLD_MINUTES))
                .thenReturn(Optional.of(config));

        var data = service().update(
                ConfigService.EXECUTION_DEVIATION_THRESHOLD_MINUTES, "20");

        assertEquals(2, data.version());
        assertEquals("20", data.configValue());
        assertEquals(2, config.getVersion());
        verify(auditService).record(any(), any(), any(), any());
    }

    @Test
    void update_unknownKey_notFound() {
        when(configRepository.findByConfigKey("NOPE")).thenReturn(Optional.empty());

        BizException e = assertThrows(BizException.class, () -> service().update("NOPE", "1"));
        assertEquals("E_NOT_FOUND", e.getCode());
    }

    @Test
    void update_blankValue_validation() {
        BizException e = assertThrows(BizException.class,
                () -> service().update(ConfigService.EXECUTION_DEVIATION_THRESHOLD_MINUTES, " "));
        assertEquals("E_VALIDATION", e.getCode());
    }

    @Test
    void getLong_missingKey_returnsDefault() {
        when(configRepository.findByConfigKey("NOPE")).thenReturn(Optional.empty());

        assertEquals(15, service().getLong("NOPE", 15));
    }

    @Test
    void getLong_invalidValue_returnsDefault() {
        when(configRepository.findByConfigKey("BROKEN"))
                .thenReturn(Optional.of(config("BROKEN", "not-a-number", 1)));

        assertEquals(15, service().getLong("BROKEN", 15));
    }

    @Test
    void getLong_readsConfiguredValue() {
        when(configRepository.findByConfigKey(ConfigService.EXECUTION_DEVIATION_THRESHOLD_MINUTES))
                .thenReturn(Optional.of(config(ConfigService.EXECUTION_DEVIATION_THRESHOLD_MINUTES, "30", 2)));

        assertEquals(30, service().getLong(ConfigService.EXECUTION_DEVIATION_THRESHOLD_MINUTES, 15));
    }

    @Test
    void getValue_cachesResult_repositoryHitOnce() {
        ConfigService service = service();
        when(configRepository.findByConfigKey(ConfigService.EXCEPTION_REASON_CODES))
                .thenReturn(Optional.of(config(ConfigService.EXCEPTION_REASON_CODES, "A,B", 1)));

        assertEquals("A,B", service.getValue(ConfigService.EXCEPTION_REASON_CODES, "X"));
        assertEquals("A,B", service.getValue(ConfigService.EXCEPTION_REASON_CODES, "X"));
        verify(configRepository, times(1)).findByConfigKey(ConfigService.EXCEPTION_REASON_CODES);
    }

    @Test
    void update_refreshesCache() {
        ConfigService service = service();
        SysConfig config = config(ConfigService.EXECUTION_DEVIATION_THRESHOLD_MINUTES, "15", 1);
        when(configRepository.findByConfigKey(ConfigService.EXECUTION_DEVIATION_THRESHOLD_MINUTES))
                .thenReturn(Optional.of(config));

        assertEquals(15, service.getLong(ConfigService.EXECUTION_DEVIATION_THRESHOLD_MINUTES, 15));
        service.update(ConfigService.EXECUTION_DEVIATION_THRESHOLD_MINUTES, "25");
        // 更新后读缓存即拿到新值，不再回库
        assertEquals(25, service.getLong(ConfigService.EXECUTION_DEVIATION_THRESHOLD_MINUTES, 15));
    }
}
