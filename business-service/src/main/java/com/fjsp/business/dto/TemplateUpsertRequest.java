package com.fjsp.business.dto;

import java.util.List;

public record TemplateUpsertRequest(
        String templateCode,
        String productFamily,
        List<TemplateOperationInput> operations) {

    public record TemplateOperationInput(
            Integer sequenceNo,
            String operationCode,
            List<CandidateInput> defaultCandidates) {
    }

    public record CandidateInput(
            String machineId,
            Integer setupMinutes,
            Integer processMinutes) {
    }
}
