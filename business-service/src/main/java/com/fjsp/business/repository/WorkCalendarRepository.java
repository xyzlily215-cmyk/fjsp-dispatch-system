package com.fjsp.business.repository;

import java.util.List;
import java.util.Optional;

import com.fjsp.business.entity.WorkCalendar;
import jakarta.persistence.LockModeType;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface WorkCalendarRepository extends JpaRepository<WorkCalendar, String> {

    /** SELECT ... FOR UPDATE：日历区间写入前锁定父日历行，串行化并发区间插入。 */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select c from WorkCalendar c where c.id = :id")
    Optional<WorkCalendar> findByIdForUpdate(@Param("id") String id);

    /** 同一日历编码的全部版本（新→旧）：版本历史列表。 */
    List<WorkCalendar> findByCalendarCodeOrderByCalendarVersionDesc(String calendarCode);
}
