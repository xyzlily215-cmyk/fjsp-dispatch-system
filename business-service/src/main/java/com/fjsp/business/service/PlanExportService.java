package com.fjsp.business.service;

import java.nio.charset.StandardCharsets;
import java.time.OffsetDateTime;
import java.time.format.DateTimeFormatter;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.stream.Collectors;

import com.fjsp.business.common.LookupSupport;
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

/**
 * 计划版本 CSV 导出（F-09 数据导出）：UTF-8 with BOM，KPI 摘要 + 工序明细。
 * 导出行为本身写审计（PLAN_EXPORT）；权限与现有 GET 读接口一致（登录即可，
 * 系统当前未实现更细粒度数据范围过滤）。
 */
@Service
public class PlanExportService {

    private static final String CRLF = "\r\n";
    private static final DateTimeFormatter FMT = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm");

    private final PlanVersionRepository planVersionRepository;
    private final ScheduleOperationRepository scheduleOperationRepository;
    private final OrderOperationRepository orderOperationRepository;
    private final ProductionOrderRepository productionOrderRepository;
    private final ExecutionRecordRepository executionRecordRepository;
    private final AuditService auditService;

    public PlanExportService(PlanVersionRepository planVersionRepository,
                             ScheduleOperationRepository scheduleOperationRepository,
                             OrderOperationRepository orderOperationRepository,
                             ProductionOrderRepository productionOrderRepository,
                             ExecutionRecordRepository executionRecordRepository,
                             AuditService auditService) {
        this.planVersionRepository = planVersionRepository;
        this.scheduleOperationRepository = scheduleOperationRepository;
        this.orderOperationRepository = orderOperationRepository;
        this.productionOrderRepository = productionOrderRepository;
        this.executionRecordRepository = executionRecordRepository;
        this.auditService = auditService;
    }

    public record ExportFile(String filename, byte[] content) {
    }

    public ExportFile exportPlanCsv(String idOrCode) {
        PlanVersion pv = LookupSupport.byIdOrCode(idOrCode, planVersionRepository::findById,
                planVersionRepository::findByVersionCode, "计划版本不存在");
        List<ScheduleOperation> ops = scheduleOperationRepository.findByPlanVersionId(pv.getId())
                .stream()
                .sorted(Comparator.comparing(ScheduleOperation::getStartAt)
                        .thenComparing(ScheduleOperation::getOperationId))
                .toList();
        List<String> opIds = ops.stream().map(ScheduleOperation::getOperationId).toList();
        Map<String, OrderOperation> orderOpById = new HashMap<>();
        for (OrderOperation oo : opIds.isEmpty() ? List.<OrderOperation>of()
                : orderOperationRepository.findAllById(opIds)) {
            orderOpById.put(oo.getId(), oo);
        }
        List<String> orderIds = orderOpById.values().stream().map(OrderOperation::getOrderId)
                .distinct().toList();
        Map<String, ProductionOrder> orderById = new HashMap<>();
        for (ProductionOrder order : orderIds.isEmpty() ? List.<ProductionOrder>of()
                : productionOrderRepository.findAllById(orderIds)) {
            orderById.put(order.getId(), order);
        }
        Map<String, List<ExecutionRecord>> recordsByOp = opIds.isEmpty() ? Map.of()
                : executionRecordRepository.findByOperationIdIn(opIds).stream()
                        .collect(Collectors.groupingBy(ExecutionRecord::getOperationId));

        StringBuilder sb = new StringBuilder("\uFEFF");
        sb.append("# 计划版本导出").append(CRLF);
        sb.append(row("版本号", pv.getVersionCode()));
        sb.append(row("状态", pv.getStatus()));
        sb.append(row("候选类型", pv.getCandidateType()));
        sb.append(row("创建时间", fmt(pv.getCreatedAt())));
        sb.append(row("发布时间", fmt(pv.getPublishedAt())));
        sb.append(row("导出时间", fmt(OffsetDateTime.now())));
        Map<String, Object> kpi = pv.getKpi() != null ? pv.getKpi() : Map.of();
        sb.append(row("C_max(分钟)", kpi.get("cMaxMinutes")));
        sb.append(row("加权拖期(分钟)", kpi.get("weightedTardinessMinutes")));
        sb.append(row("延期订单数", kpi.get("nTardy")));
        Object delta = kpi.get("deltaPlan");
        if (delta instanceof Map<?, ?> deltaMap) {
            sb.append(row("计划扰动Delta_plan", deltaMap.get("deltaPlan")));
        }
        sb.append(CRLF);
        sb.append("# 工序明细").append(CRLF);
        sb.append(row("订单号", "产品族", "优先级", "交期", "工序序号", "工序ID", "设备",
                "准备开始", "加工开始", "计划开始", "计划结束", "换型分钟",
                "冻结", "受影响", "原因码", "执行状态", "执行偏差分钟"));
        for (ScheduleOperation op : ops) {
            OrderOperation orderOp = orderOpById.get(op.getOperationId());
            ProductionOrder order = orderOp != null ? orderById.get(orderOp.getOrderId()) : null;
            List<ExecutionRecord> records = recordsByOp.getOrDefault(op.getOperationId(), List.of());
            Integer deviation = records.stream().map(ExecutionRecord::getDeviationMinutes)
                    .filter(Objects::nonNull).max(Integer::compareTo).orElse(null);
            sb.append(row(
                    order != null ? order.getOrderCode() : null,
                    order != null ? order.getProductFamily() : null,
                    order != null ? order.getPriority() : null,
                    order != null ? fmt(order.getDueAt()) : null,
                    orderOp != null ? orderOp.getSequenceNo() : null,
                    op.getOperationId(),
                    op.getMachineId(),
                    fmt(op.getSetupStartAt()),
                    fmt(op.getProcessStartAt()),
                    fmt(op.getStartAt()),
                    fmt(op.getEndAt()),
                    op.getChangeoverMinutes(),
                    Boolean.TRUE.equals(op.getFrozen()) ? "是" : "否",
                    Boolean.TRUE.equals(op.getAffected()) ? "是" : "否",
                    op.getReasonCode(),
                    orderOp != null ? orderOp.getStatus() : null,
                    deviation));
        }
        auditService.record("PLAN_EXPORT", "plan_version", pv.getId(),
                pv.getVersionCode() + " rows=" + ops.size());
        String filename = "plan-" + pv.getVersionCode().replaceAll("[^A-Za-z0-9_-]", "_") + ".csv";
        return new ExportFile(filename, sb.toString().getBytes(StandardCharsets.UTF_8));
    }

    private static String row(Object... cells) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < cells.length; i++) {
            if (i > 0) {
                sb.append(',');
            }
            sb.append(cell(cells[i]));
        }
        return sb.append(CRLF).toString();
    }

    /** CSV 转义；文本以 = + - @ 开头时加 ' 前缀，避免 Excel 打开时被当作公式执行。 */
    private static String cell(Object v) {
        if (v == null) {
            return "";
        }
        String s = String.valueOf(v);
        if (!s.isEmpty() && "=+-@".indexOf(s.charAt(0)) >= 0 && !isNumeric(s)) {
            s = "'" + s;
        }
        if (s.contains(",") || s.contains("\"") || s.contains("\n") || s.contains("\r")) {
            s = '"' + s.replace("\"", "\"\"") + '"';
        }
        return s;
    }

    private static boolean isNumeric(String s) {
        try {
            Double.parseDouble(s);
            return true;
        } catch (NumberFormatException e) {
            return false;
        }
    }

    private static String fmt(OffsetDateTime t) {
        return t != null ? t.format(FMT) : null;
    }
}
