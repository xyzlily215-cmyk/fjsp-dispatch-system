package com.fjsp.business.service;

import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

import com.fjsp.business.common.BizException;
import com.fjsp.business.dto.ExecutionFeedbackResponse;
import com.fjsp.business.dto.ExecutionRequest;
import com.fjsp.business.dto.ExecutionTimelineItem;
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
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class ExecutionService {

    static final long DEVIATION_THRESHOLD_MINUTES = 15;
    static final String REASON_EXECUTION_DEVIATION = "EXECUTION_DEVIATION";

    private final ExecutionRecordRepository executionRecordRepository;
    private final PlanVersionRepository planVersionRepository;
    private final ScheduleOperationRepository scheduleOperationRepository;
    private final OrderOperationRepository orderOperationRepository;
    private final ProductionOrderRepository productionOrderRepository;
    private final ImpactCalculator impactCalculator;
    private final AuditService auditService;
    private final PlanStateMachine planStateMachine;
    private final ConfigService configService;

    public ExecutionService(ExecutionRecordRepository executionRecordRepository,
                            PlanVersionRepository planVersionRepository,
                            ScheduleOperationRepository scheduleOperationRepository,
                            OrderOperationRepository orderOperationRepository,
                            ProductionOrderRepository productionOrderRepository,
                            ImpactCalculator impactCalculator,
                            AuditService auditService,
                            PlanStateMachine planStateMachine,
                            ConfigService configService) {
        this.executionRecordRepository = executionRecordRepository;
        this.planVersionRepository = planVersionRepository;
        this.scheduleOperationRepository = scheduleOperationRepository;
        this.orderOperationRepository = orderOperationRepository;
        this.productionOrderRepository = productionOrderRepository;
        this.impactCalculator = impactCalculator;
        this.auditService = auditService;
        this.planStateMachine = planStateMachine;
        this.configService = configService;
    }

    @Transactional
    public ExecutionFeedbackResponse feedback(String operationId, ExecutionRequest req) {
        if (req == null || req.status() == null) {
            throw BizException.validation("status 必须是 RUNNING / PAUSED / RESUMED / COMPLETED / EXCEPTION");
        }
        return switch (req.status()) {
            case "RUNNING" -> start(operationId, req);
            case "PAUSED" -> pause(operationId, req);
            case "RESUMED" -> resume(operationId, req);
            case "COMPLETED" -> complete(operationId, req);
            case "EXCEPTION" -> exception(operationId, req);
            default -> throw BizException.validation("status 必须是 RUNNING / PAUSED / RESUMED / COMPLETED / EXCEPTION");
        };
    }

    public List<ExecutionTimelineItem> timeline(String operationId) {
        orderOperationRepository.findById(operationId)
                .orElseThrow(() -> BizException.notFound("工序不存在: " + operationId));
        return executionRecordRepository.findByOperationIdOrderByCreatedAt(operationId).stream()
                .map(this::toTimelineItem)
                .toList();
    }

    private ExecutionFeedbackResponse start(String operationId, ExecutionRequest req) {
        FeedbackContext ctx = loadContext(operationId);
        var open = executionRecordRepository
                .findFirstByOperationIdAndStatusAndActualEndAtIsNull(operationId, "RUNNING");
        if (open.isPresent()) {
            throw BizException.stateConflict("工序已在执行中: " + operationId);
        }
        if (executionRecordRepository.existsByOperationIdAndStatus(operationId, "COMPLETED")) {
            throw BizException.stateConflict("工序已完成，不能重新开始: " + operationId);
        }
        OffsetDateTime actualStart = req.actualStartAt() != null
                ? OffsetDateTime.parse(req.actualStartAt()) : OffsetDateTime.now();
        ExecutionRecord record = newRecord(operationId, ctx.published().getId(), "RUNNING");
        record.setActualStartAt(actualStart);
        record.setRemark(req.remark());
        markDeviation(record, ctx.planned().getStartAt(), actualStart);
        try {
            // saveAndFlush 让 uq_execution_record_open_running 部分唯一索引在事务内即刻校验，
            // 两个并发 RUNNING 反馈只有一个能成功，另一个转为 409
            executionRecordRepository.saveAndFlush(record);
        } catch (DataIntegrityViolationException e) {
            throw BizException.stateConflict("工序已在执行中: " + operationId);
        }

        PlanVersion published = ctx.published();
        if (PlanStateMachine.PUBLISHED.equals(published.getStatus())) {
            planStateMachine.assertTransition(published.getStatus(), PlanStateMachine.EXECUTING);
            published.setStatus(PlanStateMachine.EXECUTING);
            planVersionRepository.save(published);
        }
        OrderOperation operation = ctx.operation();
        operation.setStatus("RUNNING");
        orderOperationRepository.save(operation);
        ProductionOrder order = productionOrderRepository.findById(operation.getOrderId()).orElse(null);
        if (order != null && !"RUNNING".equals(order.getStatus())
                && !"COMPLETED".equals(order.getStatus())) {
            order.setStatus("RUNNING");
            productionOrderRepository.save(order);
        }
        auditService.record("EXECUTION_RUNNING", "order_operation", operationId,
                "planVersion=" + published.getVersionCode() + deviationNote(record));
        return toMap(record, published);
    }

    private ExecutionFeedbackResponse pause(String operationId, ExecutionRequest req) {
        if (req.remark() == null || req.remark().isBlank()) {
            throw BizException.validation("暂停必须填写原因");
        }
        FeedbackContext ctx = loadContext(operationId);
        executionRecordRepository
                .findFirstByOperationIdAndStatusAndActualEndAtIsNull(operationId, "RUNNING")
                .orElseThrow(() -> BizException.stateConflict("工序未开工，不能暂停: " + operationId));
        if (executionRecordRepository
                .findFirstByOperationIdAndStatusAndActualEndAtIsNull(operationId, "PAUSED").isPresent()) {
            throw BizException.stateConflict("工序已处于暂停中: " + operationId);
        }
        ExecutionRecord record = newRecord(operationId, ctx.published().getId(), "PAUSED");
        record.setOccurredAt(OffsetDateTime.now());
        record.setRemark(req.remark());
        try {
            // uq_execution_record_open_pause 把并发重复暂停收敛为 409
            executionRecordRepository.saveAndFlush(record);
        } catch (DataIntegrityViolationException e) {
            throw BizException.stateConflict("工序已处于暂停中: " + operationId);
        }
        OrderOperation operation = ctx.operation();
        operation.setStatus("PAUSED");
        orderOperationRepository.save(operation);
        auditService.record("EXECUTION_PAUSED", "order_operation", operationId,
                "planVersion=" + ctx.published().getVersionCode() + ", reason=" + req.remark());
        return toMap(record, ctx.published());
    }

    private ExecutionFeedbackResponse resume(String operationId, ExecutionRequest req) {
        FeedbackContext ctx = loadContext(operationId);
        ExecutionRecord paused = executionRecordRepository
                .findFirstByOperationIdAndStatusAndActualEndAtIsNull(operationId, "PAUSED")
                .orElseThrow(() -> BizException.stateConflict("工序未处于暂停中，不能恢复: " + operationId));
        OffsetDateTime now = OffsetDateTime.now();
        ExecutionRecord record = newRecord(operationId, ctx.published().getId(), "RESUMED");
        record.setOccurredAt(now);
        record.setRemark(req.remark());
        executionRecordRepository.save(record);
        paused.setActualEndAt(now);
        executionRecordRepository.save(paused);
        OrderOperation operation = ctx.operation();
        operation.setStatus("RUNNING");
        orderOperationRepository.save(operation);
        auditService.record("EXECUTION_RESUMED", "order_operation", operationId,
                "planVersion=" + ctx.published().getVersionCode());
        return toMap(record, ctx.published());
    }

    private ExecutionFeedbackResponse complete(String operationId, ExecutionRequest req) {
        FeedbackContext ctx = loadContext(operationId);
        ExecutionRecord running = executionRecordRepository
                .findFirstByOperationIdAndStatusAndActualEndAtIsNull(operationId, "RUNNING")
                .orElseThrow(() -> BizException.stateConflict("工序必须先反馈 RUNNING 才能 COMPLETED: " + operationId));
        if (executionRecordRepository
                .findFirstByOperationIdAndStatusAndActualEndAtIsNull(operationId, "PAUSED").isPresent()) {
            throw BizException.stateConflict("工序暂停中，请先恢复再完工: " + operationId);
        }
        OffsetDateTime actualEnd = req.actualEndAt() != null
                ? OffsetDateTime.parse(req.actualEndAt()) : OffsetDateTime.now();
        if (running.getActualStartAt() != null && actualEnd.isBefore(running.getActualStartAt())) {
            throw BizException.validation("actualEndAt 不能早于 actualStartAt");
        }
        running.setStatus("COMPLETED");
        running.setActualEndAt(actualEnd);
        if (req.remark() != null) {
            running.setRemark(req.remark());
        }
        markDeviation(running, ctx.planned().getEndAt(), actualEnd);
        executionRecordRepository.save(running);

        OrderOperation operation = ctx.operation();
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
                "planVersion=" + ctx.published().getVersionCode()
                        + ", plannedEnd=" + ctx.planned().getEndAt() + deviationNote(running));
        return toMap(running, ctx.published());
    }

    private ExecutionFeedbackResponse exception(String operationId, ExecutionRequest req) {
        if (req.reasonCode() == null || req.reasonCode().isBlank()) {
            throw BizException.validation("异常反馈必须选择原因码");
        }
        if (req.remark() == null || req.remark().isBlank()) {
            throw BizException.validation("异常反馈必须填写备注");
        }
        FeedbackContext ctx = loadContext(operationId);
        if (executionRecordRepository.existsByOperationIdAndStatus(operationId, "COMPLETED")) {
            throw BizException.stateConflict("工序已完成，异常更正需管理员审批: " + operationId);
        }
        ExecutionRecord record = newRecord(operationId, ctx.published().getId(), "EXCEPTION");
        record.setOccurredAt(OffsetDateTime.now());
        record.setReasonCode(req.reasonCode());
        record.setRemark(req.remark());
        executionRecordRepository.save(record);
        auditService.record("EXECUTION_EXCEPTION", "order_operation", operationId,
                "planVersion=" + ctx.published().getVersionCode()
                        + ", reasonCode=" + req.reasonCode() + ", remark=" + req.remark());
        return toMap(record, ctx.published());
    }

    private FeedbackContext loadContext(String operationId) {
        OrderOperation operation = orderOperationRepository.findById(operationId)
                .orElseThrow(() -> BizException.notFound("工序不存在: " + operationId));
        PlanVersion published = impactCalculator.currentPublishedPlan();
        if (published == null) {
            throw BizException.stateConflict("当前没有已发布计划，无法写入执行反馈");
        }
        ScheduleOperation planned = scheduleOperationRepository
                .findByPlanVersionIdAndOperationId(published.getId(), operationId)
                .orElseThrow(() -> BizException.validation("工序不在当前发布计划中: " + operationId));
        return new FeedbackContext(operation, published, planned);
    }

    private ExecutionRecord newRecord(String operationId, String planVersionId, String status) {
        ExecutionRecord record = new ExecutionRecord();
        record.setId(UUID.randomUUID().toString());
        record.setOperationId(operationId);
        record.setPlanVersionId(planVersionId);
        record.setStatus(status);
        return record;
    }

    private void markDeviation(ExecutionRecord record, OffsetDateTime plannedAt, OffsetDateTime actualAt) {
        if (plannedAt == null || actualAt == null) {
            return;
        }
        long minutes = Math.abs(Duration.between(plannedAt, actualAt).toMinutes());
        long threshold = configService.getLong(ConfigService.EXECUTION_DEVIATION_THRESHOLD_MINUTES,
                DEVIATION_THRESHOLD_MINUTES);
        Integer current = record.getDeviationMinutes();
        if (minutes > threshold && (current == null || minutes > current)) {
            record.setDeviationMinutes((int) minutes);
            record.setReasonCode(REASON_EXECUTION_DEVIATION);
        }
    }

    private String deviationNote(ExecutionRecord record) {
        return REASON_EXECUTION_DEVIATION.equals(record.getReasonCode())
                ? ", deviationMinutes=" + record.getDeviationMinutes() : "";
    }

    private ExecutionFeedbackResponse toMap(ExecutionRecord record, PlanVersion plan) {
        return new ExecutionFeedbackResponse(record.getId(), record.getOperationId(),
                record.getStatus(), record.getActualStartAt(), record.getActualEndAt(),
                record.getOccurredAt(), record.getReasonCode(), record.getDeviationMinutes(),
                plan.getId(), plan.getStatus());
    }

    private ExecutionTimelineItem toTimelineItem(ExecutionRecord record) {
        return new ExecutionTimelineItem(record.getId(), record.getOperationId(), record.getStatus(),
                record.getActualStartAt(), record.getActualEndAt(), record.getOccurredAt(),
                record.getReasonCode(), record.getDeviationMinutes(), record.getRemark(),
                record.getCreatedAt());
    }

    private record FeedbackContext(OrderOperation operation, PlanVersion published, ScheduleOperation planned) {
    }
}
