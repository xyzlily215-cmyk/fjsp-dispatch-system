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
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

@Service
public class IdempotencyService {

    private static final Logger log = LoggerFactory.getLogger(IdempotencyService.class);

    private final IdempotencyRecordRepository repository;
    private final FjspProperties properties;
    private final ObjectMapper objectMapper;

    // 自注入代理：afterCommit 回调中 persist 需要新开事务（同类自调用 @Transactional 不生效）
    @org.springframework.beans.factory.annotation.Autowired
    @org.springframework.context.annotation.Lazy
    private IdempotencyService self;

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
     * 否则执行 action 并在业务事务提交后记录幂等结果（见 store 的 afterCommit 语义）。
     */
    @SuppressWarnings("unchecked")
    public <T> T execute(String idempotencyKey, Object requestBody, Supplier<T> action) {
        var replay = findReplay(idempotencyKey, requestBody);
        if (replay.isPresent()) {
            return (T) replay.get();
        }
        T data = action.get();
        store(idempotencyKey, requestBody, data);
        return data;
    }

    /**
     * 类型化幂等写接口模板：同键同请求时把已存响应 JSON 反序列化为 responseType 回放
     * （响应 DTO 化后避免回放得到 Map 与声明类型不符）；其余语义与三参版本一致。
     */
    public <T> T execute(String idempotencyKey, Object requestBody, Supplier<T> action,
                         Class<T> responseType) {
        var replay = findStoredJson(idempotencyKey, requestBody);
        if (replay.isPresent()) {
            try {
                return objectMapper.readValue(replay.get(), responseType);
            } catch (Exception e) {
                throw new IllegalStateException("cannot parse stored idempotent response", e);
            }
        }
        T data = action.get();
        store(idempotencyKey, requestBody, data);
        return data;
    }

    /**
     * 记录幂等结果。序列化在当前线程完成；落库推迟到外层业务事务 afterCommit——若业务
     * 回滚则不留指向不存在数据的"幽灵"幂等记录（原 REQUIRES_NEW 先于业务提交的问题）。
     * 落库走独立新事务：并发同键的唯一冲突只放弃本次记录，不回滚已提交的业务。
     * 无活动事务同步时（如单元测试直接调用）立即落库。
     */
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
        if (TransactionSynchronizationManager.isSynchronizationActive()) {
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override
                public void afterCommit() {
                    try {
                        self.persist(record);
                    } catch (Exception e) {
                        // 业务已提交，幂等记录失败只能记日志，不能向外抛
                        log.error("idempotency record persist failed after commit, key={}",
                                record.getIdempotencyKey(), e);
                    }
                }
            });
        } else {
            persist(record);
        }
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void persist(IdempotencyRecord record) {
        try {
            repository.saveAndFlush(record);
        } catch (DataIntegrityViolationException e) {
            // concurrent insert with the same key: first writer wins, nothing to store
        }
    }
}
