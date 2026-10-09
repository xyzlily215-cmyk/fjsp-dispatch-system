package com.fjsp.business.repository;

import java.time.OffsetDateTime;
import java.util.Collection;
import java.util.List;
import java.util.Optional;

import com.fjsp.business.entity.ExecutionRecord;
import org.springframework.data.jpa.repository.JpaRepository;

public interface ExecutionRecordRepository extends JpaRepository<ExecutionRecord, String> {
    List<ExecutionRecord> findByOperationIdOrderByCreatedAt(String operationId);

    Optional<ExecutionRecord> findFirstByOperationIdAndStatusAndActualEndAtIsNull(String operationId, String status);

    boolean existsByOperationIdAndStatus(String operationId, String status);

    /** 批量拉回一组工序的执行记录，调用方在内存中按工序分组，替代逐工序查询的 N+1。 */
    List<ExecutionRecord> findByOperationIdIn(Collection<String> operationIds);

    List<ExecutionRecord> findByStatusAndActualEndAtIsNull(String status);

    List<ExecutionRecord> findTop20ByReasonCodeOrderByCreatedAtDesc(String reasonCode);

    /** 看板时间窗口：按记录时间 [from, to) 过滤执行偏差（F-01）。 */
    List<ExecutionRecord> findTop20ByReasonCodeAndCreatedAtGreaterThanEqualAndCreatedAtLessThanOrderByCreatedAtDesc(
            String reasonCode, OffsetDateTime from, OffsetDateTime to);
}
