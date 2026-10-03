package com.fjsp.business.repository;

import java.time.OffsetDateTime;
import java.util.Collection;
import java.util.List;
import java.util.Optional;

import com.fjsp.business.entity.ScheduleTask;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

public interface ScheduleTaskRepository extends JpaRepository<ScheduleTask, String> {
    Optional<ScheduleTask> findByTaskCode(String taskCode);

    Optional<ScheduleTask> findByFingerprint(String fingerprint);

    Optional<ScheduleTask> findByFingerprintAndStatusIn(String fingerprint, Collection<String> statuses);

    List<ScheduleTask> findByStatus(String status);

    List<ScheduleTask> findByStatusAndTimeoutAtBefore(String status, OffsetDateTime now);

    List<ScheduleTask> findByStatusAndNextRetryAtLessThanEqual(String status, OffsetDateTime now);

    List<ScheduleTask> findByEventId(String eventId);

    List<ScheduleTask> findAllByOrderByCreatedAtDesc(Pageable pageable);

    @Query("select max(t.taskCode) from ScheduleTask t")
    String findMaxTaskCode();
}
