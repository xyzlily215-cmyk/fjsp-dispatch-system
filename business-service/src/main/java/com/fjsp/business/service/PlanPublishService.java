package com.fjsp.business.service;

import java.time.OffsetDateTime;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import com.fjsp.business.common.BizException;
import com.fjsp.business.common.LookupSupport;
import com.fjsp.business.common.RequestContext;
import com.fjsp.business.dto.PlanVersionSummaryResponse;
import com.fjsp.business.dto.PublishRequest;
import com.fjsp.business.entity.InputSnapshot;
import com.fjsp.business.entity.OrderOperation;
import com.fjsp.business.entity.PlanVersion;
import com.fjsp.business.entity.ProductionOrder;
import com.fjsp.business.entity.ScheduleOperation;
import com.fjsp.business.repository.EventRepository;
import com.fjsp.business.repository.InputSnapshotRepository;
import com.fjsp.business.repository.OrderOperationRepository;
import com.fjsp.business.repository.PlanVersionRepository;
import com.fjsp.business.repository.ProductionOrderRepository;
import com.fjsp.business.repository.ScheduleOperationRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class PlanPublishService {

    private static final Logger log = LoggerFactory.getLogger(PlanPublishService.class);

    private final PlanVersionRepository planVersionRepository;
    private final ScheduleOperationRepository scheduleOperationRepository;
    private final InputSnapshotRepository inputSnapshotRepository;
    private final ProductionOrderRepository productionOrderRepository;
    private final OrderOperationRepository orderOperationRepository;
    private final EventRepository eventRepository;
    private final AuditService auditService;
    private final PlanStateMachine planStateMachine;
    private final ScheduleIntegrityGuard integrityGuard;
    private final PlanVersionMapper planVersionMapper;

    public PlanPublishService(PlanVersionRepository planVersionRepository,
                              ScheduleOperationRepository scheduleOperationRepository,
                              InputSnapshotRepository inputSnapshotRepository,
                              ProductionOrderRepository productionOrderRepository,
                              OrderOperationRepository orderOperationRepository,
                              EventRepository eventRepository,
                              AuditService auditService,
                              PlanStateMachine planStateMachine,
                              ScheduleIntegrityGuard integrityGuard,
                              PlanVersionMapper planVersionMapper) {
        this.planVersionRepository = planVersionRepository;
        this.scheduleOperationRepository = scheduleOperationRepository;
        this.inputSnapshotRepository = inputSnapshotRepository;
        this.productionOrderRepository = productionOrderRepository;
        this.orderOperationRepository = orderOperationRepository;
        this.eventRepository = eventRepository;
        this.auditService = auditService;
        this.planStateMachine = planStateMachine;
        this.integrityGuard = integrityGuard;
        this.planVersionMapper = planVersionMapper;
    }

    private PlanVersion find(String idOrCode) {
        return LookupSupport.byIdOrCode(idOrCode, planVersionRepository::findById,
                planVersionRepository::findByVersionCode, "计划版本不存在");
    }

    @Transactional
    public PlanVersionSummaryResponse publish(String idOrCode, PublishRequest req) {
        PlanVersion pv = find(idOrCode);
        if (req == null || req.version() == null || !req.version().equals(pv.getVersion())) {
            throw BizException.versionStale("version 不匹配，请刷新后重试");
        }
        planStateMachine.assertTransition(pv.getStatus(), PlanStateMachine.PUBLISHED);
        assertNotStale(pv);
        integrityGuard.verifyAgainstExecution(pv);
        List<PlanVersion> currentPublished = planVersionRepository
                .findByStatusIn(List.of(PlanStateMachine.PUBLISHED, PlanStateMachine.EXECUTING));
        for (PlanVersion old : currentPublished) {
            planStateMachine.assertTransition(old.getStatus(), PlanStateMachine.SUPERSEDED);
            old.setStatus(PlanStateMachine.SUPERSEDED);
            planVersionRepository.save(old);
        }
        pv.setStatus(PlanStateMachine.PUBLISHED);
        pv.setPublishedAt(OffsetDateTime.now());
        pv.setPublishedBy(RequestContext.operator());
        planVersionRepository.saveAndFlush(pv);

        // orders covered by this plan become SCHEDULED（批量查询，避免全表扫 + 逐条 findById 的 N+1）
        List<ScheduleOperation> planOps = scheduleOperationRepository.findByPlanVersionId(pv.getId());
        Map<String, OrderOperation> opById = new HashMap<>();
        for (OrderOperation oo : orderOperationRepository.findAllById(
                planOps.stream().map(ScheduleOperation::getOperationId).toList())) {
            opById.put(oo.getId(), oo);
        }
        List<String> touchedOrderIds = planOps.stream()
                .map(op -> opById.get(op.getOperationId()))
                .filter(oo -> oo != null)
                .map(OrderOperation::getOrderId)
                .distinct()
                .toList();
        Map<String, ProductionOrder> touched = new HashMap<>();
        for (ProductionOrder order : productionOrderRepository.findAllById(touchedOrderIds)) {
            touched.put(order.getId(), order);
        }
        for (ProductionOrder order : touched.values()) {
            if ("WAITING".equals(order.getStatus())) {
                order.setStatus("SCHEDULED");
                productionOrderRepository.save(order);
            }
        }
        auditService.record("PLAN_PUBLISH", "plan_version", pv.getId(), pv.getVersionCode());
        log.info("plan version {} published, superseded {}", pv.getVersionCode(),
                currentPublished.stream().map(PlanVersion::getVersionCode).toList());
        return planVersionMapper.toSummary(pv);
    }

    private void assertNotStale(PlanVersion pv) {
        if (pv.getParentId() != null) {
            PlanVersion parent = planVersionRepository.findById(pv.getParentId()).orElse(null);
            if (parent == null
                    || (!PlanStateMachine.PUBLISHED.equals(parent.getStatus())
                            && !PlanStateMachine.EXECUTING.equals(parent.getStatus()))) {
                throw BizException.planStale("基准版本已被取代，请基于当前生效版本重新调度");
            }
        }
        if (pv.getTaskId() != null) {
            InputSnapshot snapshot = inputSnapshotRepository.findByTaskId(pv.getTaskId()).orElse(null);
            if (snapshot != null && eventRepository.existsByRecordedAtAfter(snapshot.getCreatedAt())) {
                throw BizException.planStale("快照之后发生新扰动，计划已过期");
            }
        }
    }
}
