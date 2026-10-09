package com.fjsp.business.service;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fjsp.business.client.AlgorithmClient;
import com.fjsp.business.common.BizException;
import com.fjsp.business.dto.PlanVersionSummaryResponse;
import com.fjsp.business.dto.ReviewRequest;
import com.fjsp.business.dto.SubmitReviewRequest;
import com.fjsp.business.entity.InputSnapshot;
import com.fjsp.business.entity.PlanVersion;
import com.fjsp.business.entity.ScheduleOperation;
import com.fjsp.business.repository.InputSnapshotRepository;
import com.fjsp.business.repository.PlanVersionRepository;
import com.fjsp.business.repository.ScheduleOperationRepository;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.Spy;
import org.mockito.junit.jupiter.MockitoExtension;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class PlanReviewServiceTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @Mock
    private PlanVersionRepository planVersionRepository;
    @Mock
    private ScheduleOperationRepository scheduleOperationRepository;
    @Mock
    private InputSnapshotRepository inputSnapshotRepository;
    @Mock
    private AlgorithmClient algorithmClient;
    @Mock
    private AuditService auditService;
    @Spy
    private PlanStateMachine planStateMachine = new PlanStateMachine();
    @Spy
    private ValidateRequestFactory validateRequestFactory = new ValidateRequestFactory();
    @Spy
    private PlanVersionMapper planVersionMapper = new PlanVersionMapper();

    @InjectMocks
    private PlanReviewService planReviewService;

    @org.junit.jupiter.api.BeforeEach
    void injectSelfProxy() {
        // 生产代码通过 @Lazy 自注入代理拆分事务（复核在事务外、落库在事务内）；
        // 单元测试无 Spring 代理，直接指向自身
        org.springframework.test.util.ReflectionTestUtils
                .setField(planReviewService, "self", planReviewService);
    }

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

        PlanVersionSummaryResponse data = planReviewService.submitReview("P1", new SubmitReviewRequest(pv.getVersion()));

        assertEquals("REVIEW_PENDING", pv.getStatus());
        assertEquals("REVIEW_PENDING", data.status());
        verify(planVersionRepository).saveAndFlush(pv);
    }

    @Test
    void submitReview_notDraft_stateConflict() {
        PlanVersion pv = plan("P1", "REVIEW_PENDING", 1L);
        when(planVersionRepository.findById("P1")).thenReturn(Optional.of(pv));

        BizException e = assertThrows(BizException.class,
                () -> planReviewService.submitReview("P1", new SubmitReviewRequest(pv.getVersion())));
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
                () -> planReviewService.submitReview("P1", new SubmitReviewRequest(pv.getVersion())));
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

        planReviewService.submitReview("P1", new SubmitReviewRequest(pv.getVersion()));

        assertEquals("REVIEW_PENDING", pv.getStatus());
    }

    // ---------- REVIEW_PENDING → REVIEWED / REJECTED ----------

    @Test
    void review_approve_becomesReviewed() {
        PlanVersion pv = plan("P1", "REVIEW_PENDING", 1L);
        when(planVersionRepository.findById("P1")).thenReturn(Optional.of(pv));

        PlanVersionSummaryResponse data = planReviewService.review("P1",
                new ReviewRequest("APPROVE", "looks good", 1L));

        assertEquals("REVIEWED", pv.getStatus());
        assertEquals("REVIEWED", data.status());
        verify(planVersionRepository).saveAndFlush(pv);
    }

    @Test
    void review_reject_becomesRejected() {
        PlanVersion pv = plan("P1", "REVIEW_PENDING", 1L);
        when(planVersionRepository.findById("P1")).thenReturn(Optional.of(pv));

        planReviewService.review("P1", new ReviewRequest("REJECT", "交期不可接受", 1L));

        assertEquals("REJECTED", pv.getStatus());
        assertEquals("交期不可接受", pv.getReviewComment());
    }

    @Test
    void review_rejectWithoutComment_validation() {
        PlanVersion pv = plan("P1", "REVIEW_PENDING", 1L);
        when(planVersionRepository.findById("P1")).thenReturn(Optional.of(pv));

        BizException e = assertThrows(BizException.class,
                () -> planReviewService.review("P1", new ReviewRequest("REJECT", " ", 1L)));
        assertEquals("E_VALIDATION", e.getCode());
    }

    @Test
    void review_staleVersion_versionStale() {
        PlanVersion pv = plan("P1", "REVIEW_PENDING", 2L);
        when(planVersionRepository.findById("P1")).thenReturn(Optional.of(pv));

        BizException e = assertThrows(BizException.class,
                () -> planReviewService.review("P1", new ReviewRequest("APPROVE", null, 1L)));
        assertEquals("E_VERSION_STALE", e.getCode());
    }

    @Test
    void review_notPending_stateConflict() {
        PlanVersion pv = plan("P1", "DRAFT", 0L);
        when(planVersionRepository.findById("P1")).thenReturn(Optional.of(pv));

        BizException e = assertThrows(BizException.class,
                () -> planReviewService.review("P1", new ReviewRequest("APPROVE", null, 0L)));
        assertEquals("E_STATE_CONFLICT", e.getCode());
    }
}
