package com.fjsp.business.repository;

import java.util.List;
import java.util.Optional;

import com.fjsp.business.entity.PlanVersion;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

public interface PlanVersionRepository extends JpaRepository<PlanVersion, String> {
    Optional<PlanVersion> findByVersionCode(String versionCode);

    List<PlanVersion> findByStatusIn(List<String> statuses);

    List<PlanVersion> findAllByOrderByCreatedAtDesc();

    @Query("select max(p.versionCode) from PlanVersion p")
    String findMaxVersionCode();
}
