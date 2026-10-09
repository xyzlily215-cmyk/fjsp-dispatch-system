package com.fjsp.business.entity;

import java.time.OffsetDateTime;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import jakarta.persistence.Version;

@Entity
@Table(name = "execution_record")
public class ExecutionRecord {

    @Id
    private String id;

    @Column(nullable = false)
    private String operationId;

    @Column(nullable = false)
    private String planVersionId;

    @Column(nullable = false)
    private String status;

    private OffsetDateTime actualStartAt;

    private OffsetDateTime actualEndAt;

    private OffsetDateTime occurredAt;

    private String reasonCode;

    private Integer deviationMinutes;

    @Column(length = 1000)
    private String remark;

    @Column(nullable = false)
    private OffsetDateTime createdAt = OffsetDateTime.now();

    @Version
    private Long version;

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public String getOperationId() {
        return operationId;
    }

    public void setOperationId(String operationId) {
        this.operationId = operationId;
    }

    public String getPlanVersionId() {
        return planVersionId;
    }

    public void setPlanVersionId(String planVersionId) {
        this.planVersionId = planVersionId;
    }

    public String getStatus() {
        return status;
    }

    public void setStatus(String status) {
        this.status = status;
    }

    public OffsetDateTime getActualStartAt() {
        return actualStartAt;
    }

    public void setActualStartAt(OffsetDateTime actualStartAt) {
        this.actualStartAt = actualStartAt;
    }

    public OffsetDateTime getActualEndAt() {
        return actualEndAt;
    }

    public void setActualEndAt(OffsetDateTime actualEndAt) {
        this.actualEndAt = actualEndAt;
    }

    public OffsetDateTime getOccurredAt() {
        return occurredAt;
    }

    public void setOccurredAt(OffsetDateTime occurredAt) {
        this.occurredAt = occurredAt;
    }

    public String getReasonCode() {
        return reasonCode;
    }

    public void setReasonCode(String reasonCode) {
        this.reasonCode = reasonCode;
    }

    public Integer getDeviationMinutes() {
        return deviationMinutes;
    }

    public void setDeviationMinutes(Integer deviationMinutes) {
        this.deviationMinutes = deviationMinutes;
    }

    public String getRemark() {
        return remark;
    }

    public void setRemark(String remark) {
        this.remark = remark;
    }

    public OffsetDateTime getCreatedAt() {
        return createdAt;
    }

    public void setCreatedAt(OffsetDateTime createdAt) {
        this.createdAt = createdAt;
    }

    public Long getVersion() {
        return version;
    }

    public void setVersion(Long version) {
        this.version = version;
    }
}
