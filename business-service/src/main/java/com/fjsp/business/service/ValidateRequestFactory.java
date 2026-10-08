package com.fjsp.business.service;

import java.util.LinkedHashMap;
import java.util.Map;

import org.springframework.stereotype.Component;

/**
 * validate 请求组装：snapshot 部分在 ScheduleResultAssembler（求解结果复核）与
 * PlanReviewService（提交审核前复核）原本各有一份拷贝，这里收敛为唯一实现。
 * 字段名是与算法服务的跨服务契约，与 solve 快照保持一致，勿改。
 * operations 由调用方补充（来源不同：求解响应 JsonNode / 已落库的排程工序）。
 */
@Component
public class ValidateRequestFactory {

    public Map<String, Object> baseFromSnapshot(Map<String, Object> snap) {
        Map<String, Object> validateRequest = new LinkedHashMap<>();
        validateRequest.put("simulationStartAt", snap.get("simulationStartAt"));
        validateRequest.put("machines", snap.get("machines"));
        validateRequest.put("orders", snap.get("orders"));
        validateRequest.put("changeoverDefault", snap.get("changeoverDefault"));
        validateRequest.put("changeoverMatrix", snap.get("changeoverMatrix"));
        validateRequest.put("mode", snap.get("mode"));
        if (snap.get("oldPlan") != null) {
            validateRequest.put("oldPlan", snap.get("oldPlan"));
        }
        if (snap.get("lockings") != null) {
            validateRequest.put("lockings", snap.get("lockings"));
        }
        if (snap.get("affectedOperationIds") != null) {
            validateRequest.put("affectedOperationIds", snap.get("affectedOperationIds"));
        }
        return validateRequest;
    }
}
