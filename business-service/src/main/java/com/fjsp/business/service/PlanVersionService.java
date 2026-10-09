package com.fjsp.business.service;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.stream.Collectors;

import com.fjsp.business.common.LookupSupport;
import com.fjsp.business.common.PageResponse;
import com.fjsp.business.common.PageSupport;
import com.fjsp.business.dto.PlanDiffResponse;
import com.fjsp.business.dto.PlanOperationResponse;
import com.fjsp.business.dto.PlanVersionDetailResponse;
import com.fjsp.business.dto.PlanVersionSummaryResponse;
import com.fjsp.business.dto.PublishRequest;
import com.fjsp.business.dto.ReviewRequest;
import com.fjsp.business.dto.RollbackRequest;
import com.fjsp.business.dto.SubmitReviewRequest;
import com.fjsp.business.entity.ExecutionRecord;
import com.fjsp.business.entity.ExecutionStatus;
import com.fjsp.business.entity.PlanVersion;
import com.fjsp.business.entity.ProductionOrder;
import com.fjsp.business.entity.ScheduleOperation;
import com.fjsp.business.entity.OrderOperation;
import com.fjsp.business.repository.ExecutionRecordRepository;
import com.fjsp.business.repository.OrderOperationRepository;
import com.fjsp.business.repository.PlanVersionRepository;
import com.fjsp.business.repository.ProductionOrderRepository;
import com.fjsp.business.repository.ScheduleOperationRepository;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.stereotype.Service;

/**
 * 计划版本查询（列表/详情/工序明细分页）+ 写操作用例的委托门面：
 * 审批流转见 {@link PlanReviewService}，发布见 {@link PlanPublishService}，
 * 回滚见 {@link PlanRollbackService}，版本对比见 {@link PlanDiffService}。
 */
@Service
public class PlanVersionService {

    private final PlanVersionRepository planVersionRepository;
    private final ScheduleOperationRepository scheduleOperationRepository;
    private final ProductionOrderRepository productionOrderRepository;
    private final OrderOperationRepository orderOperationRepository;
    private final ExecutionRecordRepository executionRecordRepository;
    private final PlanVersionMapper planVersionMapper;
    private final PlanReviewService planReviewService;
    private final PlanPublishService planPublishService;
    private final PlanRollbackService planRollbackService;
    private final PlanDiffService planDiffService;

    public PlanVersionService(PlanVersionRepository planVersionRepository,
                              ScheduleOperationRepository scheduleOperationRepository,
                              ProductionOrderRepository productionOrderRepository,
                              OrderOperationRepository orderOperationRepository,
                              ExecutionRecordRepository executionRecordRepository,
                              PlanVersionMapper planVersionMapper,
                              PlanReviewService planReviewService,
                              PlanPublishService planPublishService,
                              PlanRollbackService planRollbackService,
                              PlanDiffService planDiffService) {
        this.planVersionRepository = planVersionRepository;
        this.scheduleOperationRepository = scheduleOperationRepository;
        this.productionOrderRepository = productionOrderRepository;
        this.orderOperationRepository = orderOperationRepository;
        this.executionRecordRepository = executionRecordRepository;
        this.planVersionMapper = planVersionMapper;
        this.planReviewService = planReviewService;
        this.planPublishService = planPublishService;
        this.planRollbackService = planRollbackService;
        this.planDiffService = planDiffService;
    }

    public PlanVersion find(String idOrCode) {
        return LookupSupport.byIdOrCode(idOrCode, planVersionRepository::findById,
                planVersionRepository::findByVersionCode, "计划版本不存在");
    }

    public PageResponse<PlanVersionSummaryResponse> list(Integer page, Integer size) {
        PageRequest pageable = PageSupport.of(page, size, PageSupport.DEFAULT_MAX_SIZE,
                Sort.by(Sort.Direction.DESC, "createdAt"));
        return PageResponse.of(planVersionRepository.findAllBy(pageable), planVersionMapper::toSummary);
    }

    public PlanVersionDetailResponse detail(String idOrCode) {
        PlanVersion pv = find(idOrCode);
        // 工序明细不再内嵌（可能上千行），由 GET /plan-versions/{id}/operations 分页获取
        return PlanVersionDetailResponse.of(planVersionMapper.toSummary(pv),
                scheduleOperationRepository.countByPlanVersionId(pv.getId()));
    }

