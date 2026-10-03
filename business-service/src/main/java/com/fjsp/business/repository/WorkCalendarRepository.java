package com.fjsp.business.repository;

import com.fjsp.business.entity.WorkCalendar;
import org.springframework.data.jpa.repository.JpaRepository;

public interface WorkCalendarRepository extends JpaRepository<WorkCalendar, String> {
}
