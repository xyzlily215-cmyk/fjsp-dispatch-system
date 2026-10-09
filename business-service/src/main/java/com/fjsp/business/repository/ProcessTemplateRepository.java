package com.fjsp.business.repository;

import java.util.Optional;

import com.fjsp.business.entity.ProcessTemplate;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface ProcessTemplateRepository extends JpaRepository<ProcessTemplate, String> {
    Optional<ProcessTemplate> findFirstByProductFamilyAndStatusOrderByTemplateVersionDesc(String productFamily, String status);

    boolean existsByTemplateCodeAndTemplateVersion(String templateCode, Integer templateVersion);

    @Query("select max(t.templateVersion) from ProcessTemplate t where t.templateCode = :templateCode")
    Integer findMaxTemplateVersionByTemplateCode(@Param("templateCode") String templateCode);
}
