package com.fjsp.business.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import jakarta.persistence.UniqueConstraint;

@Entity
@Table(name = "operation_candidate", uniqueConstraints = @UniqueConstraint(columnNames = {"operationId", "machineId"}))
public class OperationCandidate {

    @Id
    private String id;

    @Column(nullable = false)
    private String operationId;

    @Column(nullable = false)
    private String machineId;

    @Column(nullable = false)
    private Integer processMinutes;

    @Column(nullable = false)
    private Integer setupMinutes;

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

    public String getMachineId() {
        return machineId;
    }

    public void setMachineId(String machineId) {
        this.machineId = machineId;
    }

    public Integer getProcessMinutes() {
        return processMinutes;
    }

    public void setProcessMinutes(Integer processMinutes) {
        this.processMinutes = processMinutes;
    }

    public Integer getSetupMinutes() {
        return setupMinutes;
    }

    public void setSetupMinutes(Integer setupMinutes) {
        this.setupMinutes = setupMinutes;
    }
}
