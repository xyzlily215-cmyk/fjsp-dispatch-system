package com.fjsp.business.repository;

import java.util.List;
import java.util.Optional;

import com.fjsp.business.entity.ExecutionRecord;
import org.springframework.data.jpa.repository.JpaRepository;

public interface ExecutionRecordRepository extends JpaRepository<ExecutionRecord, String> {
    List<ExecutionRecord> findByOperationIdOrderByCreatedAt(String operationId);

    Optional<ExecutionRecord> findFirstByOperationIdAndStatusAndActualEndAtIsNull(String operationId, String status);

    boolean existsByOperationIdAndStatus(String operationId, String status);
}
