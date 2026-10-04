package com.fjsp.business.service;

import java.time.OffsetDateTime;
import java.util.Optional;
import java.util.UUID;
import java.util.function.Supplier;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fjsp.business.common.BizException;
import com.fjsp.business.common.HashUtil;
import com.fjsp.business.config.FjspProperties;
import com.fjsp.business.entity.IdempotencyRecord;
import com.fjsp.business.repository.IdempotencyRecordRepository;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

@Service
public class IdempotencyService {

    private final IdempotencyRecordRepository repository;
    private final FjspProperties properties;
    private final ObjectMapper objectMapper;

    public IdempotencyService(IdempotencyRecordRepository repository, FjspProperties properties,
                              ObjectMapper objectMapper) {
        this.repository = repository;
        this.properties = properties;
        this.objectMapper = objectMapper;
    }

    public void requireKey(String idempotencyKey) {
        if (idempotencyKey == null || idempotencyKey.isBlank()) {
            throw BizException.validation("写接口必须携带 Idempotency-Key 请求头");
        }
    }

    /**
     * Returns a previously stored response payload when the same key + same request body
     * was already processed within the TTL; throws E_DUPLICATE for same key + different body.
     */
    public Optional<Object> findReplay(String idempotencyKey, Object requestBody) {
        requireKey(idempotencyKey);
        String requestHash = HashUtil.sha256OfJson(requestBody);
        Optional<IdempotencyRecord> existing = repository.findByIdempotencyKey(idempotencyKey);
        if (existing.isEmpty()) {
            return Optional.empty();
        }
        IdempotencyRecord record = existing.get();
        if (record.getExpiresAt().isBefore(OffsetDateTime.now())) {
            return Optional.empty();
        }
        if (!record.getRequestHash().equals(requestHash)) {
            throw BizException.duplicate("Idempotency-Key 已使用但请求摘要不一致");
        }
        try {
            return Optional.of(objectMapper.readValue(record.getResponseJson(), Object.class));
        } catch (Exception e) {
            throw new IllegalStateException("cannot parse stored idempotent response", e);
        }
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void store(String idempotencyKey, Object requestBody, Object responseData) {
        IdempotencyRecord record = new IdempotencyRecord();
        record.setId(UUID.randomUUID().toString());
        record.setIdempotencyKey(idempotencyKey);
        record.setRequestHash(HashUtil.sha256OfJson(requestBody));
        record.setExpiresAt(OffsetDateTime.now().plus(properties.getIdempotencyTtl()));
        try {
            record.setResponseJson(objectMapper.writeValueAsString(responseData));
        } catch (Exception e) {
            throw new IllegalStateException("cannot serialize idempotent response", e);
        }
        try {
            repository.saveAndFlush(record);
        } catch (DataIntegrityViolationException e) {
            // concurrent insert with the same key: first writer wins, nothing to store
        }
    }
}
