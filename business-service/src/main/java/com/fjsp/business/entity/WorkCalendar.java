package com.fjsp.business.entity;

import java.time.OffsetDateTime;

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

    @Column(nullable = false)
    private OffsetDateTime createdAt = OffsetDateTime.now();

    /** 生成本版本时的变更说明（如"新增不可用区间 REPAIR ..."），首版本为 null。 */
    @Column(length = 500)
    private String changeNote;

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

    public OffsetDateTime getCreatedAt() {
        return createdAt;
    }

    public void setCreatedAt(OffsetDateTime createdAt) {
        this.createdAt = createdAt;
    }

    public String getChangeNote() {
        return changeNote;
    }

    public void setChangeNote(String changeNote) {
        this.changeNote = changeNote;
    }
}
