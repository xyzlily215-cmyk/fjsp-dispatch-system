package com.fjsp.business.service;

import java.nio.charset.StandardCharsets;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import com.fjsp.business.common.BizException;
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
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class PlanExportServiceTest {

    @Mock
    private PlanVersionRepository planVersionRepository;
    @Mock
    private ScheduleOperationRepository scheduleOperationRepository;
    @Mock
    private OrderOperationRepository orderOperationRepository;
    @Mock
    private ProductionOrderRepository productionOrderRepository;
    @Mock
    private ExecutionRecordRepository executionRecordRepository;
    @Mock
    private AuditService auditService;

    @InjectMocks
    private PlanExportService planExportService;

    private PlanVersion plan() {
        PlanVersion pv = new PlanVersion();
        pv.setId("P1");
        pv.setVersionCode("PV-001");
        pv.setStatus("PUBLISHED");
        pv.setCandidateType("BASELINE");
        pv.setKpi(Map.of("cMaxMinutes", 600, "weightedTardinessMinutes", 30, "nTardy", 1,
                "deltaPlan", Map.of("deltaPlan", 0.125)));
        return pv;
    }

    private ScheduleOperation op(String opId, String machineId, String startAt, String endAt) {
        ScheduleOperation op = new ScheduleOperation();
        op.setPlanVersionId("P1");
        op.setOperationId(opId);
        op.setMachineId(machineId);
        op.setStartAt(OffsetDateTime.parse(startAt));
        op.setEndAt(OffsetDateTime.parse(endAt));
        op.setChangeoverMinutes(0);
        return op;
    }

    private OrderOperation orderOp(String opId, String orderId, int seq, String status) {
        OrderOperation oo = new OrderOperation();
        oo.setId(opId);
        oo.setOrderId(orderId);
        oo.setSequenceNo(seq);
        oo.setStatus(status);
        return oo;
    }

    private ProductionOrder order(String id, String code) {
        ProductionOrder o = new ProductionOrder();
        o.setId(id);
        o.setOrderCode(code);
        o.setProductFamily("轴类A");
        o.setQuantity(10);
        o.setPriority(3);
        o.setArrivalAt(OffsetDateTime.parse("2026-09-16T08:00:00+08:00"));
        o.setDueAt(OffsetDateTime.parse("2026-09-17T18:00:00+08:00"));
        return o;
    }

    @Test
    void exportPlanCsv_containsBomKpiAndOperationRows() {
        when(planVersionRepository.findById("P1")).thenReturn(Optional.of(plan()));
        when(scheduleOperationRepository.findByPlanVersionId("P1"))
                .thenReturn(List.of(
                        op("ORD-1-20", "M2", "2026-09-16T09:00:00+08:00", "2026-09-16T10:00:00+08:00"),
                        op("ORD-1-10", "M1", "2026-09-16T08:00:00+08:00", "2026-09-16T09:00:00+08:00")));
        when(orderOperationRepository.findAllById(any()))
                .thenReturn(List.of(orderOp("ORD-1-10", "ORD-1", 10, "COMPLETED"),
                        orderOp("ORD-1-20", "ORD-1", 20, "NOT_STARTED")));
        when(productionOrderRepository.findAllById(any())).thenReturn(List.of(order("ORD-1", "ORD-1")));
        ExecutionRecord rec = new ExecutionRecord();
        rec.setOperationId("ORD-1-10");
        rec.setStatus("COMPLETED");
        rec.setDeviationMinutes(20);
        when(executionRecordRepository.findByOperationIdIn(any())).thenReturn(List.of(rec));

        PlanExportService.ExportFile file = planExportService.exportPlanCsv("P1");

        assertEquals("plan-PV-001.csv", file.filename());
        byte[] content = file.content();
        // UTF-8 BOM: EF BB BF
        assertEquals((byte) 0xEF, content[0]);
        assertEquals((byte) 0xBB, content[1]);
        assertEquals((byte) 0xBF, content[2]);
        String csv = new String(content, StandardCharsets.UTF_8);
        assertTrue(csv.startsWith("\uFEFF# 计划版本导出"));
        assertTrue(csv.contains("版本号,PV-001"));
        assertTrue(csv.contains("C_max(分钟),600"));
        assertTrue(csv.contains("加权拖期(分钟),30"));
        assertTrue(csv.contains("延期订单数,1"));
        assertTrue(csv.contains("计划扰动Delta_plan,0.125"));
        assertTrue(csv.contains("订单号,产品族,优先级,交期,工序序号,工序ID,设备,准备开始,加工开始,"
                + "计划开始,计划结束,换型分钟,冻结,受影响,原因码,执行状态,执行偏差分钟"));
        // 行按 startAt 排序：ORD-1-10 先于 ORD-1-20
        int first = csv.indexOf("ORD-1,轴类A,3,2026-09-17 18:00,10,ORD-1-10,M1");
        int second = csv.indexOf("ORD-1,轴类A,3,2026-09-17 18:00,20,ORD-1-20,M2");
        assertTrue(first > 0 && second > first);
        assertTrue(csv.contains("ORD-1-10,M1,,,2026-09-16 08:00,2026-09-16 09:00,0,否,否,,COMPLETED,20"));
        verify(auditService).record(eq("PLAN_EXPORT"), eq("plan_version"), eq("P1"), any());
    }

    @Test
    void exportPlanCsv_escapesCommaQuoteAndFormulaPrefix() {
        when(planVersionRepository.findById("P1")).thenReturn(Optional.of(plan()));
        ScheduleOperation op = op("ORD-1-10", "M1",
                "2026-09-16T08:00:00+08:00", "2026-09-16T09:00:00+08:00");
        op.setFrozen(true);
        op.setAffected(true);
        op.setReasonCode("A,B\"C");
        when(scheduleOperationRepository.findByPlanVersionId("P1")).thenReturn(List.of(op));
        when(orderOperationRepository.findAllById(any()))
                .thenReturn(List.of(orderOp("ORD-1-10", "ORD-1", 10, "NOT_STARTED")));
        ProductionOrder order = order("ORD-1", "=CMD||=cmd");
        when(productionOrderRepository.findAllById(any())).thenReturn(List.of(order));
        when(executionRecordRepository.findByOperationIdIn(any())).thenReturn(List.of());

        String csv = new String(planExportService.exportPlanCsv("P1").content(), StandardCharsets.UTF_8);

        // 以 = 开头的文本被加 ' 前缀防公式注入；含逗号/引号的单元格被引号包裹且引号转义
        assertTrue(csv.contains("'=CMD||=cmd"));
        assertTrue(csv.contains("\"A,B\"\"C\""));
        assertTrue(csv.contains(",是,是,"));
    }

    @Test
    void exportPlanCsv_unknownVersion_notFound() {
        when(planVersionRepository.findById("nope")).thenReturn(Optional.empty());
        when(planVersionRepository.findByVersionCode("nope")).thenReturn(Optional.empty());

        BizException e = assertThrows(BizException.class, () -> planExportService.exportPlanCsv("nope"));
        assertEquals("E_NOT_FOUND", e.getCode());
    }
}
