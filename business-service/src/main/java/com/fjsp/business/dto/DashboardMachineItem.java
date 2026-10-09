package com.fjsp.business.dto;

import java.util.List;

/** 看板设备状态项。 */
public record DashboardMachineItem(String machineId, String workCenterId, String status,
                                   List<String> productFamilies) {
}
