package com.fjsp.business.repository;

import java.util.List;
import java.util.Optional;

import com.fjsp.business.entity.ScheduleTask;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

public interface ScheduleTaskRepository extends JpaRepository<ScheduleTask, String> {
    Optional<ScheduleTask> findByTaskCode(String taskCode);

    Optional<ScheduleTask> findByFingerprint(String fingerprint);

    List<ScheduleTask> findByEventId(String eventId);

    List<ScheduleTask> findAllByOrderByCreatedAtDesc(Pageable pageable);

    @Query("select max(t.taskCode) from ScheduleTask t")
    String findMaxTaskCode();
}
