package com.fjsp.business.entity;

/**
 * execution_record.status 的取值集合，与执行反馈请求（ExecutionRequest.status）同构。
 * 数据库列仍为字符串。RUNNING / PAUSED 为可未闭合的过程态，COMPLETED 为终态，
 * RESUMED / EXCEPTION 为瞬时事件记录。
 */
public final class ExecutionStatus {

    public static final String RUNNING = "RUNNING";
    public static final String PAUSED = "PAUSED";
    public static final String RESUMED = "RESUMED";
    public static final String COMPLETED = "COMPLETED";
    public static final String EXCEPTION = "EXCEPTION";

    private ExecutionStatus() {
    }
}
