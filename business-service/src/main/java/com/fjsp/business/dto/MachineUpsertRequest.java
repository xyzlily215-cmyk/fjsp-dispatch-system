package com.fjsp.business.dto;

import java.util.List;

public record MachineUpsertRequest(
        String machineCode,
        String machineName,
        String workCenterId,
        String calendarId,
        List<String> productFamilies,
        String remark) {
}
