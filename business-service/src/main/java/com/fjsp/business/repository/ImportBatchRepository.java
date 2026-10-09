package com.fjsp.business.repository;

import java.util.Optional;

import com.fjsp.business.entity.ImportBatch;
import org.springframework.data.jpa.repository.JpaRepository;

public interface ImportBatchRepository extends JpaRepository<ImportBatch, String> {
    Optional<ImportBatch> findByBatchCode(String batchCode);
}
