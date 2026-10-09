package com.fjsp.business.repository;

import java.util.List;

import com.fjsp.business.entity.OperationCandidate;
import org.springframework.data.jpa.repository.JpaRepository;

public interface OperationCandidateRepository extends JpaRepository<OperationCandidate, String> {
    List<OperationCandidate> findByOperationId(String operationId);
}
