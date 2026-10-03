package com.fjsp.business.service;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fjsp.business.client.AlgorithmClient;
import com.fjsp.business.common.BizException;
import com.fjsp.business.dto.PublishRequest;
import com.fjsp.business.dto.ReviewRequest;
import com.fjsp.business.dto.SubmitReviewRequest;
import com.fjsp.business.entity.InputSnapshot;
import com.fjsp.business.entity.OrderOperation;
import com.fjsp.business.entity.PlanVersion;
import com.fjsp.business.entity.ProductionOrder;
import com.fjsp.business.entity.ScheduleOperation;
import com.fjsp.business.repository.EventImpactRepository;
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
import org.springframework.orm.ObjectOptimisticLockingFailureException;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class PlanVersionServiceTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @Mock
    private PlanVersionRepository planVersionRepository;
    @Mock
    private ScheduleOperationRepository scheduleOperationRepository;
    @Mock
    private InputSnapshotRepository inputSnapshotRepository;
    @Mock
    private EventImpactRepository eventImpactRepository;
    @Mock
    private EventRepository eventRepository;
    @Mock
    private ProductionOrderRepository productionOrderRepository;
    @Mock
    private OrderOperationRepository orderOperationRepository;
    @Mock
    private AlgorithmClient algorithmClient;
    @Mock
    private AuditService auditService;
    @Spy
    private PlanStateMachine planStateMachine = new PlanStateMachine();
    @Mock
    private ScheduleIntegrityGuard integrityGuard;

    @InjectMocks
    private PlanVersionService planVersionService;

    private PlanVersion plan(String id, String status, long version) {
        PlanVersion pv = new PlanVersion();
        pv.setId(id);
        pv.setVersionCode("PV-" + id);
        pv.setStatus(status);
        pv.setVersion(version);
        return pv;
    }

    // ---------- DRAFT → REVIEW_PENDING ----------

    @Test
    void submitReview_draft_becomesReviewPending() {
        PlanVersion pv = plan("P1", "DRAFT", 0L);
        when(planVersionRepository.findById("P1")).thenReturn(Optional.of(pv));

        Map<String, Object> data = planVersionService.submitReview("P1", new SubmitReviewRequest(pv.getVersion()));

        assertEquals("REVIEW_PENDING", pv.getStatus());
        assertEquals("REVIEW_PENDING", data.get("status"));
        verify(planVersionRepository).saveAndFlush(pv);
    }

    @Test
    void submitReview_notDraft_stateConflict() {
        PlanVersion pv = plan("P1", "REVIEW_PENDING", 1L);
        when(planVersionRepository.findById("P1")).thenReturn(Optional.of(pv));

        BizException e = assertThrows(BizException.class,
                () -> planVersionService.submitReview("P1", new SubmitReviewRequest(pv.getVersion())));
        assertEquals("E_STATE_CONFLICT", e.getCode());
    }

    @Test
    void submitReview_revalidationFails_infeasible() throws Exception {
        // 提交审核前复核发现设备重叠等硬约束冲突，必须拒绝
        PlanVersion pv = plan("P1", "DRAFT", 0L);
        pv.setTaskId("T1");
        when(planVersionRepository.findById("P1")).thenReturn(Optional.of(pv));
        InputSnapshot snapshot = new InputSnapshot();
        snapshot.setSnapshotJson(Map.of("mode", "BASELINE"));
        when(inputSnapshotRepository.findByTaskId("T1")).thenReturn(Optional.of(snapshot));
        ScheduleOperation op = new ScheduleOperation();
        op.setOperationId("OP-1");
        op.setMachineId("M1");
        op.setStartAt(OffsetDateTime.parse("2026-09-16T08:00:00+08:00"));
        op.setEndAt(OffsetDateTime.parse("2026-09-16T09:00:00+08:00"));
        op.setChangeoverMinutes(0);
        when(scheduleOperationRepository.findByPlanVersionId("P1")).thenReturn(List.of(op));
        when(algorithmClient.validate(any())).thenReturn(JSON.readTree(
                "{\"passed\": false, \"conflicts\": [{\"type\": \"MACHINE_OVERLAP\"}]}"));

        BizException e = assertThrows(BizException.class,
                () -> planVersionService.submitReview("P1", new SubmitReviewRequest(pv.getVersion())));
        assertEquals("E_INFEASIBLE", e.getCode());
        verify(planVersionRepository, never()).saveAndFlush(any());
    }

    @Test
    void submitReview_revalidationPasses_becomesReviewPending() throws Exception {
        PlanVersion pv = plan("P1", "DRAFT", 0L);
        pv.setTaskId("T1");
        when(planVersionRepository.findById("P1")).thenReturn(Optional.of(pv));
        InputSnapshot snapshot = new InputSnapshot();
        snapshot.setSnapshotJson(Map.of("mode", "BASELINE"));
        when(inputSnapshotRepository.findByTaskId("T1")).thenReturn(Optional.of(snapshot));
        when(scheduleOperationRepository.findByPlanVersionId("P1")).thenReturn(List.of());
        when(algorithmClient.validate(any())).thenReturn(JSON.readTree("{\"passed\": true}"));

        planVersionService.submitReview("P1", new SubmitReviewRequest(pv.getVersion()));

        assertEquals("REVIEW_PENDING", pv.getStatus());
    }

    // ---------- REVIEW_PENDING → REVIEWED / REJECTED ----------

    @Test
    void review_approve_becomesReviewed() {
        PlanVersion pv = plan("P1", "REVIEW_PENDING", 1L);
        when(planVersionRepository.findById("P1")).thenReturn(Optional.of(pv));

        Map<String, Object> data = planVersionService.review("P1",
                new ReviewRequest("APPROVE", "looks good", 1L));

        assertEquals("REVIEWED", pv.getStatus());
        assertEquals("REVIEWED", data.get("status"));
        verify(planVersionRepository).saveAndFlush(pv);
    }

    @Test
    void review_reject_becomesRejected() {
        PlanVersion pv = plan("P1", "REVIEW_PENDING", 1L);
        when(planVersionRepository.findById("P1")).thenReturn(Optional.of(pv));

        planVersionService.review("P1", new ReviewRequest("REJECT", "交期不可接受", 1L));

        assertEquals("REJECTED", pv.getStatus());
        assertEquals("交期不可接受", pv.getReviewComment());
    }

    @Test
    void review_rejectWithoutComment_validation() {
        PlanVersion pv = plan("P1", "REVIEW_PENDING", 1L);
        when(planVersionRepository.findById("P1")).thenReturn(Optional.of(pv));

        BizException e = assertThrows(BizException.class,
                () -> planVersionService.review("P1", new ReviewRequest("REJECT", " ", 1L)));
        assertEquals("E_VALIDATION", e.getCode());
    }

    @Test
    void review_staleVersion_versionStale() {
        PlanVersion pv = plan("P1", "REVIEW_PENDING", 2L);
        when(planVersionRepository.findById("P1")).thenReturn(Optional.of(pv));

        BizException e = assertThrows(BizException.class,
                () -> planVersionService.review("P1", new ReviewRequest("APPROVE", null, 1L)));
        assertEquals("E_VERSION_STALE", e.getCode());
    }

    @Test
    void review_notPending_stateConflict() {
        PlanVersion pv = plan("P1", "DRAFT", 0L);
        when(planVersionRepository.findById("P1")).thenReturn(Optional.of(pv));

        BizException e = assertThrows(BizException.class,
                () -> planVersionService.review("P1", new ReviewRequest("APPROVE", null, 0L)));
        assertEquals("E_STATE_CONFLICT", e.getCode());
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
        when(orderOperationRepository.findAll()).thenReturn(List.of(oo));
        ProductionOrder order = new ProductionOrder();
        order.setId("ORD-1");
        order.setStatus("WAITING");
        when(productionOrderRepository.findById("ORD-1")).thenReturn(Optional.of(order));

        Map<String, Object> data = planVersionService.publish("P2", new PublishRequest(2L));

        assertEquals("PUBLISHED", pv.getStatus());
        assertEquals("PUBLISHED", data.get("status"));
        assertNotNull(pv.getPublishedAt());
        assertEquals("SUPERSEDED", old.getStatus());
        assertEquals("SCHEDULED", order.getStatus());
        verify(productionOrderRepository).save(order);
        verify(planVersionRepository).saveAndFlush(pv);
    }

    @Test
    void publish_notReviewed_stateConflict() {
        PlanVersion pv = plan("P1", "REVIEW_PENDING", 1L);
        when(planVersionRepository.findById("P1")).thenReturn(Optional.of(pv));

        BizException e = assertThrows(BizException.class,
                () -> planVersionService.publish("P1", new PublishRequest(1L)));
        assertEquals("E_STATE_CONFLICT", e.getCode());
    }

    @Test
    void publish_draftNotAllowed_stateConflict() {
        PlanVersion pv = plan("P1", "DRAFT", 0L);
        when(planVersionRepository.findById("P1")).thenReturn(Optional.of(pv));

        BizException e = assertThrows(BizException.class,
                () -> planVersionService.publish("P1", new PublishRequest(0L)));
        assertEquals("E_STATE_CONFLICT", e.getCode());
    }

    @Test
    void publish_staleVersion_versionStale() {
        // 客户端拿着过期 version（老版本视图）请求发布，必须拒绝，避免老版本覆盖新版本
        PlanVersion pv = plan("P1", "REVIEWED", 3L);
        when(planVersionRepository.findById("P1")).thenReturn(Optional.of(pv));

        BizException e = assertThrows(BizException.class,
                () -> planVersionService.publish("P1", new PublishRequest(1L)));
        assertEquals("E_VERSION_STALE", e.getCode());
        verify(planVersionRepository, never()).saveAndFlush(any());
    }

    @Test
    void publish_alreadyPublished_stateConflict() {
        PlanVersion pv = plan("P1", "PUBLISHED", 4L);
        when(planVersionRepository.findById("P1")).thenReturn(Optional.of(pv));

        BizException e = assertThrows(BizException.class,
                () -> planVersionService.publish("P1", new PublishRequest(4L)));
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
                () -> planVersionService.publish("P1", new PublishRequest(2L)));
    }

    @Test
    void publish_nullVersion_versionStale() {
        PlanVersion pv = plan("P1", "REVIEWED", 2L);
        when(planVersionRepository.findById("P1")).thenReturn(Optional.of(pv));

        BizException e = assertThrows(BizException.class,
                () -> planVersionService.publish("P1", new PublishRequest(null)));
        assertEquals("E_VERSION_STALE", e.getCode());
    }
}
