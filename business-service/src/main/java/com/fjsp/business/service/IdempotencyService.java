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
import jakarta.persistence.EntityManager;
import jakarta.persistence.PersistenceContext;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class IdempotencyService {

    private final IdempotencyRecordRepository repository;
    private final FjspProperties properties;
    private final ObjectMapper objectMapper;

    @PersistenceContext
    private EntityManager entityManager;

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
        return findStoredJson(idempotencyKey, requestBody).map(this::deserializeReplay);
    }

    /**
     * 命中有效幂等记录（同键同请求摘要）时返回其存储的响应 JSON；无记录或已过期返回 empty；
     * 同键不同摘要抛 E_DUPLICATE。
     */
    private Optional<String> findStoredJson(String idempotencyKey, Object requestBody) {
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
        return Optional.of(record.getResponseJson());
    }

    private Object deserializeReplay(String responseJson) {
        try {
            return objectMapper.readValue(responseJson, Object.class);
        } catch (Exception e) {
            throw new IllegalStateException("cannot parse stored idempotent response", e);
        }
    }

    /**
     * 幂等写接口模板：同键同请求直接回放已存响应（Jackson 反序列化结果，调用方按 Map 使用）；
     * 否则在同一业务事务中执行 action 并保存幂等结果。
     */
    @SuppressWarnings("unchecked")
    @Transactional
    public <T> T execute(String idempotencyKey, Object requestBody, Supplier<T> action) {
        lockKey(idempotencyKey);
        var replay = findReplay(idempotencyKey, requestBody);
        if (replay.isPresent()) {
            return (T) replay.get();
        }
        T data = action.get();
        saveRecord(idempotencyKey, requestBody, data);
        return data;
    }

    /**
     * 类型化幂等写接口模板：同键同请求时把已存响应 JSON 反序列化为 responseType 回放
     * （响应 DTO 化后避免回放得到 Map 与声明类型不符）；其余语义与三参版本一致。
     */
    @Transactional
    public <T> T execute(String idempotencyKey, Object requestBody, Supplier<T> action,
                         Class<T> responseType) {
        lockKey(idempotencyKey);
        var replay = findStoredJson(idempotencyKey, requestBody);
        if (replay.isPresent()) {
            try {
                return objectMapper.readValue(replay.get(), responseType);
            } catch (Exception e) {
                throw new IllegalStateException("cannot parse stored idempotent response", e);
            }
        }
        T data = action.get();
        saveRecord(idempotencyKey, requestBody, data);
        return data;
    }

    /**
     * 直接写入入口也遵守同键串行化，重复的有效 key 不覆盖首次响应。
     */
    @Transactional
    public void store(String idempotencyKey, Object requestBody, Object responseData) {
        lockKey(idempotencyKey);
        saveRecord(idempotencyKey, requestBody, responseData);
    }

    private void lockKey(String idempotencyKey) {
        requireKey(idempotencyKey);
        // 事务级锁随业务提交或回滚释放；哈希碰撞只会额外串行化，不会混淆记录。
        entityManager.createNativeQuery("SELECT pg_advisory_xact_lock(hashtextextended(CAST(:key AS text), 0))")
                .setParameter("key", idempotencyKey).getSingleResult();
    }

    private void saveRecord(String idempotencyKey, Object requestBody, Object responseData) {
        Optional<IdempotencyRecord> existing = repository.findByIdempotencyKey(idempotencyKey);
        if (existing.isPresent() && !existing.get().getExpiresAt().isBefore(OffsetDateTime.now())) {
            throw BizException.duplicate("Idempotency-Key 已使用");
        }
        IdempotencyRecord record = existing.orElseGet(IdempotencyRecord::new);
        if (existing.isEmpty()) {
            record.setId(UUID.randomUUID().toString());
            record.setIdempotencyKey(idempotencyKey);
        }
        record.setRequestHash(HashUtil.sha256OfJson(requestBody));
        record.setCreatedAt(OffsetDateTime.now());
        record.setExpiresAt(OffsetDateTime.now().plus(properties.getIdempotencyTtl()));
        try {
            record.setResponseJson(objectMapper.writeValueAsString(responseData));
        } catch (Exception e) {
            throw new IllegalStateException("cannot serialize idempotent response", e);
        }
        repository.saveAndFlush(record);
    }
}
