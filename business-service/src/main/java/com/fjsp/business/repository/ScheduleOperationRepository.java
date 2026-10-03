package com.fjsp.business.repository;

import java.util.List;
import java.util.Optional;

import com.fjsp.business.entity.ScheduleOperation;
import org.springframework.data.jpa.repository.JpaRepository;

public interface ScheduleOperationRepository extends JpaRepository<ScheduleOperation, String> {
    List<ScheduleOperation> findByPlanVersionId(String planVersionId);

    List<ScheduleOperation> findByPlanVersionIdAndMachineId(String planVersionId, String machineId);

    Optional<ScheduleOperation> findByPlanVersionIdAndOperationId(String planVersionId, String operationId);
}
