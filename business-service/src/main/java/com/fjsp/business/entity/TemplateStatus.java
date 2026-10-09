package com.fjsp.business.entity;

/**
 * process_template.status 的取值集合。数据库列仍为字符串。
 * 复制的模板新版本初始为 DRAFT，仅 ACTIVE 模板可用于下单/导入。
 */
public final class TemplateStatus {

    public static final String ACTIVE = "ACTIVE";
    public static final String INACTIVE = "INACTIVE";
    public static final String DRAFT = "DRAFT";

    private TemplateStatus() {
    }
}
