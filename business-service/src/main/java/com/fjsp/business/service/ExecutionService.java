package com.fjsp.business.service;

import java.time.OffsetDateTime;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

import com.fjsp.business.common.BizException;
import com.fjsp.business.dto.ExecutionRequest;
import com.fjsp.business.entity.ExecutionRecord;
import com.fjsp.business.entity.OrderOperation;
import com.fjsp.business.entity.PlanVersion;
import com.fjsp.business.entity.ProductionOrder;
import com.fjsp.business.entity.ScheduleOperation;
import com.fjsp.business.repository.ExecutionRecordRepository;
import com.fjsp.business.repository.OrderOperationRepository;
import com.fjsp.business.repository.PlanVersionRepository;
import com.fjsp.business.repository.ProductionOrderRepository;
import com.fjsp.business.repository.ScheduleOperationRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class ExecutionService {

    private final ExecutionRecordRepository executionRecordRepository;
    private final PlanVersionRepository planVersionRepository;
    private final ScheduleOperationRepository scheduleOperationRepository;
    private final OrderOperationRepository orderOperationRepository;
    private final ProductionOrderRepository productionOrderRepository;
    private final ImpactCalculator impactCalculator;
    private final AuditService auditService;
    private final PlanStateMachine planStateMachine;

    public ExecutionService(ExecutionRecordRepository executionRecordRepository,
                            PlanVersionRepository planVersionRepository,
                            ScheduleOperationRepository scheduleOperationRepository,
                            OrderOperationRepository orderOperationRepository,
                            ProductionOrderRepository productionOrderRepository,
                            ImpactCalculator impactCalculator,
                            AuditService auditService,
                            PlanStateMachine planStateMachine) {
        this.executionRecordRepository = executionRecordRepository;
        this.planVersionRepository = planVersionRepository;
        this.scheduleOperationRepository = scheduleOperationRepository;
        this.orderOperationRepository = orderOperationRepository;
        this.productionOrderRepository = productionOrderRepository;
        this.impactCalculator = impactCalculator;
        this.auditService = auditService;
        this.planStateMachine = planStateMachine;
    }

    @Transactional
    public Map<String, Object> feedback(String operationId, ExecutionRequest req) {
        if (req == null || req.status() == null
                || (!"RUNNING".equals(req.status()) && !"COMPLETED".equals(req.status()))) {
            throw BizException.validation("status 必须是 RUNNING / COMPLETED");
        }
        OrderOperation operation = orderOperationRepository.findById(operationId)
                .orElseThrow(() -> BizException.notFound("工序不存在: " + operationId));
        PlanVersion published = impactCalculator.currentPublishedPlan();
        if (published == null) {
            throw BizException.stateConflict("当前没有已发布计划，无法写入执行反馈");
        }
        ScheduleOperation planned = scheduleOperationRepository
                .findByPlanVersionIdAndOperationId(published.getId(), operationId)
                .orElseThrow(() -> BizException.validation("工序不在当前发布计划中: " + operationId));

        OffsetDateTime now = OffsetDateTime.now();
        if ("RUNNING".equals(req.status())) {
            var open = executionRecordRepository
                    .findFirstByOperationIdAndStatusAndActualEndAtIsNull(operationId, "RUNNING");
            if (open.isPresent()) {
                throw BizException.stateConflict("工序已在执行中: " + operationId);
            }
            if (executionRecordRepository.existsByOperationIdAndStatus(operationId, "COMPLETED")) {
                throw BizException.stateConflict("工序已完成，不能重新开始: " + operationId);
            }
            OffsetDateTime actualStart = req.actualStartAt() != null
                    ? OffsetDateTime.parse(req.actualStartAt()) : now;
            ExecutionRecord record = new ExecutionRecord();
            record.setId(UUID.randomUUID().toString());
            record.setOperationId(operationId);
            record.setPlanVersionId(published.getId());
            record.setStatus("RUNNING");
            record.setActualStartAt(actualStart);
            record.setRemark(req.remark());
            executionRecordRepository.save(record);

            if (PlanStateMachine.PUBLISHED.equals(published.getStatus())) {
                planStateMachine.assertTransition(published.getStatus(), PlanStateMachine.EXECUTING);
                published.setStatus(PlanStateMachine.EXECUTING);
                planVersionRepository.save(published);
            }
            operation.setStatus("RUNNING");
            orderOperationRepository.save(operation);
            ProductionOrder order = productionOrderRepository.findById(operation.getOrderId()).orElse(null);
            if (order != null && !"RUNNING".equals(order.getStatus())
                    && !"COMPLETED".equals(order.getStatus())) {
                order.setStatus("RUNNING");
                productionOrderRepository.save(order);
            }
            auditService.record("EXECUTION_RUNNING", "order_operation", operationId,
                    "planVersion=" + published.getVersionCode());
            return toMap(record, published);
        }

        // COMPLETED
        ExecutionRecord running = executionRecordRepository
                .findFirstByOperationIdAndStatusAndActualEndAtIsNull(operationId, "RUNNING")
                .orElseThrow(() -> BizException.stateConflict("工序必须先反馈 RUNNING 才能 COMPLETED: " + operationId));
        OffsetDateTime actualEnd = req.actualEndAt() != null
                ? OffsetDateTime.parse(req.actualEndAt()) : now;
        if (running.getActualStartAt() != null && actualEnd.isBefore(running.getActualStartAt())) {
            throw BizException.validation("actualEndAt 不能早于 actualStartAt");
        }
        running.setStatus("COMPLETED");
        running.setActualEndAt(actualEnd);
        if (req.remark() != null) {
            running.setRemark(req.remark());
        }
        executionRecordRepository.save(running);

        operation.setStatus("COMPLETED");
        orderOperationRepository.save(operation);
        ProductionOrder order = productionOrderRepository.findById(operation.getOrderId()).orElse(null);
        if (order != null) {
            boolean allCompleted = orderOperationRepository
                    .findByOrderIdOrderBySequenceNo(order.getId()).stream()
                    .allMatch(o -> "COMPLETED".equals(o.getStatus()));
            if (allCompleted) {
                order.setStatus("COMPLETED");
                productionOrderRepository.save(order);
            }
        }
        auditService.record("EXECUTION_COMPLETED", "order_operation", operationId,
                "planVersion=" + published.getVersionCode() + ", plannedEnd=" + planned.getEndAt());
        return toMap(running, published);
    }

    private Map<String, Object> toMap(ExecutionRecord record, PlanVersion plan) {
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("executionRecordId", record.getId());
        data.put("operationId", record.getOperationId());
        data.put("status", record.getStatus());
        data.put("actualStartAt", record.getActualStartAt());
        data.put("actualEndAt", record.getActualEndAt());
        data.put("planVersionId", plan.getId());
        data.put("planVersionStatus", plan.getStatus());
        return data;
    }
}
