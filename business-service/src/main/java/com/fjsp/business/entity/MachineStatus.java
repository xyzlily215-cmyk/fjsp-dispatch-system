package com.fjsp.business.entity;

/**
 * machine.status 的取值集合。数据库列仍为字符串。
 * INACTIVE 设备不参与排程快照。
 */
public final class MachineStatus {

    public static final String ACTIVE = "ACTIVE";
    public static final String INACTIVE = "INACTIVE";

    private MachineStatus() {
    }
}
