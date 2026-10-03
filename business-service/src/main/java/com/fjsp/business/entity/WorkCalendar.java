package com.fjsp.business.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import jakarta.persistence.UniqueConstraint;

@Entity
@Table(name = "work_calendar", uniqueConstraints = @UniqueConstraint(columnNames = {"calendarCode", "calendarVersion"}))
public class WorkCalendar {

    @Id
    private String id;

    @Column(nullable = false)
    private String calendarCode;

    @Column(nullable = false)
    private Integer calendarVersion = 1;

    @Column(nullable = false)
    private String status = "ACTIVE";

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public String getCalendarCode() {
        return calendarCode;
    }

    public void setCalendarCode(String calendarCode) {
        this.calendarCode = calendarCode;
    }

    public Integer getCalendarVersion() {
        return calendarVersion;
    }

    public void setCalendarVersion(Integer calendarVersion) {
        this.calendarVersion = calendarVersion;
    }

    public String getStatus() {
        return status;
    }

    public void setStatus(String status) {
        this.status = status;
    }
}
