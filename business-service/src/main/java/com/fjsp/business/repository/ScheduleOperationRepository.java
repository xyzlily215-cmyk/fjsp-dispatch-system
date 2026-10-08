package com.fjsp.business.repository;

import java.util.Collection;
import java.util.List;
import java.util.Optional;

import com.fjsp.business.entity.ScheduleOperation;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface ScheduleOperationRepository extends JpaRepository<ScheduleOperation, String> {
    List<ScheduleOperation> findByPlanVersionId(String planVersionId);

    Page<ScheduleOperation> findByPlanVersionId(String planVersionId, Pageable pageable);

    long countByPlanVersionId(String planVersionId);

    List<ScheduleOperation> findByPlanVersionIdAndMachineId(String planVersionId, String machineId);

    Optional<ScheduleOperation> findByPlanVersionIdAndOperationId(String planVersionId, String operationId);

    /** 设备粒度查询（任意计划版本）：日历维修区间校验时回溯该设备上的执行记录。 */
    List<ScheduleOperation> findByMachineIdIn(Collection<String> machineIds);

    /** 订单是否已被纳入排程结果（其任一工序出现在任何计划版本中）——F-04 修订控制的"已排程"判定。 */
    @Query("select case when count(so) > 0 then true else false end from ScheduleOperation so, OrderOperation oo "
            + "where so.operationId = oo.id and oo.orderId = :orderId")
    boolean existsScheduledByOrderId(@Param("orderId") String orderId);

    /** 全部已排程订单 id 集合：订单列表页一次性标记，避免逐单 exists 查询。 */
    @Query("select distinct oo.orderId from ScheduleOperation so, OrderOperation oo where so.operationId = oo.id")
    List<String> findScheduledOrderIds();
}
