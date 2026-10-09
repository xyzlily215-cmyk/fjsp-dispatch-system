package com.fjsp.business.repository;

import java.util.List;
import java.util.Optional;

import com.fjsp.business.entity.PlanVersion;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;

public interface PlanVersionRepository extends JpaRepository<PlanVersion, String> {
    Optional<PlanVersion> findByVersionCode(String versionCode);

    List<PlanVersion> findByStatusIn(List<String> statuses);

    List<PlanVersion> findAllByOrderByCreatedAtDesc();

    Page<PlanVersion> findAllBy(Pageable pageable);
}
