package com.fjsp.business.service;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Optional;

import com.fjsp.business.common.BizException;
import com.fjsp.business.dto.PlanVersionSummaryResponse;
import com.fjsp.business.dto.PublishRequest;
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
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.Spy;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.orm.ObjectOptimisticLockingFailureException;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class PlanPublishServiceTest {

    @Mock
    private PlanVersionRepository planVersionRepository;
    @Mock
    private ScheduleOperationRepository scheduleOperationRepository;
    @Mock
    private InputSnapshotRepository inputSnapshotRepository;
    @Mock
    private ProductionOrderRepository productionOrderRepository;
    @Mock
    private OrderOperationRepository orderOperationRepository;
    @Mock
    private EventRepository eventRepository;
    @Mock
    private AuditService auditService;
    @Spy
    private PlanStateMachine planStateMachine = new PlanStateMachine();
    @Mock
    private ScheduleIntegrityGuard integrityGuard;
    @Spy
    private PlanVersionMapper planVersionMapper = new PlanVersionMapper();

    @InjectMocks
    private PlanPublishService planPublishService;

    private PlanVersion plan(String id, String status, long version) {
        PlanVersion pv = new PlanVersion();
        pv.setId(id);
        pv.setVersionCode("PV-" + id);
        pv.setStatus(status);
        pv.setVersion(version);
        return pv;
    }

    // ---------- REVIEWED → PUBLISHED ----------

    private ScheduleOperation scheduledOp(String planId, String opId) {
        ScheduleOperation op = new ScheduleOperation();
        op.setPlanVersionId(planId);
        op.setOperationId(opId);
        op.setMachineId("M1");
        op.setStartAt(OffsetDateTime.parse("2026-09-16T08:00:00+08:00"));
        op.setEndAt(OffsetDateTime.parse("2026-09-16T09:00:00+08:00"));
        return op;
    }

    @Test
    void publish_reviewed_becomesPublishedAndSupersedesOld() {
        PlanVersion pv = plan("P2", "REVIEWED", 2L);
        PlanVersion old = plan("P1", "PUBLISHED", 5L);
        when(planVersionRepository.findById("P2")).thenReturn(Optional.of(pv));
        when(planVersionRepository.findByStatusIn(List.of("PUBLISHED", "EXECUTING")))
                .thenReturn(List.of(old));
        when(scheduleOperationRepository.findByPlanVersionId("P2"))
                .thenReturn(List.of(scheduledOp("P2", "OP-1")));
        OrderOperation oo = new OrderOperation();
        oo.setId("OP-1");
        oo.setOrderId("ORD-1");
        when(orderOperationRepository.findAllById(any())).thenReturn(List.of(oo));
        ProductionOrder order = new ProductionOrder();
        order.setId("ORD-1");
        order.setStatus("WAITING");
        when(productionOrderRepository.findAllById(any())).thenReturn(List.of(order));

        PlanVersionSummaryResponse data = planPublishService.publish("P2", new PublishRequest(2L));

        assertEquals("PUBLISHED", pv.getStatus());
        assertEquals("PUBLISHED", data.status());
        assertNotNull(pv.getPublishedAt());
        assertEquals("SUPERSEDED", old.getStatus());
        assertEquals("SCHEDULED", order.getStatus());
        verify(productionOrderRepository).save(order);
        verify(planVersionRepository).saveAllAndFlush(List.of(old));
        verify(planVersionRepository).saveAndFlush(pv);
    }

    @Test
    void publish_singleActiveIndexViolation_stateConflict() {
        // 两个并发基线发布（无父版本过期校验兜底）：uq_plan_version_single_active 在 flush 时拒绝后者，
        // 服务层把数据库约束冲突转为 409 业务异常
        PlanVersion pv = plan("P1", "REVIEWED", 2L);
        when(planVersionRepository.findById("P1")).thenReturn(Optional.of(pv));
        when(planVersionRepository.findByStatusIn(List.of("PUBLISHED", "EXECUTING")))
                .thenReturn(List.of());
        when(planVersionRepository.saveAndFlush(pv))
                .thenThrow(new DataIntegrityViolationException("uq_plan_version_single_active"));

        BizException e = assertThrows(BizException.class,
                () -> planPublishService.publish("P1", new PublishRequest(2L)));
        assertEquals("E_STATE_CONFLICT", e.getCode());
    }

    @Test
    void publish_notReviewed_stateConflict() {
        PlanVersion pv = plan("P1", "REVIEW_PENDING", 1L);
        when(planVersionRepository.findById("P1")).thenReturn(Optional.of(pv));

        BizException e = assertThrows(BizException.class,
                () -> planPublishService.publish("P1", new PublishRequest(1L)));
        assertEquals("E_STATE_CONFLICT", e.getCode());
    }

    @Test
    void publish_draftNotAllowed_stateConflict() {
        PlanVersion pv = plan("P1", "DRAFT", 0L);
        when(planVersionRepository.findById("P1")).thenReturn(Optional.of(pv));

        BizException e = assertThrows(BizException.class,
                () -> planPublishService.publish("P1", new PublishRequest(0L)));
        assertEquals("E_STATE_CONFLICT", e.getCode());
    }

    @Test
    void publish_staleVersion_versionStale() {
        // 客户端拿着过期 version（老版本视图）请求发布，必须拒绝，避免老版本覆盖新版本
        PlanVersion pv = plan("P1", "REVIEWED", 3L);
        when(planVersionRepository.findById("P1")).thenReturn(Optional.of(pv));

        BizException e = assertThrows(BizException.class,
                () -> planPublishService.publish("P1", new PublishRequest(1L)));
        assertEquals("E_VERSION_STALE", e.getCode());
        verify(planVersionRepository, never()).saveAndFlush(any());
    }

    @Test
    void publish_alreadyPublished_stateConflict() {
        PlanVersion pv = plan("P1", "PUBLISHED", 4L);
        when(planVersionRepository.findById("P1")).thenReturn(Optional.of(pv));

        BizException e = assertThrows(BizException.class,
                () -> planPublishService.publish("P1", new PublishRequest(4L)));
        assertEquals("E_STATE_CONFLICT", e.getCode());
    }

    @Test
    void publish_concurrentModification_optimisticLockPropagates() {
        // 并发发布：前置 version 校验都通过，但 flush 时版本已被另一方修改，JPA 抛乐观锁异常
        PlanVersion pv = plan("P1", "REVIEWED", 2L);
        when(planVersionRepository.findById("P1")).thenReturn(Optional.of(pv));
        when(planVersionRepository.findByStatusIn(List.of("PUBLISHED", "EXECUTING")))
                .thenReturn(List.of());
        when(planVersionRepository.saveAndFlush(pv))
                .thenThrow(new ObjectOptimisticLockingFailureException(PlanVersion.class, "P1"));

        assertThrows(ObjectOptimisticLockingFailureException.class,
                () -> planPublishService.publish("P1", new PublishRequest(2L)));
    }

    @Test
    void publish_nullVersion_versionStale() {
        PlanVersion pv = plan("P1", "REVIEWED", 2L);
        when(planVersionRepository.findById("P1")).thenReturn(Optional.of(pv));

        BizException e = assertThrows(BizException.class,
                () -> planPublishService.publish("P1", new PublishRequest(null)));
        assertEquals("E_VERSION_STALE", e.getCode());
    }
}
