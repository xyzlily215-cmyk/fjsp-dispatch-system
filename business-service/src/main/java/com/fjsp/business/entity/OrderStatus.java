package com.fjsp.business.entity;

/**
 * production_order.status 的取值集合。数据库列仍为字符串。
 * WAITING -> SCHEDULED（计划发布）-> RUNNING（开工反馈）-> COMPLETED（全部工序完工）。
 */
public final class OrderStatus {

    public static final String WAITING = "WAITING";
    public static final String SCHEDULED = "SCHEDULED";
    public static final String RUNNING = "RUNNING";
    public static final String COMPLETED = "COMPLETED";

    private OrderStatus() {
    }
}
