package com.fjsp.business.entity;

import java.time.OffsetDateTime;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

/** F-12 基础字典：键值型配置（含配置版本与生效时间），仅 ADMIN 可改。 */
@Entity
@Table(name = "sys_config")
public class SysConfig {

    @Id
    private String id;

    @Column(nullable = false, unique = true)
    private String configKey;

    @Column(columnDefinition = "text")
    private String configValue;

    @Column(length = 500)
    private String description;

    @Column(nullable = false)
    private Integer version = 1;

    @Column(nullable = false)
    private OffsetDateTime effectiveAt = OffsetDateTime.now();

    private String updatedBy;

    @Column(nullable = false)
    private OffsetDateTime updatedAt = OffsetDateTime.now();

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public String getConfigKey() {
        return configKey;
    }

    public void setConfigKey(String configKey) {
        this.configKey = configKey;
    }

    public String getConfigValue() {
        return configValue;
    }

    public void setConfigValue(String configValue) {
        this.configValue = configValue;
    }

    public String getDescription() {
        return description;
    }

    public void setDescription(String description) {
        this.description = description;
    }

    public Integer getVersion() {
        return version != null ? version : 1;
    }

    public void setVersion(Integer version) {
        this.version = version;
    }

    public OffsetDateTime getEffectiveAt() {
        return effectiveAt;
    }

    public void setEffectiveAt(OffsetDateTime effectiveAt) {
        this.effectiveAt = effectiveAt;
    }

    public String getUpdatedBy() {
        return updatedBy;
    }

    public void setUpdatedBy(String updatedBy) {
        this.updatedBy = updatedBy;
    }

    public OffsetDateTime getUpdatedAt() {
        return updatedAt;
    }

    public void setUpdatedAt(OffsetDateTime updatedAt) {
        this.updatedAt = updatedAt;
    }
}
