package com.fjsp.business.repository;

import java.util.List;

import com.fjsp.business.entity.OrderOperation;
import org.springframework.data.jpa.repository.JpaRepository;

public interface OrderOperationRepository extends JpaRepository<OrderOperation, String> {
    List<OrderOperation> findByOrderIdOrderBySequenceNo(String orderId);

    List<OrderOperation> findByOrderIdIn(List<String> orderIds);
}
