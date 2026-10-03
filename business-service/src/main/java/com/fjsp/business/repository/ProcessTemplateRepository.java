package com.fjsp.business.repository;

import java.util.Optional;

import com.fjsp.business.entity.ProcessTemplate;
import org.springframework.data.jpa.repository.JpaRepository;

public interface ProcessTemplateRepository extends JpaRepository<ProcessTemplate, String> {
    Optional<ProcessTemplate> findFirstByProductFamilyAndStatusOrderByTemplateVersionDesc(String productFamily, String status);
}
