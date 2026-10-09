package com.fjsp.business.service;

import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.fasterxml.jackson.databind.JsonNode;
import com.fjsp.business.client.AlgorithmClient;
import com.fjsp.business.common.BizException;
import com.fjsp.business.common.LookupSupport;
import com.fjsp.business.common.RequestContext;
import com.fjsp.business.dto.PlanVersionSummaryResponse;
import com.fjsp.business.dto.ReviewRequest;
import com.fjsp.business.dto.SubmitReviewRequest;
import com.fjsp.business.entity.InputSnapshot;
import com.fjsp.business.entity.PlanVersion;
import com.fjsp.business.entity.ScheduleOperation;
import com.fjsp.business.repository.InputSnapshotRepository;
import com.fjsp.business.repository.PlanVersionRepository;
import com.fjsp.business.repository.ScheduleOperationRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class PlanReviewService {

    private final PlanVersionRepository planVersionRepository;
    private final ScheduleOperationRepository scheduleOperationRepository;
    private final InputSnapshotRepository inputSnapshotRepository;
    private final AlgorithmClient algorithmClient;
    private final AuditService auditService;
    private final PlanStateMachine planStateMachine;
    private final ValidateRequestFactory validateRequestFactory;
    private final PlanVersionMapper planVersionMapper;

    // 自注入代理：把事务外的远程复核与事务内的落库拆开（同类自调用 @Transactional 不生效）
    @org.springframework.beans.factory.annotation.Autowired
    @org.springframework.context.annotation.Lazy
    private PlanReviewService self;

    public PlanReviewService(PlanVersionRepository planVersionRepository,
                             ScheduleOperationRepository scheduleOperationRepository,
                             InputSnapshotRepository inputSnapshotRepository,
                             AlgorithmClient algorithmClient,
                             AuditService auditService,
                             PlanStateMachine planStateMachine,
                             ValidateRequestFactory validateRequestFactory,
                             PlanVersionMapper planVersionMapper) {
        this.planVersionRepository = planVersionRepository;
        this.scheduleOperationRepository = scheduleOperationRepository;
        this.inputSnapshotRepository = inputSnapshotRepository;
        this.algorithmClient = algorithmClient;
        this.auditService = auditService;
        this.planStateMachine = planStateMachine;
        this.validateRequestFactory = validateRequestFactory;
        this.planVersionMapper = planVersionMapper;
    }

    private PlanVersion find(String idOrCode) {
        return LookupSupport.byIdOrCode(idOrCode, planVersionRepository::findById,
                planVersionRepository::findByVersionCode, "计划版本不存在");
    }

    public PlanVersionSummaryResponse submitReview(String idOrCode, SubmitReviewRequest req) {
        PlanVersion pv = find(idOrCode);
        if (req == null || req.version() == null) {
            throw BizException.validation("请求体必须包含 version");
        }
        if (!req.version().equals(pv.getVersion())) {
            throw BizException.versionStale("version 不匹配，请刷新后重试");
        }
        planStateMachine.assertTransition(pv.getStatus(), PlanStateMachine.REVIEW_PENDING);
        // 约束复核是远程 HTTP 调用（算法服务超时上限 620s），必须放在事务外执行，
        // 避免复核期间长时间占用数据库连接；复核失败的原异常类型保持不变
        revalidateOrThrow(pv);
        return self.persistSubmitReview(pv.getId(), req.version());
    }

    @Transactional
    public PlanVersionSummaryResponse persistSubmitReview(String planVersionId, Long version) {
        PlanVersion pv = planVersionRepository.findById(planVersionId)
                .orElseThrow(() -> BizException.notFound("计划版本不存在: " + planVersionId));
        if (!version.equals(pv.getVersion())) {
            throw BizException.versionStale("version 不匹配，请刷新后重试");
        }
        planStateMachine.assertTransition(pv.getStatus(), PlanStateMachine.REVIEW_PENDING);
        pv.setStatus(PlanStateMachine.REVIEW_PENDING);
        planVersionRepository.saveAndFlush(pv);
        auditService.record("PLAN_SUBMIT_REVIEW", "plan_version", pv.getId(), pv.getVersionCode());
        return planVersionMapper.toSummary(pv);
    }

    @Transactional
    public PlanVersionSummaryResponse revise(String idOrCode, SubmitReviewRequest req) {
        PlanVersion pv = find(idOrCode);
        if (req == null || req.version() == null) {
            throw BizException.validation("请求体必须包含 version");
        }
        if (!req.version().equals(pv.getVersion())) {
            throw BizException.versionStale("version 不匹配，请刷新后重试");
        }
        planStateMachine.assertTransition(pv.getStatus(), PlanStateMachine.DRAFT);
        pv.setStatus(PlanStateMachine.DRAFT);
        planVersionRepository.saveAndFlush(pv);
        auditService.record("PLAN_REVISE", "plan_version", pv.getId(), pv.getVersionCode());
        return planVersionMapper.toSummary(pv);
    }

    private void revalidateOrThrow(PlanVersion pv) {
        if (pv.getTaskId() == null) {
            return;
        }
        InputSnapshot snapshot = inputSnapshotRepository.findByTaskId(pv.getTaskId()).orElse(null);
        if (snapshot == null) {
            return;
        }
        Map<String, Object> snap = snapshot.getSnapshotJson();
        Map<String, Object> validateRequest = validateRequestFactory.baseFromSnapshot(snap);
        List<Map<String, Object>> ops = new ArrayList<>();
        for (ScheduleOperation op : scheduleOperationRepository.findByPlanVersionId(pv.getId())) {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("operationId", op.getOperationId());
            entry.put("machineId", op.getMachineId());
            entry.put("startAt", op.getStartAt().toString());
            entry.put("endAt", op.getEndAt().toString());
            entry.put("changeoverMinutes", op.getChangeoverMinutes());
            ops.add(entry);
        }
        validateRequest.put("operations", ops);
        JsonNode validation = algorithmClient.validate(validateRequest);
        if (!validation.path("passed").asBoolean(false)) {
            throw BizException.infeasible("提交前约束复核未通过: " + validation.path("conflicts"));
        }
    }

    @Transactional
    public PlanVersionSummaryResponse review(String idOrCode, ReviewRequest req) {
        PlanVersion pv = find(idOrCode);
        if (req == null || req.decision() == null
                || (!"APPROVE".equals(req.decision()) && !"REJECT".equals(req.decision()))) {
            throw BizException.validation("decision 必须是 APPROVE / REJECT");
        }
        if ("REJECT".equals(req.decision()) && (req.comment() == null || req.comment().isBlank())) {
            throw BizException.validation("REJECT 必须填写 comment");
        }
        if (req.version() == null || !req.version().equals(pv.getVersion())) {
            throw BizException.versionStale("version 不匹配，请刷新后重试");
        }
        String target = "APPROVE".equals(req.decision())
                ? PlanStateMachine.REVIEWED : PlanStateMachine.REJECTED;
        planStateMachine.assertTransition(pv.getStatus(), target);
        pv.setStatus(target);
        pv.setReviewComment(req.comment());
        pv.setReviewedBy(RequestContext.operator());
        pv.setReviewedAt(OffsetDateTime.now());
        planVersionRepository.saveAndFlush(pv);
        auditService.record("PLAN_REVIEW_" + req.decision(), "plan_version", pv.getId(),
                pv.getVersionCode() + " comment=" + req.comment());
        return planVersionMapper.toSummary(pv);
    }
}
