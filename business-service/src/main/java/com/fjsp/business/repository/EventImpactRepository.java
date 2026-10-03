package com.fjsp.business.repository;

import java.util.List;

import com.fjsp.business.entity.EventImpact;
import org.springframework.data.jpa.repository.JpaRepository;

public interface EventImpactRepository extends JpaRepository<EventImpact, String> {
    List<EventImpact> findByEventId(String eventId);

    List<EventImpact> findByOperationId(String operationId);
}
