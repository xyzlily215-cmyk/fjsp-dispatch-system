package com.fjsp.business.service;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.function.Supplier;

import com.fjsp.business.common.BizException;
import com.fjsp.business.dto.OrderRevisionRequest;
import com.fjsp.business.dto.OrderRevisionResultResponse;
import com.fjsp.business.entity.OrderOperation;
import com.fjsp.business.entity.OrderRevision;
import com.fjsp.business.entity.ProcessOperation;
import com.fjsp.business.entity.ProcessTemplate;
import com.fjsp.business.entity.ProductionOrder;
import com.fjsp.business.repository.OrderOperationRepository;
import com.fjsp.business.repository.OrderRevisionRepository;
import com.fjsp.business.repository.ProcessOperationRepository;
import com.fjsp.business.repository.ProcessTemplateRepository;
import com.fjsp.business.repository.ProductionOrderRepository;
import com.fjsp.business.repository.ScheduleOperationRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** F-04 订单修订控制：已排程订单的工艺字段变更必须走修订流程。 */
@ExtendWith(MockitoExtension.class)
class OrderRevisionServiceTest {

    @Mock
    private ProcessTemplateRepository processTemplateRepository;
    @Mock
    private ProcessOperationRepository processOperationRepository;
    @Mock
    private ProductionOrderRepository productionOrderRepository;
    @Mock
    private OrderOperationRepository orderOperationRepository;
    @Mock
    private OrderRevisionRepository orderRevisionRepository;
    @Mock
    private ScheduleOperationRepository scheduleOperationRepository;
    @Mock
    private IdempotencyService idempotencyService;
    @Mock
    private AuditService auditService;

    private OrderRevisionService service;

