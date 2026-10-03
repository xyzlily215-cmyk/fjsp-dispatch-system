package com.fjsp.business.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import jakarta.persistence.UniqueConstraint;

@Entity
@Table(name = "process_template", uniqueConstraints = @UniqueConstraint(columnNames = {"templateCode", "templateVersion"}))
public class ProcessTemplate {

    @Id
    private String id;

    @Column(nullable = false)
    private String templateCode;

    @Column(nullable = false)
    private String productFamily;

    @Column(nullable = false)
    private Integer templateVersion = 1;

    @Column(nullable = false)
    private String status = "ACTIVE";

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public String getTemplateCode() {
        return templateCode;
    }

    public void setTemplateCode(String templateCode) {
        this.templateCode = templateCode;
    }

    public String getProductFamily() {
        return productFamily;
    }

    public void setProductFamily(String productFamily) {
        this.productFamily = productFamily;
    }

    public Integer getTemplateVersion() {
        return templateVersion;
    }

    public void setTemplateVersion(Integer templateVersion) {
        this.templateVersion = templateVersion;
    }

    public String getStatus() {
        return status;
    }

    public void setStatus(String status) {
        this.status = status;
    }
}
