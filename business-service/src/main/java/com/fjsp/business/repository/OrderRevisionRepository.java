package com.fjsp.business.repository;

import java.util.List;
import java.util.Optional;

import com.fjsp.business.entity.OrderRevision;
import org.springframework.data.jpa.repository.JpaRepository;

public interface OrderRevisionRepository extends JpaRepository<OrderRevision, String> {
    List<OrderRevision> findByOrderIdOrderByRevisionNoDesc(String orderId);

    Optional<OrderRevision> findTopByOrderIdOrderByRevisionNoDesc(String orderId);
}
