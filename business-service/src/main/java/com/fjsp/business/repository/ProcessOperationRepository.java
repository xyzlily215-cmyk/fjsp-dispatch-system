package com.fjsp.business.repository;

import java.util.List;

import com.fjsp.business.entity.ProcessOperation;
import org.springframework.data.jpa.repository.JpaRepository;

public interface ProcessOperationRepository extends JpaRepository<ProcessOperation, String> {
    List<ProcessOperation> findByTemplateIdOrderBySequenceNo(String templateId);
}
