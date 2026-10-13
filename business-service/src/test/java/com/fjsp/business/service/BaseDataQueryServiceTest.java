package com.fjsp.business.service;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Optional;

import com.fjsp.business.common.BizException;
import com.fjsp.business.dto.OrderPositionResponse;
import com.fjsp.business.entity.ExecutionRecord;
import com.fjsp.business.entity.ExecutionStatus;
import com.fjsp.business.entity.OperationStatus;
import com.fjsp.business.entity.OrderOperation;
import com.fjsp.business.entity.PlanVersion;
import com.fjsp.business.entity.ProductionOrder;
import com.fjsp.business.entity.ScheduleOperation;
import com.fjsp.business.repository.ExecutionRecordRepository;
import com.fjsp.business.repository.MachineRepository;
import com.fjsp.business.repository.OrderOperationRepository;
import com.fjsp.business.repository.ProcessOperationRepository;
import com.fjsp.business.repository.ProcessTemplateRepository;
import com.fjsp.business.repository.ProductionOrderRepository;
import com.fjsp.business.repository.ScheduleOperationRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class BaseDataQueryServiceTest {

    @Mock
    private MachineRepository machineRepository;
    @Mock
    private ProductionOrderRepository productionOrderRepository;
    @Mock
    private OrderOperationRepository orderOperationRepository;
    @Mock
    private ProcessTemplateRepository processTemplateRepository;
    @Mock
    private ProcessOperationRepository processOperationRepository;
    @Mock
    private ScheduleOperationRepository scheduleOperationRepository;
    @Mock
    private ExecutionRecordRepository executionRecordRepository;
    @Mock
    private ImpactCalculator impactCalculator;

    private BaseDataQueryService service;

    @BeforeEach
    void setUp() {
        service = new BaseDataQueryService(machineRepository, productionOrderRepository, orderOperationRepository,
                processTemplateRepository, processOperationRepository, scheduleOperationRepository,
                executionRecordRepository, impactCalculator);
    }

    private ProductionOrder order() {
        ProductionOrder order = new ProductionOrder();
        order.setId("ord-1");
        order.setOrderCode("O001");
        order.setProductFamily("F1");
        order.setQuantity(10);
        order.setPriority(5);
        order.setStatus("RUNNING");
        return order;
    }

    private OrderOperation op(String id, int sequenceNo, String status) {
        OrderOperation op = new OrderOperation();
        op.setId(id);
        op.setOrderId("ord-1");
        op.setSequenceNo(sequenceNo);
        op.setStatus(status);
        return op;
    }

    private ScheduleOperation scheduled(String operationId, String machineId, String startAt, String endAt) {
        ScheduleOperation so = new ScheduleOperation();
        so.setOperationId(operationId);
        so.setMachineId(machineId);
        so.setStartAt(OffsetDateTime.parse(startAt));
        so.setEndAt(OffsetDateTime.parse(endAt));
        return so;
    }

    private void stubOrderFoundByCode() {
        when(productionOrderRepository.findById("O001")).thenReturn(Optional.empty());
        when(productionOrderRepository.findByOrderCode("O001")).thenReturn(Optional.of(order()));
    }

    @Test
    void aggregatesPositionWithPublishedPlan() {
        stubOrderFoundByCode();
        when(orderOperationRepository.findByOrderIdOrderBySequenceNo("ord-1")).thenReturn(List.of(
                op("op-1", 1, OperationStatus.COMPLETED),
                op("op-2", 2, OperationStatus.RUNNING),
                op("op-3", 3, OperationStatus.NOT_STARTED)));

        PlanVersion plan = new PlanVersion();
        plan.setId("pv-1");
        plan.setStatus("PUBLISHED");
        when(impactCalculator.currentPublishedPlan()).thenReturn(plan);
        when(scheduleOperationRepository.findByPlanVersionId("pv-1")).thenReturn(List.of(
                scheduled("op-1", "M01", "2026-10-13T08:00:00+08:00", "2026-10-13T10:00:00+08:00"),
                scheduled("op-2", "M02", "2026-10-13T10:00:00+08:00", "2026-10-13T12:00:00+08:00"),
                scheduled("op-3", "M01", "2026-10-13T12:00:00+08:00", "2026-10-13T14:00:00+08:00")));

        ExecutionRecord running = new ExecutionRecord();
        running.setOperationId("op-2");
        running.setStatus(ExecutionStatus.RUNNING);
        running.setActualStartAt(OffsetDateTime.parse("2026-10-13T10:05:00+08:00"));
        when(executionRecordRepository.findFirstByOperationIdAndStatusAndActualEndAtIsNull(
                "op-2", ExecutionStatus.RUNNING)).thenReturn(Optional.of(running));

        OrderPositionResponse data = service.orderPosition("O001");

        assertEquals("ord-1", data.orderId());
        assertEquals("O001", data.orderCode());
        assertTrue(data.planPublished());
        assertEquals("pv-1", data.planVersionId());
        assertEquals(3, data.totalOperations());
        assertEquals(1, data.completedOperations());
        assertEquals(2, data.remainingOperations());
        assertEquals(33, data.progressPercent());

        assertEquals("op-2", data.currentOperation().operationId());
        assertEquals(2, data.currentOperation().sequenceNo());
        assertEquals(OperationStatus.RUNNING, data.currentOperation().status());
        assertEquals("M02", data.currentOperation().machineId());
        assertEquals(OffsetDateTime.parse("2026-10-13T10:00:00+08:00"),
                data.currentOperation().plannedStartAt());
        assertEquals(OffsetDateTime.parse("2026-10-13T10:05:00+08:00"),
                data.currentOperation().actualStartAt());

        assertEquals("op-3", data.nextOperation().operationId());
        assertEquals("M01", data.nextOperation().machineId());
        assertEquals(OffsetDateTime.parse("2026-10-13T12:00:00+08:00"),
                data.nextOperation().plannedStartAt());

        assertEquals(3, data.operations().size());
        assertEquals("M01", data.operations().get(0).machineId());
        assertNull(data.operations().get(0).actualStartAt());
    }

    @Test
    void resolvesOrderByIdAndReportsNullPlanFieldsWhenNoPublishedPlan() {
        when(productionOrderRepository.findById("ord-1")).thenReturn(Optional.of(order()));
        when(orderOperationRepository.findByOrderIdOrderBySequenceNo("ord-1")).thenReturn(List.of(
                op("op-1", 1, OperationStatus.COMPLETED),
                op("op-2", 2, OperationStatus.NOT_STARTED)));
        when(impactCalculator.currentPublishedPlan()).thenReturn(null);

        OrderPositionResponse data = service.orderPosition("ord-1");

        assertFalse(data.planPublished());
        assertNull(data.planVersionId());
        assertNull(data.currentOperation());
        assertEquals("op-2", data.nextOperation().operationId());
        assertNull(data.nextOperation().machineId());
        assertNull(data.nextOperation().plannedStartAt());
        assertEquals(50, data.progressPercent());
        assertEquals(1, data.remainingOperations());
        assertNull(data.operations().get(0).machineId());
    }

    @Test
    void rejectsUnknownOrderRef() {
        when(productionOrderRepository.findById("nope")).thenReturn(Optional.empty());
        when(productionOrderRepository.findByOrderCode("nope")).thenReturn(Optional.empty());

        assertThrows(BizException.class, () -> service.orderPosition("nope"));
    }
}
