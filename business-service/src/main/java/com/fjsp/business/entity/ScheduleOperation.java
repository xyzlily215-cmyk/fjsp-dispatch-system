package com.fjsp.business.entity;

import java.time.OffsetDateTime;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import jakarta.persistence.UniqueConstraint;

@Entity
@Table(name = "schedule_operation", uniqueConstraints = @UniqueConstraint(columnNames = {"planVersionId", "operationId"}))
public class ScheduleOperation {

    @Id
    private String id;

    @Column(nullable = false)
    private String planVersionId;

    @Column(nullable = false)
    private String operationId;

    @Column(nullable = false)
    private String machineId;

    private OffsetDateTime setupStartAt;

    private OffsetDateTime processStartAt;

    @Column(nullable = false)
    private OffsetDateTime startAt;

    @Column(nullable = false)
    private OffsetDateTime endAt;

    @Column(nullable = false)
    private Integer changeoverMinutes = 0;

    @Column(nullable = false)
    private Boolean frozen = false;

    @Column(nullable = false)
    private Boolean affected = false;

    private String reasonCode;

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public String getPlanVersionId() {
        return planVersionId;
    }

    public void setPlanVersionId(String planVersionId) {
        this.planVersionId = planVersionId;
    }

    public String getOperationId() {
        return operationId;
    }

    public void setOperationId(String operationId) {
        this.operationId = operationId;
    }

    public String getMachineId() {
        return machineId;
    }

    public void setMachineId(String machineId) {
        this.machineId = machineId;
    }

    public OffsetDateTime getSetupStartAt() {
        return setupStartAt;
    }

    public void setSetupStartAt(OffsetDateTime setupStartAt) {
        this.setupStartAt = setupStartAt;
    }

    public OffsetDateTime getProcessStartAt() {
        return processStartAt;
    }

    public void setProcessStartAt(OffsetDateTime processStartAt) {
        this.processStartAt = processStartAt;
    }

    public OffsetDateTime getStartAt() {
        return startAt;
    }

    public void setStartAt(OffsetDateTime startAt) {
        this.startAt = startAt;
    }

    public OffsetDateTime getEndAt() {
        return endAt;
    }

    public void setEndAt(OffsetDateTime endAt) {
        this.endAt = endAt;
    }

    public Integer getChangeoverMinutes() {
        return changeoverMinutes;
    }

    public void setChangeoverMinutes(Integer changeoverMinutes) {
        this.changeoverMinutes = changeoverMinutes;
    }

    public Boolean getFrozen() {
        return frozen;
    }

    public void setFrozen(Boolean frozen) {
        this.frozen = frozen;
    }

    public Boolean getAffected() {
        return affected;
    }

    public void setAffected(Boolean affected) {
        this.affected = affected;
    }

    public String getReasonCode() {
        return reasonCode;
    }

    public void setReasonCode(String reasonCode) {
        this.reasonCode = reasonCode;
    }
}