    @BeforeEach
    void setUp() {
        OrderSupport orderSupport = new OrderSupport(productionOrderRepository, scheduleOperationRepository);
        service = new OrderRevisionService(processTemplateRepository, processOperationRepository,
                productionOrderRepository, orderOperationRepository, orderRevisionRepository,
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
    void reviseOrder_reasonRequired() {
        stubExecuteRunsAction();
        BizException e = assertThrows(BizException.class, () -> service.reviseOrder("k", "ORD-1",
                new OrderRevisionRequest("  ", null, null, 30, null, null, null)));
        assertEquals("E_VALIDATION", e.getCode());
        verify(orderRevisionRepository, never()).save(any());
    }

    @Test
    void reviseOrder_waitingOrder_rejectedUseDirectEdit() {
        stubExecuteRunsAction();
        ProductionOrder waiting = order("WAITING");
        when(productionOrderRepository.findById("ORD-1")).thenReturn(Optional.of(waiting));
        when(scheduleOperationRepository.existsScheduledByOrderId("ORD-1")).thenReturn(false);

        BizException e = assertThrows(BizException.class, () -> service.reviseOrder("k", "ORD-1",
                new OrderRevisionRequest("加急", null, null, 30, null, null, null)));

        assertEquals("E_STATE_CONFLICT", e.getCode());
        verify(orderRevisionRepository, never()).save(any());
    }

    @Test
    void reviseOrder_quantityChange_recordsRevisionAndFlagsReschedule() {
        stubExecuteRunsAction();
        ProductionOrder scheduled = order("SCHEDULED");
        when(productionOrderRepository.findById("ORD-1")).thenReturn(Optional.of(scheduled));
        when(orderRevisionRepository.findTopByOrderIdOrderByRevisionNoDesc("ORD-1"))
                .thenReturn(Optional.empty());

        OrderRevisionResultResponse data = service.reviseOrder("k", "ORD-1",
                new OrderRevisionRequest("客户加单", null, null, 30, null, null, null));

        assertEquals(30, scheduled.getQuantity());
        assertEquals(1, scheduled.getRevisionNo());
        assertEquals(Boolean.TRUE, data.needsReschedule());
        assertTrue(data.message().contains("重新排程"));
        ArgumentCaptor<OrderRevision> captor = ArgumentCaptor.forClass(OrderRevision.class);
        verify(orderRevisionRepository).save(captor.capture());
        OrderRevision revision = captor.getValue();
        assertEquals(1, revision.getRevisionNo());
        assertEquals("客户加单", revision.getReason());
        assertEquals(1, revision.getChangedFields().size());
        Map<String, Object> change = revision.getChangedFields().get(0);
        assertEquals("quantity", change.get("field"));
        assertEquals(20, change.get("oldValue"));
        assertEquals(30, change.get("newValue"));
        // 未变更模板：不触碰已实例化工序
        verify(orderOperationRepository, never()).delete(any());
        verify(orderOperationRepository, never()).save(any());
    }

    @Test
    void reviseOrder_noFieldChange_rejected() {
        stubExecuteRunsAction();
        ProductionOrder scheduled = order("SCHEDULED");
        when(productionOrderRepository.findById("ORD-1")).thenReturn(Optional.of(scheduled));

        BizException e = assertThrows(BizException.class, () -> service.reviseOrder("k", "ORD-1",
                new OrderRevisionRequest("没有理由的修订", null, null, 20, 3, null, null)));

        assertEquals("E_VALIDATION", e.getCode());
        verify(orderRevisionRepository, never()).save(any());
    }

    @Test
    void reviseOrder_familyChangeWithoutTemplate_rejected() {
        stubExecuteRunsAction();
        ProductionOrder scheduled = order("SCHEDULED");
        when(productionOrderRepository.findById("ORD-1")).thenReturn(Optional.of(scheduled));

        BizException e = assertThrows(BizException.class, () -> service.reviseOrder("k", "ORD-1",
                new OrderRevisionRequest("换产品族", "齿轮B", null, null, null, null, null)));

        assertEquals("E_VALIDATION", e.getCode());
        verify(orderRevisionRepository, never()).save(any());
    }

    @Test
    void reviseOrder_templateChange_regeneratesOnlyNotStartedOperations() {
        stubExecuteRunsAction();
        ProductionOrder scheduled = order("SCHEDULED");
        when(productionOrderRepository.findById("ORD-1")).thenReturn(Optional.of(scheduled));
        ProcessTemplate template = new ProcessTemplate();
        template.setId("TPL-2");
        template.setTemplateCode("TPL-齿轮A");
        template.setProductFamily("齿轮A");
        template.setStatus("ACTIVE");
        when(processTemplateRepository.findById("TPL-2")).thenReturn(Optional.of(template));
        when(orderRevisionRepository.findTopByOrderIdOrderByRevisionNoDesc("ORD-1"))
                .thenReturn(Optional.empty());
        OrderOperation started = new OrderOperation();
        started.setId("ORD-1-10");
        started.setOrderId("ORD-1");
        started.setSequenceNo(10);
        started.setStatus("RUNNING");
        OrderOperation notStarted = new OrderOperation();
        notStarted.setId("ORD-1-20");
        notStarted.setOrderId("ORD-1");
        notStarted.setSequenceNo(20);
        notStarted.setStatus("NOT_STARTED");
        when(orderOperationRepository.findByOrderIdOrderBySequenceNo("ORD-1"))
                .thenReturn(List.of(started, notStarted));
        ProcessOperation po = new ProcessOperation();
        po.setId("po-1");
        po.setTemplateId("TPL-2");
        po.setSequenceNo(10);
        po.setOperationCode("OP-10");
        when(processOperationRepository.findByTemplateIdOrderBySequenceNo("TPL-2"))
                .thenReturn(List.of(po));

        OrderRevisionResultResponse data = service.reviseOrder("k", "ORD-1",
                new OrderRevisionRequest("工艺升级", null, "TPL-2", null, null, null, null));

        assertEquals("TPL-2", scheduled.getTemplateId());
        assertEquals(Boolean.TRUE, data.needsReschedule());
        // 未开始的工序删除并按新模板重建；已开始的保持不变
        verify(orderOperationRepository).delete(notStarted);
        verify(orderOperationRepository, never()).delete(started);
        ArgumentCaptor<OrderOperation> captor = ArgumentCaptor.forClass(OrderOperation.class);
        verify(orderOperationRepository).save(captor.capture());
        OrderOperation regenerated = captor.getValue();
        assertEquals("ORD-1-R1-10", regenerated.getId());
        // 已开始（保留）工序最大序号为 10，新工序排在其后避免唯一冲突
        assertEquals(20, regenerated.getSequenceNo());
        assertEquals("NOT_STARTED", regenerated.getStatus());
    }

    @Test
    void reviseOrder_incrementsRevisionNoFromHistory() {
        stubExecuteRunsAction();
        ProductionOrder scheduled = order("SCHEDULED");
        when(productionOrderRepository.findById("ORD-1")).thenReturn(Optional.of(scheduled));
        OrderRevision previous = new OrderRevision();
        previous.setOrderId("ORD-1");
        previous.setRevisionNo(2);
        when(orderRevisionRepository.findTopByOrderIdOrderByRevisionNoDesc("ORD-1"))
                .thenReturn(Optional.of(previous));

        service.reviseOrder("k", "ORD-1",
                new OrderRevisionRequest("再改优先级", null, null, null, 5, null, null));

        assertEquals(3, scheduled.getRevisionNo());
        ArgumentCaptor<OrderRevision> captor = ArgumentCaptor.forClass(OrderRevision.class);
        verify(orderRevisionRepository).save(captor.capture());
        assertEquals(3, captor.getValue().getRevisionNo());
    }
}
