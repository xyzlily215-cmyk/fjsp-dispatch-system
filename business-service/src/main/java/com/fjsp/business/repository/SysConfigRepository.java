package com.fjsp.business.repository;

import java.util.Optional;

import com.fjsp.business.entity.SysConfig;
import org.springframework.data.jpa.repository.JpaRepository;

public interface SysConfigRepository extends JpaRepository<SysConfig, String> {
    Optional<SysConfig> findByConfigKey(String configKey);

    boolean existsByConfigKey(String configKey);
}
