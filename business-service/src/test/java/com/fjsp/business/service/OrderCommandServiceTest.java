package com.fjsp.business.service;

import java.time.OffsetDateTime;
import java.util.Optional;
import java.util.function.Supplier;

import com.fjsp.business.common.BizException;
import com.fjsp.business.dto.OrderResponse;
import com.fjsp.business.dto.OrderUpdateRequest;
import com.fjsp.business.entity.ProductionOrder;
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
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** F-04 订单直接编辑：已排程订单仅允许改备注，工艺字段变更必须走修订流程。 */
@ExtendWith(MockitoExtension.class)
class OrderCommandServiceTest {

    @Mock
    private ProcessTemplateRepository processTemplateRepository;
    @Mock
    private ProcessOperationRepository processOperationRepository;
    @Mock
    private ProductionOrderRepository productionOrderRepository;
    @Mock
    private OrderOperationRepository orderOperationRepository;
    @Mock
    private ScheduleOperationRepository scheduleOperationRepository;
    @Mock
    private IdempotencyService idempotencyService;
    @Mock
    private AuditService auditService;

    private OrderCommandService service;

    @BeforeEach
    void setUp() {
        OrderSupport orderSupport = new OrderSupport(productionOrderRepository, scheduleOperationRepository);
        service = new OrderCommandService(processTemplateRepository, processOperationRepository,
                productionOrderRepository, orderOperationRepository,
                orderSupport, idempotencyService, auditService);
    }

    /** 写接口统一走 idempotencyService.execute 模板：测试替身直接执行 action。 */
    private void stubExecuteRunsAction() {
        when(idempotencyService.execute(anyString(), any(), any(), any()))
                .thenAnswer(inv -> ((Supplier<Object>) inv.getArgument(2)).get());
    }

    private ProductionOrder order(String status) {
        ProductionOrder order = new ProductionOrder();
        order.setId("ORD-1");
        order.setOrderCode("ORD-1");
        order.setProductFamily("齿轮A");
        order.setQuantity(20);
        order.setPriority(3);
        order.setArrivalAt(OffsetDateTime.parse("2026-09-16T08:00:00+08:00"));
        order.setDueAt(OffsetDateTime.parse("2026-09-18T08:00:00+08:00"));
        order.setStatus(status);
        order.setTemplateId("TPL-1");
        return order;
    }

    @Test
    void updateOrder_scheduledOrderProcessField_rejected() {
        stubExecuteRunsAction();
        ProductionOrder scheduled = order("SCHEDULED");
        when(productionOrderRepository.findById("ORD-1")).thenReturn(Optional.of(scheduled));

        BizException e = assertThrows(BizException.class, () -> service.updateOrder("k", "ORD-1",
                new OrderUpdateRequest(30, null, null, null, null)));

        assertEquals("E_STATE_CONFLICT", e.getCode());
        assertEquals(20, scheduled.getQuantity());
    }

    @Test
    void updateOrder_scheduledOrderRemarkOnly_allowed() {
        stubExecuteRunsAction();
        ProductionOrder scheduled = order("SCHEDULED");
        when(productionOrderRepository.findById("ORD-1")).thenReturn(Optional.of(scheduled));

        OrderResponse data = service.updateOrder("k", "ORD-1",
                new OrderUpdateRequest(null, null, null, null, "客户要求优先沟通"));

        assertEquals("客户要求优先沟通", scheduled.getRemark());
        assertEquals("客户要求优先沟通", data.remark());
        verify(productionOrderRepository).save(scheduled);
    }

    @Test
    void updateOrder_waitingOrder_directEditWithRemark() {
        stubExecuteRunsAction();
        ProductionOrder waiting = order("WAITING");
        when(productionOrderRepository.findById("ORD-1")).thenReturn(Optional.of(waiting));
        when(scheduleOperationRepository.existsScheduledByOrderId("ORD-1")).thenReturn(false);

        OrderResponse data = service.updateOrder("k", "ORD-1",
                new OrderUpdateRequest(50, 4, null, null, "试产单"));

        assertEquals(50, waiting.getQuantity());
        assertEquals(4, waiting.getPriority());
        assertEquals("试产单", data.remark());
    }
}
