package com.fjsp.business.entity;

import java.time.OffsetDateTime;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

@Entity
@Table(name = "event")
public class Event {

    public static final String TYPE_NEW_ORDER = "NEW_ORDER";
    public static final String TYPE_BREAKDOWN = "BREAKDOWN";

    /** 生命周期状态机（系统设计说明书 §5.2）：CREATED -> CONFIRMED -> USED_FOR_SOLVE -> CLOSED。 */
    public static final String STATUS_CREATED = "CREATED";
    public static final String STATUS_CONFIRMED = "CONFIRMED";
    public static final String STATUS_USED_FOR_SOLVE = "USED_FOR_SOLVE";
    public static final String STATUS_CLOSED = "CLOSED";

    @Id
    private String id;

    @Column(nullable = false, unique = true)
    private String eventCode;

    @Column(nullable = false)
    private String eventType;

    private String subType;

    private String machineId;

    private String orderId;

    @Column(nullable = false)
    private OffsetDateTime occurredAt;

    @Column(nullable = false)
    private OffsetDateTime recordedAt = OffsetDateTime.now();

    private Integer repairDurationMinutes;

    private OffsetDateTime repairEndAt;

    private String source;

    @Column(length = 2000)
    private String note;

    @Column(nullable = false)
    private String status = STATUS_CREATED;

    private String revisionOf;

    @Column(length = 1000)
    private String revisionReason;

    private OffsetDateTime closedAt;

    @Column(unique = true)
    private String fingerprint;

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public String getEventCode() {
        return eventCode;
    }

    public void setEventCode(String eventCode) {
        this.eventCode = eventCode;
    }

    public String getEventType() {
        return eventType;
    }

    public void setEventType(String eventType) {
        this.eventType = eventType;
    }

    public String getSubType() {
        return subType;
    }

    public void setSubType(String subType) {
        this.subType = subType;
    }

    public String getMachineId() {
        return machineId;
    }

    public void setMachineId(String machineId) {
        this.machineId = machineId;
    }

    public String getOrderId() {
        return orderId;
    }

    public void setOrderId(String orderId) {
        this.orderId = orderId;
    }

    public OffsetDateTime getOccurredAt() {
        return occurredAt;
    }

    public void setOccurredAt(OffsetDateTime occurredAt) {
        this.occurredAt = occurredAt;
    }

    public OffsetDateTime getRecordedAt() {
        return recordedAt;
    }

    public void setRecordedAt(OffsetDateTime recordedAt) {
        this.recordedAt = recordedAt;
    }

    public Integer getRepairDurationMinutes() {
        return repairDurationMinutes;
    }

    public void setRepairDurationMinutes(Integer repairDurationMinutes) {
        this.repairDurationMinutes = repairDurationMinutes;
    }

    public OffsetDateTime getRepairEndAt() {
        return repairEndAt;
    }

    public void setRepairEndAt(OffsetDateTime repairEndAt) {
        this.repairEndAt = repairEndAt;
    }

    public String getSource() {
        return source;
    }

    public void setSource(String source) {
        this.source = source;
    }

    public String getNote() {
        return note;
    }

    public void setNote(String note) {
        this.note = note;
    }

    public String getStatus() {
        return status;
    }

    public void setStatus(String status) {
        this.status = status;
    }

    public String getRevisionOf() {
        return revisionOf;
    }

    public void setRevisionOf(String revisionOf) {
        this.revisionOf = revisionOf;
    }

    public String getRevisionReason() {
        return revisionReason;
    }

    public void setRevisionReason(String revisionReason) {
        this.revisionReason = revisionReason;
    }

    public OffsetDateTime getClosedAt() {
        return closedAt;
    }

    public void setClosedAt(OffsetDateTime closedAt) {
        this.closedAt = closedAt;
    }

    public String getFingerprint() {
        return fingerprint;
    }

    public void setFingerprint(String fingerprint) {
        this.fingerprint = fingerprint;
    }
}