    public PageResponse<PlanOperationResponse> operations(String idOrCode, Integer page, Integer size) {
        PlanVersion pv = find(idOrCode);
        PageRequest pageable = PageSupport.of(page, size, PageSupport.BULK_MAX_SIZE,
                Sort.by(Sort.Direction.ASC, "startAt").and(Sort.by("operationId")));
        var result = scheduleOperationRepository.findByPlanVersionId(pv.getId(), pageable);
        // 一次性拉回本页工序的执行记录，内存聚合偏差/异常/暂停标记，替代逐工序查询的 N+1
        List<String> opIds = result.getContent().stream().map(ScheduleOperation::getOperationId).toList();
        Map<String, List<ExecutionRecord>> recordsByOp = opIds.isEmpty() ? Map.of()
                : executionRecordRepository.findByOperationIdIn(opIds).stream()
                        .collect(Collectors.groupingBy(ExecutionRecord::getOperationId));
        // 订单维度字段（订单甘特/CSV 导出需要）：同样批量装载，避免逐工序查询
        OrderContext orders = loadOrderContext(opIds);
        return PageResponse.of(result, op -> toOperationResponse(op, recordsByOp.get(op.getOperationId()), orders));
    }

    /** 批量装载工序所属订单上下文：operationId -> 订单工序 -> 订单。 */
    private OrderContext loadOrderContext(List<String> opIds) {
        if (opIds.isEmpty()) {
            return new OrderContext(Map.of(), Map.of());
        }
        Map<String, OrderOperation> orderOpById = new HashMap<>();
        for (OrderOperation oo : orderOperationRepository.findAllById(opIds)) {
            orderOpById.put(oo.getId(), oo);
        }
        List<String> orderIds = orderOpById.values().stream().map(OrderOperation::getOrderId)
                .distinct().toList();
        Map<String, ProductionOrder> orderById = new HashMap<>();
        for (ProductionOrder order : productionOrderRepository.findAllById(orderIds)) {
            orderById.put(order.getId(), order);
        }
        return new OrderContext(orderOpById, orderById);
    }

    private record OrderContext(Map<String, OrderOperation> orderOpById,
                                Map<String, ProductionOrder> orderById) {
    }

    private PlanOperationResponse toOperationResponse(ScheduleOperation op, List<ExecutionRecord> records,
                                                      OrderContext orders) {
        OrderOperation orderOp = orders.orderOpById().get(op.getOperationId());
        ProductionOrder order = orderOp != null ? orders.orderById().get(orderOp.getOrderId()) : null;
        List<ExecutionRecord> exec = records != null ? records : List.of();
        return new PlanOperationResponse(op.getOperationId(), op.getMachineId(), op.getSetupStartAt(),
                op.getProcessStartAt(), op.getStartAt(), op.getEndAt(), op.getChangeoverMinutes(),
                op.getFrozen(), op.getAffected(), op.getReasonCode(),
                orderOp != null ? orderOp.getOrderId() : null,
                orderOp != null ? orderOp.getSequenceNo() : null,
                orderOp != null ? orderOp.getStatus() : null,
                order != null ? order.getOrderCode() : null,
                order != null ? order.getProductFamily() : null,
                order != null ? order.getPriority() : null,
                order != null ? order.getDueAt() : null,
                exec.stream().anyMatch(r -> ExecutionStatus.COMPLETED.equals(r.getStatus())),
                exec.stream().anyMatch(r -> ExecutionService.REASON_EXECUTION_DEVIATION.equals(r.getReasonCode())),
                exec.stream().map(ExecutionRecord::getDeviationMinutes)
                        .filter(Objects::nonNull).max(Integer::compareTo).orElse(null),
                exec.stream().anyMatch(r -> ExecutionStatus.EXCEPTION.equals(r.getStatus())),
                exec.stream().anyMatch(r -> ExecutionStatus.PAUSED.equals(r.getStatus()) && r.getActualEndAt() == null));
    }

    public PlanDiffResponse diff(String idOrCode, String baselineIdOrCode) {
        return planDiffService.diff(idOrCode, baselineIdOrCode);
    }

    public PlanVersionSummaryResponse submitReview(String idOrCode, SubmitReviewRequest req) {
        return planReviewService.submitReview(idOrCode, req);
    }

    public PlanVersionSummaryResponse persistSubmitReview(String planVersionId, Long version) {
        return planReviewService.persistSubmitReview(planVersionId, version);
    }

    public PlanVersionSummaryResponse revise(String idOrCode, SubmitReviewRequest req) {
        return planReviewService.revise(idOrCode, req);
    }

    public PlanVersionSummaryResponse review(String idOrCode, ReviewRequest req) {
        return planReviewService.review(idOrCode, req);
    }

    public PlanVersionSummaryResponse publish(String idOrCode, PublishRequest req) {
        return planPublishService.publish(idOrCode, req);
    }

    public PlanVersionSummaryResponse rollback(String idOrCode, RollbackRequest req) {
        return planRollbackService.rollback(idOrCode, req);
    }
}
