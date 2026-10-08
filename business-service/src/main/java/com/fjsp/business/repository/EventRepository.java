package com.fjsp.business.repository;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Optional;

import com.fjsp.business.entity.Event;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.JpaSpecificationExecutor;

public interface EventRepository extends JpaRepository<Event, String>, JpaSpecificationExecutor<Event> {
    Optional<Event> findByEventCode(String eventCode);

    boolean existsByFingerprint(String fingerprint);

    List<Event> findByRevisionOf(String revisionOf);

    List<Event> findByMachineIdAndEventType(String machineId, String eventType);

    List<Event> findByEventType(String eventType);

    List<Event> findAllByOrderByOccurredAtDesc(Pageable pageable);

    List<Event> findByEventTypeOrderByOccurredAtDesc(String eventType, Pageable pageable);

    /** 看板时间窗口：按发生时间 [from, to) 过滤（F-01）。 */
    List<Event> findByOccurredAtGreaterThanEqualAndOccurredAtLessThanOrderByOccurredAtDesc(
            OffsetDateTime from, OffsetDateTime to, Pageable pageable);

    List<Event> findByEventTypeAndOccurredAtGreaterThanEqualAndOccurredAtLessThanOrderByOccurredAtDesc(
            String eventType, OffsetDateTime from, OffsetDateTime to, Pageable pageable);

    boolean existsByRecordedAtAfter(OffsetDateTime recordedAt);
}
