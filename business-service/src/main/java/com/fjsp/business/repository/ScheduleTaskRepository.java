package com.fjsp.business.repository;

import java.time.OffsetDateTime;
import java.util.Collection;
import java.util.List;
import java.util.Optional;

import com.fjsp.business.entity.ScheduleTask;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface ScheduleTaskRepository extends JpaRepository<ScheduleTask, String> {
    Optional<ScheduleTask> findByTaskCode(String taskCode);

    Optional<ScheduleTask> findByFingerprint(String fingerprint);

    Optional<ScheduleTask> findByFingerprintAndStatusIn(String fingerprint, Collection<String> statuses);

    List<ScheduleTask> findByStatus(String status);

    long countByStatus(String status);

    long countByStatusIn(Collection<String> statuses);

    List<ScheduleTask> findByStatusAndTimeoutAtBefore(String status, OffsetDateTime now);

    List<ScheduleTask> findByStatusAndNextRetryAtLessThanEqual(String status, OffsetDateTime now);

    List<ScheduleTask> findByEventId(String eventId);

    List<ScheduleTask> findAllByOrderByCreatedAtDesc(Pageable pageable);

    /** 看板异常聚合：最近的不可行任务（F-01）。 */
    List<ScheduleTask> findTop20ByStatusOrderByCreatedAtDesc(String status);

    Page<ScheduleTask> findAllBy(Pageable pageable);

    /**
     * 原子状态机迁移 PENDING/RETRY_WAIT → RUNNING：影响行数 0 表示任务已被取消或已被其他
     * 派发线程抢占，调用方必须放弃本次执行，防止取消后复活与重复派发。
     */
    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query("update ScheduleTask t set t.status = 'RUNNING', t.progress = 10,"
            + " t.startedAt = :startedAt, t.nextRetryAt = null, t.timeoutAt = :timeoutAt"
            + " where t.id = :id and t.status in ('PENDING', 'RETRY_WAIT')")
    int markRunningIfDispatchable(@Param("id") String id,
                                  @Param("startedAt") OffsetDateTime startedAt,
                                  @Param("timeoutAt") OffsetDateTime timeoutAt);
}
