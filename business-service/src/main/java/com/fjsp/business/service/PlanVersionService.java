package com.fjsp.business.service;

import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

import com.fasterxml.jackson.databind.JsonNode;
import com.fjsp.business.client.AlgorithmClient;
import com.fjsp.business.common.BizException;
import com.fjsp.business.common.RequestContext;
import com.fjsp.business.dto.PublishRequest;
import com.fjsp.business.dto.ReviewRequest;
import com.fjsp.business.dto.SubmitReviewRequest;
import com.fjsp.business.entity.EventImpact;
import com.fjsp.business.entity.InputSnapshot;
import com.fjsp.business.entity.PlanVersion;
import com.fjsp.business.entity.ProductionOrder;
import com.fjsp.business.entity.ScheduleOperation;
import com.fjsp.business.entity.OrderOperation;
import com.fjsp.business.repository.EventImpactRepository;
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
public class PlanVersionService {

    private static final Logger log = LoggerFactory.getLogger(PlanVersionService.class);

    private final PlanVersionRepository planVersionRepository;
    private final ScheduleOperationRepository scheduleOperationRepository;
    private final InputSnapshotRepository inputSnapshotRepository;
    private final EventImpactRepository eventImpactRepository;
    private final ProductionOrderRepository productionOrderRepository;
    private final OrderOperationRepository orderOperationRepository;
    private final EventRepository eventRepository;
    private final AlgorithmClient algorithmClient;
    private final AuditService auditService;
    private final PlanStateMachine planStateMachine;
    private final ScheduleIntegrityGuard integrityGuard;

    public PlanVersionService(PlanVersionRepository planVersionRepository,
                              ScheduleOperationRepository scheduleOperationRepository,
                              InputSnapshotRepository inputSnapshotRepository,
                              EventImpactRepository eventImpactRepository,
                              ProductionOrderRepository productionOrderRepository,
                              OrderOperationRepository orderOperationRepository,
                              EventRepository eventRepository,
                              AlgorithmClient algorithmClient,
                              AuditService auditService,
                              PlanStateMachine planStateMachine,
                              ScheduleIntegrityGuard integrityGuard) {
        this.planVersionRepository = planVersionRepository;
        this.scheduleOperationRepository = scheduleOperationRepository;
        this.inputSnapshotRepository = inputSnapshotRepository;
        this.eventImpactRepository = eventImpactRepository;
        this.productionOrderRepository = productionOrderRepository;
        this.orderOperationRepository = orderOperationRepository;
        this.eventRepository = eventRepository;
        this.algorithmClient = algorithmClient;
        this.auditService = auditService;
        this.planStateMachine = planStateMachine;
        this.integrityGuard = integrityGuard;
    }

    public PlanVersion find(String idOrCode) {
        return planVersionRepository.findById(idOrCode)
                .or(() -> planVersionRepository.findByVersionCode(idOrCode))
                .orElseThrow(() -> BizException.notFound("计划版本不存在: " + idOrCode));
    }

    public List<Map<String, Object>> list() {
        List<Map<String, Object>> result = new ArrayList<>();
        for (PlanVersion pv : planVersionRepository.findAllByOrderByCreatedAtDesc()) {
            result.add(toSummary(pv));
        }
        return result;
    }

    public Map<String, Object> detail(String idOrCode) {
        PlanVersion pv = find(idOrCode);
        Map<String, Object> data = toSummary(pv);
        data.put("reviewComment", pv.getReviewComment());
        List<Map<String, Object>> ops = new ArrayList<>();
        for (ScheduleOperation op : scheduleOperationRepository.findByPlanVersionId(pv.getId())) {
            ops.add(toOperationMap(op));
        }
        ops.sort(Comparator.comparing(o -> (String) o.get("operationId")));
        data.put("operations", ops);
        return data;
    }

