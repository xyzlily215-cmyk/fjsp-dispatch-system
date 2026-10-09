package com.fjsp.business.entity;

/**
 * order_operation.status 的取值集合。数据库列仍为字符串。
 * 工序由执行反馈驱动：NOT_STARTED -> RUNNING <-> PAUSED -> COMPLETED。
 */
public final class OperationStatus {

    public static final String NOT_STARTED = "NOT_STARTED";
    public static final String RUNNING = "RUNNING";
    public static final String PAUSED = "PAUSED";
    public static final String COMPLETED = "COMPLETED";

    private OperationStatus() {
    }
}
