package com.fjsp.business.repository;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Optional;

import com.fjsp.business.entity.Event;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.domain.Pageable;

public interface EventRepository extends JpaRepository<Event, String> {
    Optional<Event> findByEventCode(String eventCode);

    List<Event> findByMachineIdAndEventType(String machineId, String eventType);

    List<Event> findAllByOrderByOccurredAtDesc(Pageable pageable);

    boolean existsByRecordedAtAfter(OffsetDateTime recordedAt);

    @org.springframework.data.jpa.repository.Query("select max(e.eventCode) from Event e")
    String findMaxEventCode();
}
