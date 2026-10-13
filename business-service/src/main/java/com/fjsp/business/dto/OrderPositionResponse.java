package com.fjsp.business.dto;

import java.time.OffsetDateTime;
import java.util.List;

/**
 * 订单加工位置聚合：订单基础信息 + 工序进度计数 + 当前/下一道工序 + 全部工序精简列表。
 * machineId/plannedStartAt/plannedEndAt 取自当前已发布（PUBLISHED/EXECUTING）计划版本，
 * 无已发布计划时这些字段为 null 且 planPublished=false。
 */
public record OrderPositionResponse(String orderId, String orderCode, String productFamily, Integer quantity,
                                    Integer priority, String orderStatus, boolean planPublished,
                                    String planVersionId, int totalOperations, int completedOperations,
                                    int remainingOperations, int progressPercent,
                                    OperationItem currentOperation, OperationItem nextOperation,
                                    List<OperationItem> operations) {

    /** 工序精简视图：状态 + 计划设备与时间；actualStartAt 仅当前工序可能取到（未闭合的 RUNNING 执行记录）。 */
    public record OperationItem(String operationId, Integer sequenceNo, String status,
                                String machineId, OffsetDateTime plannedStartAt, OffsetDateTime plannedEndAt,
                                OffsetDateTime actualStartAt) {
    }
}
