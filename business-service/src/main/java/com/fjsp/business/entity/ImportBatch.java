package com.fjsp.business.entity;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

/** F-05 导入批次：PENDING（预览建批）/ COMMITTED（整批入库）/ FAILED（提交复检失败）。 */
@Entity
@Table(name = "import_batch")
public class ImportBatch {

    public static final String STATUS_PENDING = "PENDING";
    public static final String STATUS_COMMITTED = "COMMITTED";
    public static final String STATUS_FAILED = "FAILED";

    @Id
    private String id;

    @Column(nullable = false, unique = true)
    private String batchCode;

    @Column(nullable = false)
    private String importType;

    @Column(nullable = false)
    private String status;

    private String fileName;

    @Column(nullable = false)
    private String fileSha256;

    @Column(nullable = false)
    private int totalRows;

    @Column(nullable = false)
    private int successRows;

    @Column(nullable = false)
    private int errorRows;

    /** 逐行错误明细：[{row, code, field, value, suggestion}] */
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(columnDefinition = "jsonb")
    private List<Map<String, Object>> errors;

    /** 预览解析出的行数据（列名 -> 原值字符串），提交时据此复检并入库。 */
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(columnDefinition = "jsonb")
    private List<Map<String, String>> rowsJson;

    private String operator;

    @Column(nullable = false)
    private OffsetDateTime createdAt = OffsetDateTime.now();

    private OffsetDateTime committedAt;

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public String getBatchCode() {
        return batchCode;
    }

    public void setBatchCode(String batchCode) {
        this.batchCode = batchCode;
    }

    public String getImportType() {
        return importType;
    }

    public void setImportType(String importType) {
        this.importType = importType;
    }

    public String getStatus() {
        return status;
    }

    public void setStatus(String status) {
        this.status = status;
    }

    public String getFileName() {
        return fileName;
    }

    public void setFileName(String fileName) {
        this.fileName = fileName;
    }

    public String getFileSha256() {
        return fileSha256;
    }

    public void setFileSha256(String fileSha256) {
        this.fileSha256 = fileSha256;
    }

    public int getTotalRows() {
        return totalRows;
    }

    public void setTotalRows(int totalRows) {
        this.totalRows = totalRows;
    }

    public int getSuccessRows() {
        return successRows;
    }

    public void setSuccessRows(int successRows) {
        this.successRows = successRows;
    }

    public int getErrorRows() {
        return errorRows;
    }

    public void setErrorRows(int errorRows) {
        this.errorRows = errorRows;
    }

    public List<Map<String, Object>> getErrors() {
        return errors;
    }

    public void setErrors(List<Map<String, Object>> errors) {
        this.errors = errors;
    }

    public List<Map<String, String>> getRowsJson() {
        return rowsJson;
    }

    public void setRowsJson(List<Map<String, String>> rowsJson) {
        this.rowsJson = rowsJson;
    }

    public String getOperator() {
        return operator;
    }

    public void setOperator(String operator) {
        this.operator = operator;
    }

    public OffsetDateTime getCreatedAt() {
        return createdAt;
    }

    public void setCreatedAt(OffsetDateTime createdAt) {
        this.createdAt = createdAt;
    }

    public OffsetDateTime getCommittedAt() {
        return committedAt;
    }

    public void setCommittedAt(OffsetDateTime committedAt) {
        this.committedAt = committedAt;
    }
}
