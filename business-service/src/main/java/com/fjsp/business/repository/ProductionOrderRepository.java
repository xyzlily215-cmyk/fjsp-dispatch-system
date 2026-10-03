package com.fjsp.business.repository;

import java.util.List;
import java.util.Optional;

import com.fjsp.business.entity.ProductionOrder;
import org.springframework.data.jpa.repository.JpaRepository;

public interface ProductionOrderRepository extends JpaRepository<ProductionOrder, String> {
    boolean existsByOrderCode(String orderCode);

    Optional<ProductionOrder> findByOrderCode(String orderCode);

    List<ProductionOrder> findByStatusIn(List<String> statuses);
}
