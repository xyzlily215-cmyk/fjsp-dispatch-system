package com.fjsp.business.service;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import com.fjsp.business.common.BizException;
import com.fjsp.business.dto.DashboardResponse;
import com.fjsp.business.entity.Event;
import com.fjsp.business.entity.ExecutionRecord;
import com.fjsp.business.entity.PlanVersion;
import com.fjsp.business.entity.ProductionOrder;
import com.fjsp.business.entity.ScheduleOperation;
import com.fjsp.business.entity.ScheduleTask;
import com.fjsp.business.repository.EventImpactRepository;
import com.fjsp.business.repository.EventRepository;
import com.fjsp.business.repository.ExecutionRecordRepository;
import com.fjsp.business.repository.MachineRepository;
import com.fjsp.business.repository.PlanVersionRepository;
import com.fjsp.business.repository.ProductionOrderRepository;
import com.fjsp.business.repository.ScheduleOperationRepository;
import com.fjsp.business.repository.ScheduleTaskRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.data.domain.PageRequest;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class DashboardServiceTest {

    @Mock
    private MachineRepository machineRepository;
    @Mock
    private ProductionOrderRepository productionOrderRepository;
    @Mock
    private EventRepository eventRepository;
    @Mock
    private EventImpactRepository eventImpactRepository;
    @Mock
    private ScheduleTaskRepository scheduleTaskRepository;
    @Mock
    private ScheduleOperationRepository scheduleOperationRepository;
    @Mock
    private ExecutionRecordRepository executionRecordRepository;
    @Mock
    private PlanVersionRepository planVersionRepository;
    @Mock
    private ImpactCalculator impactCalculator;

    private DashboardService service;

    @BeforeEach
    void setUp() {
        service = new DashboardService(machineRepository, productionOrderRepository, eventRepository,
                eventImpactRepository, scheduleTaskRepository, scheduleOperationRepository,
                executionRecordRepository, planVersionRepository, impactCalculator);
        lenient().when(machineRepository.findAll()).thenReturn(List.of());
        lenient().when(productionOrderRepository.countGroupedByStatus()).thenReturn(List.of());
        lenient().when(productionOrderRepository.count()).thenReturn(0L);
        lenient().when(productionOrderRepository.findAllById(any())).thenReturn(List.of());
        lenient().when(eventRepository.findAllByOrderByOccurredAtDesc(any())).thenReturn(List.of());
        lenient().when(eventRepository.findByOccurredAtGreaterThanEqualAndOccurredAtLessThanOrderByOccurredAtDesc(
                any(), any(), any())).thenReturn(List.of());
        lenient().when(eventRepository.findByEventTypeOrderByOccurredAtDesc(anyString(), any()))
                .thenReturn(List.of());
        lenient().when(eventRepository
                .findByEventTypeAndOccurredAtGreaterThanEqualAndOccurredAtLessThanOrderByOccurredAtDesc(
                        anyString(), any(), any(), any())).thenReturn(List.of());
        lenient().when(eventImpactRepository.countGroupedByEventIdIn(any())).thenReturn(List.of());
        lenient().when(scheduleTaskRepository.findAllByOrderByCreatedAtDesc(any())).thenReturn(List.of());
        lenient().when(scheduleTaskRepository.findTop20ByStatusOrderByCreatedAtDesc(anyString()))
                .thenReturn(List.of());
        lenient().when(scheduleOperationRepository.findByPlanVersionId(anyString())).thenReturn(List.of());
        lenient().when(executionRecordRepository.findTop20ByReasonCodeOrderByCreatedAtDesc(anyString()))
                .thenReturn(List.of());
        lenient().when(executionRecordRepository
                .findTop20ByReasonCodeAndCreatedAtGreaterThanEqualAndCreatedAtLessThanOrderByCreatedAtDesc(
                        anyString(), any(), any())).thenReturn(List.of());
    }

    private PlanVersion plan(String id, String code, OffsetDateTime publishedAt) {
        PlanVersion p = new PlanVersion();
        p.setId(id);
        p.setVersionCode(code);
        p.setStatus("PUBLISHED");
        p.setPublishedAt(publishedAt);
        p.setKpi(Map.of("cMaxMinutes", 600));
        return p;
    }

    @Test
    void defaultsToCurrentPublishedPlanWhenNoVersionParam() {
        PlanVersion published = plan("pv-1", "PV-001", OffsetDateTime.parse("2026-10-08T08:00:00+08:00"));
        when(impactCalculator.currentPublishedPlan()).thenReturn(published);

        DashboardResponse data = service.dashboard();

        assertEquals("pv-1", data.currentPlan().id());
        verify(planVersionRepository, org.mockito.Mockito.never()).findById(anyString());
        // 无窗口：事件走全量倒序查询
        verify(eventRepository).findAllByOrderByOccurredAtDesc(any());
        assertNull(data.timeWindow().window());
    }

    @Test
    void selectsExplicitPlanVersionByIdOrCode() {
        PlanVersion other = plan("pv-9", "PV-009", OffsetDateTime.parse("2026-10-01T08:00:00+08:00"));
        when(planVersionRepository.findById("PV-009")).thenReturn(Optional.empty());
        when(planVersionRepository.findByVersionCode("PV-009")).thenReturn(Optional.of(other));

        DashboardResponse data = service.dashboard("PV-009", null, null, null);

        assertEquals("pv-9", data.currentPlan().id());
        assertEquals("PV-009", data.currentPlan().versionCode());
        // 指定版本时不读当前发布计划
        verify(impactCalculator, org.mockito.Mockito.never()).currentPublishedPlan();
    }

    @Test
    void unknownPlanVersionRejected() {
        when(planVersionRepository.findById("nope")).thenReturn(Optional.empty());
        when(planVersionRepository.findByVersionCode("nope")).thenReturn(Optional.empty());
        assertThrows(BizException.class, () -> service.dashboard("nope", null, null, null));
    }

    @Test
    void customWindowFiltersEventsBreakdownsAndDeviations() {
        String from = "2026-10-07T00:00:00+08:00";
        String to = "2026-10-08T00:00:00+08:00";

        DashboardResponse data = service.dashboard(null, "CUSTOM", from, to);

        verify(eventRepository).findByOccurredAtGreaterThanEqualAndOccurredAtLessThanOrderByOccurredAtDesc(
                eq(OffsetDateTime.parse(from)), eq(OffsetDateTime.parse(to)), any());
        verify(eventRepository)
                .findByEventTypeAndOccurredAtGreaterThanEqualAndOccurredAtLessThanOrderByOccurredAtDesc(
                        eq(Event.TYPE_BREAKDOWN), eq(OffsetDateTime.parse(from)), eq(OffsetDateTime.parse(to)),
                        any());
        verify(executionRecordRepository)
                .findTop20ByReasonCodeAndCreatedAtGreaterThanEqualAndCreatedAtLessThanOrderByCreatedAtDesc(
                        eq(ExecutionService.REASON_EXECUTION_DEVIATION),
                        eq(OffsetDateTime.parse(from)), eq(OffsetDateTime.parse(to)));
        assertEquals("CUSTOM", data.timeWindow().window());
        assertEquals(OffsetDateTime.parse(from), data.timeWindow().from());
    }

    @Test
    void last24hWindowIsRelativeToNow() {
        service.dashboard(null, "LAST_24H", null, null);

        ArgumentCaptor<OffsetDateTime> fromCaptor = ArgumentCaptor.forClass(OffsetDateTime.class);
        ArgumentCaptor<OffsetDateTime> toCaptor = ArgumentCaptor.forClass(OffsetDateTime.class);
        verify(eventRepository).findByOccurredAtGreaterThanEqualAndOccurredAtLessThanOrderByOccurredAtDesc(
                fromCaptor.capture(), toCaptor.capture(), any());
        assertEquals(24, java.time.Duration.between(fromCaptor.getValue(), toCaptor.getValue()).toHours());
    }

    @Test
    void customWindowValidation() {
        assertThrows(BizException.class, () -> service.dashboard(null, "CUSTOM", null, "2026-10-08T00:00:00+08:00"));
        assertThrows(BizException.class, () -> service.dashboard(null, "CUSTOM",
                "2026-10-08T00:00:00+08:00", "2026-10-07T00:00:00+08:00"));
        assertThrows(BizException.class, () -> service.dashboard(null, "CUSTOM", "bad", "2026-10-08T00:00:00+08:00"));
        assertThrows(BizException.class, () -> service.dashboard(null, "HOURLY", null, null));
    }

    @Test
    void shiftWindowFollowsEightHourShanghaiShifts() {
        OffsetDateTime[] morning = DashboardService.shiftWindow(OffsetDateTime.parse("2026-10-08T10:30:00+08:00"));
        assertEquals(OffsetDateTime.parse("2026-10-08T08:00:00+08:00"), morning[0]);
        assertEquals(OffsetDateTime.parse("2026-10-08T16:00:00+08:00"), morning[1]);

        OffsetDateTime[] night = DashboardService.shiftWindow(OffsetDateTime.parse("2026-10-08T02:00:00+08:00"));
        assertEquals(OffsetDateTime.parse("2026-10-08T00:00:00+08:00"), night[0]);
        assertEquals(OffsetDateTime.parse("2026-10-08T08:00:00+08:00"), night[1]);

        // UTC 输入换算到上海墙钟后归班：UTC 17:30 = 上海 01:30 → 00-08 班次
        OffsetDateTime[] utc = DashboardService.shiftWindow(OffsetDateTime.parse("2026-10-08T17:30:00Z"));
        assertEquals(OffsetDateTime.parse("2026-10-09T00:00:00+08:00"), utc[0]);
    }

    @Test
    void recentEventsCarryImpactCount() {
        Event event = new Event();
        event.setId("ev-1");
        event.setEventCode("EV-0001");
        event.setEventType(Event.TYPE_BREAKDOWN);
        event.setOccurredAt(OffsetDateTime.parse("2026-10-08T09:00:00+08:00"));
        when(eventRepository.findAllByOrderByOccurredAtDesc(any())).thenReturn(List.of(event));
        when(eventImpactRepository.countGroupedByEventIdIn(List.of("ev-1")))
                .thenReturn(List.<Object[]>of(new Object[]{"ev-1", 7L}));

        DashboardResponse data = service.dashboard();

        assertEquals(1, data.recentEvents().size());
        assertEquals(7L, data.recentEvents().get(0).impactCount());
    }

    @Test
    void recentTasksLimitedToTenWithProgressFields() {
        ScheduleTask task = new ScheduleTask();
        task.setId("t-1");
        task.setTaskCode("T-0001");
        task.setMode("BASELINE");
        task.setProgress(45);
        task.setElapsedMs(1200L);
        when(scheduleTaskRepository.findAllByOrderByCreatedAtDesc(any())).thenReturn(List.of(task));

        DashboardResponse data = service.dashboard();

        ArgumentCaptor<PageRequest> pageCaptor = ArgumentCaptor.forClass(PageRequest.class);
        verify(scheduleTaskRepository).findAllByOrderByCreatedAtDesc(pageCaptor.capture());
        assertEquals(10, pageCaptor.getValue().getPageSize());
        assertEquals(45, data.recentTasks().get(0).progress());
        assertEquals(1200L, data.recentTasks().get(0).elapsedMs());
    }

    @Test
    void exceptionItemsSortedBySeverityThenTimeDesc() {
        OffsetDateTime base = OffsetDateTime.parse("2026-10-08T08:00:00+08:00");

        // 延期订单（severity=2）
        PlanVersion published = plan("pv-1", "PV-001", base);
        when(impactCalculator.currentPublishedPlan()).thenReturn(published);
        ScheduleOperation op = new ScheduleOperation();
        op.setOperationId("ord-1-1");
        op.setEndAt(base.plusHours(10));
        when(scheduleOperationRepository.findByPlanVersionId("pv-1")).thenReturn(List.of(op));
        ProductionOrder order = new ProductionOrder();
        order.setId("ord-1");
        order.setOrderCode("SO-001");
        order.setDueAt(base.plusHours(5));
        order.setStatus("SCHEDULED");
        when(productionOrderRepository.findAllById(any())).thenReturn(List.of(order));

        // 设备故障（severity=3）
        Event breakdown = new Event();
        breakdown.setEventCode("EV-1001");
        breakdown.setEventType(Event.TYPE_BREAKDOWN);
        breakdown.setMachineId("M01");
        breakdown.setOccurredAt(base.plusHours(1));
        when(eventRepository.findByEventTypeOrderByOccurredAtDesc(eq(Event.TYPE_BREAKDOWN), any()))
                .thenReturn(List.of(breakdown));

        // 不可行任务（severity=3，时间比故障更新，应排在故障前）
        ScheduleTask infeasible = new ScheduleTask();
        infeasible.setId("t-x");
        infeasible.setTaskCode("T-0009");
        infeasible.setMode("FULL_RESCHEDULE");
        infeasible.setCreatedAt(base.plusHours(2));
        when(scheduleTaskRepository.findTop20ByStatusOrderByCreatedAtDesc("INFEASIBLE"))
                .thenReturn(List.of(infeasible));

        // 执行偏差（severity=1）
        ExecutionRecord deviation = new ExecutionRecord();
        deviation.setOperationId("ord-1-1");
        deviation.setStatus("COMPLETED");
        deviation.setDeviationMinutes(30);
        deviation.setCreatedAt(base.plusHours(3));
        when(executionRecordRepository.findTop20ByReasonCodeOrderByCreatedAtDesc(
                ExecutionService.REASON_EXECUTION_DEVIATION)).thenReturn(List.of(deviation));

        DashboardResponse data = service.dashboard();

        var exceptions = data.exceptions();
        List<Map<String, Object>> items = exceptions.items();
        assertEquals(4, items.size());
        assertEquals("INFEASIBLE_TASK", items.get(0).get("type"));
        assertEquals("BREAKDOWN", items.get(1).get("type"));
        assertEquals("DELAYED_ORDER", items.get(2).get("type"));
        assertEquals("EXECUTION_DEVIATION", items.get(3).get("type"));
        assertEquals(3, items.get(0).get("severity"));
        assertEquals(1, items.get(3).get("severity"));
        // 分组列表保持原有键，便于前端分区展示
        assertEquals(1, exceptions.delayedOrders().size());
        assertEquals(1, exceptions.infeasibleTasks().size());
    }

    @Test
    void emptyDashboardWhenNoPublishedPlan() {
        when(impactCalculator.currentPublishedPlan()).thenReturn(null);

        DashboardResponse data = service.dashboard();

        assertNull(data.currentPlan());
        var exceptions = data.exceptions();
        assertTrue(exceptions.delayedOrders().isEmpty());
        assertTrue(exceptions.items().isEmpty());
    }
}
