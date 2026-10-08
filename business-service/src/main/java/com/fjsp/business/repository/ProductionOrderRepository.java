package com.fjsp.business.repository;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Optional;

import com.fjsp.business.entity.ProductionOrder;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

public interface ProductionOrderRepository extends JpaRepository<ProductionOrder, String> {
    boolean existsByOrderCode(String orderCode);

    Optional<ProductionOrder> findByOrderCode(String orderCode);

    List<ProductionOrder> findByStatusIn(List<String> statuses);

    /** RELATIVE 模式下任务默认仿真起点 = 种子订单最小到达时间（即 seed 基准）。 */
    @Query("select min(o.arrivalAt) from ProductionOrder o")
    OffsetDateTime findMinArrivalAt();

    /** 看板订单卡片：数据库侧按状态聚合，避免捞全表在内存计数。 */
    @Query("select o.status, count(o) from ProductionOrder o group by o.status")
    List<Object[]> countGroupedByStatus();
}
