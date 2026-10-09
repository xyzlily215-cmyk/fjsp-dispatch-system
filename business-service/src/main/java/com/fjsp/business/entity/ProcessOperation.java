package com.fjsp.business.entity;

import java.util.List;
import java.util.Map;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import jakarta.persistence.UniqueConstraint;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

@Entity
@Table(name = "process_operation", uniqueConstraints = @UniqueConstraint(columnNames = {"templateId", "sequenceNo"}))
public class ProcessOperation {

    @Id
    private String id;

    @Column(nullable = false)
    private String templateId;

    @Column(nullable = false)
    private Integer sequenceNo;

    @Column(nullable = false)
    private String operationCode;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(columnDefinition = "jsonb")
    private List<Map<String, Object>> defaultCandidates;

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public String getTemplateId() {
        return templateId;
    }

    public void setTemplateId(String templateId) {
        this.templateId = templateId;
    }

    public Integer getSequenceNo() {
        return sequenceNo;
    }

    public void setSequenceNo(Integer sequenceNo) {
        this.sequenceNo = sequenceNo;
    }

    public String getOperationCode() {
        return operationCode;
    }

    public void setOperationCode(String operationCode) {
        this.operationCode = operationCode;
    }

    public List<Map<String, Object>> getDefaultCandidates() {
        return defaultCandidates;
    }

    public void setDefaultCandidates(List<Map<String, Object>> defaultCandidates) {
        this.defaultCandidates = defaultCandidates;
    }
}
