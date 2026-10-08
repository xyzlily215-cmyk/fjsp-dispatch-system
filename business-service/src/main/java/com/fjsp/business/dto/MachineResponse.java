package com.fjsp.business.dto;

import java.util.List;

/** 设备响应（列表项及创建/更新/状态变更响应）。 */
public record MachineResponse(String machineId, String machineCode, String machineName,
                              String workCenterId, String calendarId, List<String> productFamilies,
                              String status, String remark) {
}
