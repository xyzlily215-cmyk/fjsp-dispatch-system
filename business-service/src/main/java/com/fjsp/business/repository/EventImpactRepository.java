package com.fjsp.business.repository;

import java.util.Collection;
import java.util.List;

import com.fjsp.business.entity.EventImpact;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface EventImpactRepository extends JpaRepository<EventImpact, String> {
    List<EventImpact> findByEventId(String eventId);

    List<EventImpact> findByOperationId(String operationId);

    /** 看板最近事件的影响工序数：一次 group by 取回，避免逐事件 count 的 N+1（F-01）。 */
    @Query("select i.eventId, count(i) from EventImpact i where i.eventId in :eventIds group by i.eventId")
    List<Object[]> countGroupedByEventIdIn(@Param("eventIds") Collection<String> eventIds);
}
