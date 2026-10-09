package com.fjsp.business.repository;

import java.util.List;

import com.fjsp.business.entity.CalendarInterval;
import org.springframework.data.jpa.repository.JpaRepository;

public interface CalendarIntervalRepository extends JpaRepository<CalendarInterval, String> {
    List<CalendarInterval> findByCalendarIdOrderByStartAt(String calendarId);
}
