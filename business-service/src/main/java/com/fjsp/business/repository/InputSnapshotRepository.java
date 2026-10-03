package com.fjsp.business.repository;

import java.util.Optional;

import com.fjsp.business.entity.InputSnapshot;
import org.springframework.data.jpa.repository.JpaRepository;

public interface InputSnapshotRepository extends JpaRepository<InputSnapshot, String> {
    Optional<InputSnapshot> findByTaskId(String taskId);
}