    private Map<String, Object> toSummary(PlanVersion pv) {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("id", pv.getId());
        map.put("versionCode", pv.getVersionCode());
        map.put("parentId", pv.getParentId());
        map.put("candidateGroupId", pv.getCandidateGroupId());
        map.put("candidateType", pv.getCandidateType());
        map.put("status", pv.getStatus());
        map.put("taskId", pv.getTaskId());
        map.put("kpi", pv.getKpi());
        map.put("version", pv.getVersion());
        map.put("reviewComment", pv.getReviewComment());
        map.put("reviewedBy", pv.getReviewedBy());
        map.put("reviewedAt", pv.getReviewedAt());
        map.put("publishedBy", pv.getPublishedBy());
        map.put("publishedAt", pv.getPublishedAt());
        map.put("createdAt", pv.getCreatedAt());
        return map;
    }

    private Map<String, Object> toOperationMap(ScheduleOperation op) {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("operationId", op.getOperationId());
        map.put("machineId", op.getMachineId());
        map.put("setupStartAt", op.getSetupStartAt());
        map.put("processStartAt", op.getProcessStartAt());
        map.put("startAt", op.getStartAt());
        map.put("endAt", op.getEndAt());
        map.put("changeoverMinutes", op.getChangeoverMinutes());
        map.put("frozen", op.getFrozen());
        map.put("affected", op.getAffected());
        map.put("reasonCode", op.getReasonCode());
        return map;
    }

    public Map<String, Object> diff(String idOrCode, String baselineIdOrCode) {
        PlanVersion candidate = find(idOrCode);
        PlanVersion baseline = find(baselineIdOrCode);
        Map<String, ScheduleOperation> baseOps = scheduleOperationRepository
                .findByPlanVersionId(baseline.getId()).stream()
                .collect(Collectors.toMap(ScheduleOperation::getOperationId, o -> o));
        Map<String, ScheduleOperation> candOps = scheduleOperationRepository
                .findByPlanVersionId(candidate.getId()).stream()
                .collect(Collectors.toMap(ScheduleOperation::getOperationId, o -> o));

        Map<String, String> impactTypeByOp = new HashMap<>();
        for (EventImpact impact : eventImpactRepository.findAll()) {
            impactTypeByOp.putIfAbsent(impact.getOperationId(), impact.getImpactType());
        }

        Map<String, Map<String, Integer>> baseSeqRank = sequenceRanks(new ArrayList<>(baseOps.values()));
        Map<String, Map<String, Integer>> candSeqRank = sequenceRanks(new ArrayList<>(candOps.values()));

        List<Map<String, Object>> diffs = new ArrayList<>();
        List<String> added = new ArrayList<>();
        List<String> removed = new ArrayList<>();
        int shifted = 0;
        int machineChanged = 0;
        int sequenceChanged = 0;

        for (ScheduleOperation cand : candOps.values()) {
            ScheduleOperation base = baseOps.get(cand.getOperationId());
            if (base == null) {
                added.add(cand.getOperationId());
                continue;
            }
            long shift = Duration.between(base.getStartAt().toInstant(),
                    cand.getStartAt().toInstant()).toMinutes();
            boolean machineChangedFlag = !base.getMachineId().equals(cand.getMachineId());
            Integer oldRank = rankOf(baseSeqRank, base);
            Integer newRank = rankOf(candSeqRank, cand);
            boolean seqChangedFlag = !machineChangedFlag && oldRank != null && newRank != null
                    && !oldRank.equals(newRank);
            if (shift != 0) {
                shifted++;
            }
            if (machineChangedFlag) {
                machineChanged++;
            }
            if (seqChangedFlag) {
                sequenceChanged++;
            }
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("operationId", cand.getOperationId());
            entry.put("timeShiftMinutes", shift);
            entry.put("machineChanged", machineChangedFlag);
            entry.put("sequenceChanged", seqChangedFlag);
            entry.put("oldMachineId", base.getMachineId());
            entry.put("newMachineId", cand.getMachineId());
            entry.put("oldStartAt", base.getStartAt());
            entry.put("newStartAt", cand.getStartAt());
            entry.put("frozen", cand.getFrozen());
            entry.put("reasonCode", cand.getReasonCode());
            entry.put("impactType", impactTypeByOp.get(cand.getOperationId()));
            diffs.add(entry);
        }
        for (String opId : baseOps.keySet()) {
            if (!candOps.containsKey(opId)) {
                removed.add(opId);
            }
        }
        diffs.sort(Comparator.comparing(d -> (String) d.get("operationId")));

        Map<String, Object> summary = new LinkedHashMap<>();
        summary.put("comparedOperations", diffs.size());
        summary.put("addedOperations", added);
        summary.put("removedOperations", removed);
        summary.put("timeShiftedCount", shifted);
        summary.put("machineChangedCount", machineChanged);
        summary.put("sequenceChangedCount", sequenceChanged);

        Map<String, Object> kpiDiff = new LinkedHashMap<>();
        Map<String, Object> baseKpi = baseline.getKpi() != null ? baseline.getKpi() : Map.of();
        Map<String, Object> candKpi = candidate.getKpi() != null ? candidate.getKpi() : Map.of();
        for (String key : candKpi.keySet()) {
            Object cv = candKpi.get(key);
            Object bv = baseKpi.get(key);
            if (cv instanceof Number && bv instanceof Number) {
                kpiDiff.put(key, ((Number) cv).doubleValue() - ((Number) bv).doubleValue());
            }
        }

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("baselineVersionId", baseline.getId());
        data.put("baselineVersionCode", baseline.getVersionCode());
        data.put("candidateVersionId", candidate.getId());
        data.put("candidateVersionCode", candidate.getVersionCode());
        data.put("summary", summary);
        data.put("kpiDiff", kpiDiff);
        data.put("operations", diffs);
        return data;
    }

