package com.fjsp.business.service;

import java.time.OffsetDateTime;
import java.util.Map;
import java.util.Optional;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fjsp.business.common.BizException;
import com.fjsp.business.common.HashUtil;
import com.fjsp.business.config.FjspProperties;
import com.fjsp.business.entity.IdempotencyRecord;
import com.fjsp.business.repository.IdempotencyRecordRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.dao.DataIntegrityViolationException;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class IdempotencyServiceTest {

    @Mock
    private IdempotencyRecordRepository repository;

    private IdempotencyService idempotencyService;

    @BeforeEach
    void setUp() {
        FjspProperties properties = new FjspProperties();
        properties.setIdempotencyTtlHours(24);
        idempotencyService = new IdempotencyService(repository, properties, new ObjectMapper());
    }

    private Map<String, Object> requestBody() {
        return Map.of("mode", "BASELINE");
    }

    private IdempotencyRecord storedRecord(Object body, OffsetDateTime expiresAt) {
        IdempotencyRecord record = new IdempotencyRecord();
        record.setId("id-1");
        record.setIdempotencyKey("key-1");
        record.setRequestHash(HashUtil.sha256OfJson(body));
        record.setResponseJson("{\"taskId\": \"t1\"}");
        record.setExpiresAt(expiresAt);
        return record;
    }

    @Test
    void findReplay_noRecord_returnsEmpty() {
        when(repository.findByIdempotencyKey("key-1")).thenReturn(Optional.empty());

        assertTrue(idempotencyService.findReplay("key-1", requestBody()).isEmpty());
    }

    @Test
    void findReplay_sameKeySameRequest_replaysStoredResponse() {
        when(repository.findByIdempotencyKey("key-1"))
                .thenReturn(Optional.of(storedRecord(requestBody(),
                        OffsetDateTime.now().plusHours(1))));

        Optional<Object> replay = idempotencyService.findReplay("key-1", requestBody());

        assertTrue(replay.isPresent());
        @SuppressWarnings("unchecked")
        Map<String, Object> data = (Map<String, Object>) replay.get();
        assertEquals("t1", data.get("taskId"));
    }

    @Test
    void findReplay_sameKeyDifferentRequest_duplicate() {
        when(repository.findByIdempotencyKey("key-1"))
                .thenReturn(Optional.of(storedRecord(Map.of("mode", "FULL_RESCHEDULE"),
                        OffsetDateTime.now().plusHours(1))));

        BizException e = assertThrows(BizException.class,
                () -> idempotencyService.findReplay("key-1", requestBody()));
        assertEquals("E_DUPLICATE", e.getCode());
    }

    @Test
    void findReplay_expiredRecord_treatedAsAbsent() {
        when(repository.findByIdempotencyKey("key-1"))
                .thenReturn(Optional.of(storedRecord(requestBody(),
                        OffsetDateTime.now().minusHours(1))));

        assertTrue(idempotencyService.findReplay("key-1", requestBody()).isEmpty());
    }

    @Test
    void findReplay_blankKey_validation() {
        BizException e = assertThrows(BizException.class,
                () -> idempotencyService.findReplay("  ", requestBody()));
        assertEquals("E_VALIDATION", e.getCode());
    }

    @Test
    void store_persistsRecord() {
        idempotencyService.store("key-1", requestBody(), Map.of("taskId", "t1"));

        ArgumentCaptor<IdempotencyRecord> captor = ArgumentCaptor.forClass(IdempotencyRecord.class);
        verify(repository).saveAndFlush(captor.capture());
        IdempotencyRecord record = captor.getValue();
        assertEquals("key-1", record.getIdempotencyKey());
        assertNotNull(record.getRequestHash());
        assertTrue(record.getResponseJson().contains("t1"));
        assertTrue(record.getExpiresAt().isAfter(OffsetDateTime.now().plusHours(23)));
    }

    @Test
    void store_concurrentDuplicateKey_swallowed() {
        // 并发同键写入：先写者赢，后写者静默放弃而不是报错
        when(repository.saveAndFlush(any(IdempotencyRecord.class)))
                .thenThrow(new DataIntegrityViolationException("duplicate key"));

        assertDoesNotThrow(() -> idempotencyService.store("key-1", requestBody(), Map.of()));
    }
}