    private Map<String, Map<String, Integer>> sequenceRanks(List<ScheduleOperation> ops) {
        Map<String, List<ScheduleOperation>> byMachine = ops.stream()
                .collect(Collectors.groupingBy(ScheduleOperation::getMachineId));
        Map<String, Map<String, Integer>> ranks = new HashMap<>();
        byMachine.forEach((machine, list) -> {
            list.sort(Comparator.comparing(ScheduleOperation::getStartAt));
            Map<String, Integer> rank = new HashMap<>();
            for (int i = 0; i < list.size(); i++) {
                rank.put(list.get(i).getOperationId(), i);
            }
            ranks.put(machine, rank);
        });
        return ranks;
    }

    private Integer rankOf(Map<String, Map<String, Integer>> ranks, ScheduleOperation op) {
        Map<String, Integer> machineRanks = ranks.get(op.getMachineId());
        return machineRankNullSafe(machineRanks, op.getOperationId());
    }

    private Integer machineRankNullSafe(Map<String, Integer> machineRanks, String opId) {
        return machineRanks == null ? null : machineRanks.get(opId);
    }

    @Transactional
    public Map<String, Object> submitReview(String idOrCode, SubmitReviewRequest req) {
        PlanVersion pv = find(idOrCode);
        if (req == null || req.version() == null) {
            throw BizException.validation("请求体必须包含 version");
        }
        if (!req.version().equals(pv.getVersion())) {
            throw BizException.versionStale("version 不匹配，请刷新后重试");
        }
        planStateMachine.assertTransition(pv.getStatus(), PlanStateMachine.REVIEW_PENDING);
        revalidateOrThrow(pv);
        pv.setStatus(PlanStateMachine.REVIEW_PENDING);
        planVersionRepository.saveAndFlush(pv);
        auditService.record("PLAN_SUBMIT_REVIEW", "plan_version", pv.getId(), pv.getVersionCode());
        return toSummary(pv);
    }

    @Transactional
    public Map<String, Object> revise(String idOrCode, SubmitReviewRequest req) {
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
        return toSummary(pv);
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
    public Map<String, Object> review(String idOrCode, ReviewRequest req) {
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
        return toSummary(pv);
    }

    @Transactional
    public Map<String, Object> publish(String idOrCode, PublishRequest req) {
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

        // orders covered by this plan become SCHEDULED
        Map<String, OrderOperation> opById = new HashMap<>();
        for (OrderOperation oo : orderOperationRepository.findAll()) {
            opById.put(oo.getId(), oo);
        }
        Map<String, ProductionOrder> touched = new HashMap<>();
        for (ScheduleOperation op : scheduleOperationRepository.findByPlanVersionId(pv.getId())) {
            OrderOperation oo = opById.get(op.getOperationId());
            if (oo != null) {
                productionOrderRepository.findById(oo.getOrderId()).ifPresent(o -> touched.put(o.getId(), o));
            }
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
        return toSummary(pv);
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
