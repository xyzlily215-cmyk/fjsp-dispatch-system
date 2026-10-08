package com.fjsp.business.service;

import java.time.OffsetDateTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import com.fjsp.business.entity.CalendarInterval;
import com.fjsp.business.entity.Event;
import com.fjsp.business.entity.ExecutionRecord;
import com.fjsp.business.entity.Machine;
import com.fjsp.business.entity.OrderOperation;
import com.fjsp.business.entity.ProductionOrder;
import com.fjsp.business.entity.ScheduleOperation;
import com.fjsp.business.repository.CalendarIntervalRepository;
import com.fjsp.business.repository.EventImpactRepository;
import com.fjsp.business.repository.EventRepository;
import com.fjsp.business.repository.ExecutionRecordRepository;
import com.fjsp.business.repository.MachineRepository;
import com.fjsp.business.repository.OrderOperationRepository;
import com.fjsp.business.repository.ProductionOrderRepository;
import com.fjsp.business.repository.ScheduleOperationRepository;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class SnapshotBuilderTest {

    private static final OffsetDateTime SIM_START = OffsetDateTime.parse("2026-09-16T08:00:00+08:00");

    @Mock
    private MachineRepository machineRepository;
    @Mock
    private CalendarIntervalRepository calendarIntervalRepository;
    @Mock
    private ProductionOrderRepository productionOrderRepository;
    @Mock
    private OrderOperationRepository orderOperationRepository;
    @Mock
    private ScheduleOperationRepository scheduleOperationRepository;
    @Mock
    private ExecutionRecordRepository executionRecordRepository;
    @Mock
    private EventRepository eventRepository;
    @Mock
    private EventImpactRepository eventImpactRepository;
    @Mock
    private SeedService seedService;

    @InjectMocks
    private SnapshotBuilder snapshotBuilder;

    private void stubSeedService() {
        when(seedService.changeoverMatrix()).thenReturn(Map.of());
        when(seedService.defaultObjectiveWeights("BASELINE")).thenReturn(Map.of());
        when(seedService.defaultAlgorithmParams()).thenAnswer(inv -> {
            Map<String, Object> params = new LinkedHashMap<>();
            params.put("timeLimitSeconds", 60);
            params.put("randomSeed", 1);
            return params;
        });
    }

    private Machine machine(String id, String status, String calendarId) {
        Machine machine = new Machine();
        machine.setId(id);
        machine.setMachineCode("MC-" + id);
        machine.setStatus(status);
        machine.setCalendarId(calendarId);
        return machine;
    }

    private CalendarInterval interval(String calendarId, String type, String start, String end) {
        CalendarInterval ci = new CalendarInterval();
        ci.setCalendarId(calendarId);
        ci.setIntervalType(type);
        ci.setStartAt(OffsetDateTime.parse(start));
        ci.setEndAt(OffsetDateTime.parse(end));
        return ci;
    }

    private Event breakdown(String machineId, String occurredAt, String repairEndAt) {
        Event event = new Event();
        event.setId("EVT-BD");
        event.setEventType(Event.TYPE_BREAKDOWN);
        event.setMachineId(machineId);
        event.setOccurredAt(OffsetDateTime.parse(occurredAt));
        event.setRepairEndAt(OffsetDateTime.parse(repairEndAt));
        return event;
    }

    @Test
    void buildSolveRequest_breakdownIntervalSubtractedFromAvailability() {
        // 设备工作日历 08:00-16:00，10:00-11:00 故障维修 → 可用区间应被扣除
        stubSeedService();
        when(machineRepository.findAll()).thenReturn(List.of(machine("M1", "ACTIVE", "CAL1")));
        when(calendarIntervalRepository.findByCalendarIdOrderByStartAt("CAL1"))
                .thenReturn(List.of(interval("CAL1", "WORK",
                        "2026-09-16T08:00:00+08:00", "2026-09-16T16:00:00+08:00")));
        when(eventRepository.findAll()).thenReturn(List.of(breakdown("M1",
                "2026-09-16T10:00:00+08:00", "2026-09-16T11:00:00+08:00")));
        when(productionOrderRepository.findByStatusIn(List.of("WAITING"))).thenReturn(List.of());

        Map<String, Object> request = snapshotBuilder.buildSolveRequest("BASELINE", null, null,
                null, SIM_START, 30, null, null);

        @SuppressWarnings("unchecked")
        List<Map<String, Object>> machines = (List<Map<String, Object>>) request.get("machines");
        assertEquals(1, machines.size());
        assertEquals("M1", machines.get(0).get("machineId"));
        @SuppressWarnings("unchecked")
        List<List<Long>> available = (List<List<Long>>) machines.get(0).get("availableIntervals");
        assertEquals(List.of(List.of(0L, 120L), List.of(180L, 480L)), available);
    }

    @Test
    void buildSolveRequest_maintenanceIntervalSubtracted() {
        // 非 WORK 日历区间（保养/维修窗口）同样要从可用区间中扣除
        stubSeedService();
        when(machineRepository.findAll()).thenReturn(List.of(machine("M1", "ACTIVE", "CAL1")));
        when(calendarIntervalRepository.findByCalendarIdOrderByStartAt("CAL1"))
                .thenReturn(List.of(
                        interval("CAL1", "WORK", "2026-09-16T08:00:00+08:00",
                                "2026-09-16T16:00:00+08:00"),
                        interval("CAL1", "MAINTENANCE", "2026-09-16T12:00:00+08:00",
                                "2026-09-16T13:00:00+08:00")));
        when(eventRepository.findAll()).thenReturn(List.of());
        when(productionOrderRepository.findByStatusIn(List.of("WAITING"))).thenReturn(List.of());

        Map<String, Object> request = snapshotBuilder.buildSolveRequest("BASELINE", null, null,
                null, SIM_START, 30, null, null);

        @SuppressWarnings("unchecked")
        List<Map<String, Object>> machines = (List<Map<String, Object>>) request.get("machines");
        @SuppressWarnings("unchecked")
        List<List<Long>> available = (List<List<Long>>) machines.get(0).get("availableIntervals");
        assertEquals(List.of(List.of(0L, 240L), List.of(300L, 480L)), available);
    }

    @Test
    void buildSolveRequest_inactiveMachineExcluded() {
        stubSeedService();
        when(machineRepository.findAll()).thenReturn(List.of(
                machine("M1", "ACTIVE", null),
                machine("M2", "DISABLED", null)));
        when(eventRepository.findAll()).thenReturn(List.of());
        when(productionOrderRepository.findByStatusIn(List.of("WAITING"))).thenReturn(List.of());

        Map<String, Object> request = snapshotBuilder.buildSolveRequest("BASELINE", null, null,
                null, SIM_START, 30, null, null);

        @SuppressWarnings("unchecked")
        List<Map<String, Object>> machines = (List<Map<String, Object>>) request.get("machines");
        assertEquals(1, machines.size());
        assertEquals("M1", machines.get(0).get("machineId"));
    }

    private ScheduleOperation oldOp(String opId, String start, String end) {
        ScheduleOperation op = new ScheduleOperation();
        op.setPlanVersionId("PV-OLD");
        op.setOperationId(opId);
        op.setMachineId("M1");
        op.setStartAt(OffsetDateTime.parse(start));
        op.setEndAt(OffsetDateTime.parse(end));
        op.setChangeoverMinutes(0);
        return op;
    }

    private OrderOperation orderOp(String opId, int seq) {
        OrderOperation oo = new OrderOperation();
        oo.setId(opId);
        oo.setOrderId("ORD-1");
        oo.setSequenceNo(seq);
        return oo;
    }

    @Test
    void buildSolveRequest_rescheduleGeneratesLockings() {
        // 冻结起点 = 故障发生时间 09:00，冻结窗口 30 分钟
        when(seedService.changeoverMatrix()).thenReturn(Map.of());
        when(seedService.defaultObjectiveWeights("LOCAL_RESCHEDULE")).thenReturn(Map.of());
        when(seedService.defaultAlgorithmParams()).thenAnswer(inv -> new LinkedHashMap<>(
                Map.of("timeLimitSeconds", 60)));
        when(machineRepository.findAll()).thenReturn(List.of());
        when(eventRepository.findAll()).thenReturn(List.of());
        when(scheduleOperationRepository.findByPlanVersionId("PV-OLD")).thenReturn(List.of(
                oldOp("OP-DONE", "2026-09-16T08:00:00+08:00", "2026-09-16T08:30:00+08:00"),
                oldOp("OP-RUN", "2026-09-16T08:30:00+08:00", "2026-09-16T09:30:00+08:00"),
                oldOp("OP-FROZEN", "2026-09-16T09:10:00+08:00", "2026-09-16T09:40:00+08:00"),
                oldOp("OP-SOFT", "2026-09-16T12:00:00+08:00", "2026-09-16T13:00:00+08:00")));
        when(orderOperationRepository.findAll()).thenReturn(List.of(
                orderOp("OP-DONE", 1), orderOp("OP-RUN", 2),
                orderOp("OP-FROZEN", 3), orderOp("OP-SOFT", 4)));
        ProductionOrder order = new ProductionOrder();
        order.setId("ORD-1");
        order.setProductFamily("FAM-A");
        order.setQuantity(1);
        order.setArrivalAt(OffsetDateTime.parse("2026-09-16T08:00:00+08:00"));
        order.setDueAt(OffsetDateTime.parse("2026-09-16T18:00:00+08:00"));
        order.setPriority(3);
        when(productionOrderRepository.findByStatusIn(List.of("WAITING"))).thenReturn(List.of());
        when(productionOrderRepository.findById("ORD-1")).thenReturn(Optional.of(order));
        when(orderOperationRepository.findByOrderIdOrderBySequenceNo("ORD-1")).thenReturn(List.of(
                orderOp("OP-DONE", 1), orderOp("OP-RUN", 2),
                orderOp("OP-FROZEN", 3), orderOp("OP-SOFT", 4)));
        when(eventImpactRepository.findByEventId("EVT-1")).thenReturn(List.of());
        when(executionRecordRepository.existsByOperationIdAndStatus("OP-DONE", "COMPLETED"))
                .thenReturn(true);
        ExecutionRecord runningRecord = new ExecutionRecord();
        // 实际开工（09:45）晚于计划完工（09:30）——触发 actualStartAtMinutes 传递
        runningRecord.setActualStartAt(OffsetDateTime.parse("2026-09-16T09:45:00+08:00"));
        when(executionRecordRepository.findFirstByOperationIdAndStatusAndActualEndAtIsNull(
                "OP-RUN", "RUNNING")).thenReturn(Optional.of(runningRecord));
        when(executionRecordRepository.findFirstByOperationIdAndStatusAndActualEndAtIsNull(
                "OP-FROZEN", "RUNNING")).thenReturn(Optional.empty());

        Event event = new Event();
        event.setId("EVT-1");
        event.setEventType(Event.TYPE_BREAKDOWN);
        event.setOccurredAt(OffsetDateTime.parse("2026-09-16T09:00:00+08:00"));

        Map<String, Object> request = snapshotBuilder.buildSolveRequest("LOCAL_RESCHEDULE", null,
                "PV-OLD", event, SIM_START, 30, null, null);

        @SuppressWarnings("unchecked")
        List<Map<String, Object>> lockings = (List<Map<String, Object>>) request.get("lockings");
        Map<String, Map<String, Object>> byOp = new LinkedHashMap<>();
        for (Map<String, Object> lock : lockings) {
            byOp.put((String) lock.get("operationId"), lock);
        }
        assertEquals(4, lockings.size());
        // 已完成工序不能变更
        assertEquals("completed", byOp.get("OP-DONE").get("lockType"));
        // 执行中工序锁定，不能越过冻结窗口
        assertEquals("in_progress", byOp.get("OP-RUN").get("lockType"));
        // 执行中工序携带实际开工时间，供算法锚定窗口
        assertEquals(105L, byOp.get("OP-RUN").get("actualStartAtMinutes"));
        // 冻结窗口内开工的工序被冻结
        assertEquals("frozen", byOp.get("OP-FROZEN").get("lockType"));
        // 窗口外工序软锁定（允许微调）
        assertEquals("soft", byOp.get("OP-SOFT").get("lockType"));
        assertEquals(Boolean.TRUE, byOp.get("OP-SOFT").get("softLocked"));
        // 冻结工序的绝对时间被固定传递给算法服务
        assertEquals(70L, byOp.get("OP-FROZEN").get("startAtMinutes"));
        assertEquals(100L, byOp.get("OP-FROZEN").get("endAtMinutes"));
        // 局部重调度必须携带受影响工序集合与 delta 权重
        assertTrue(request.containsKey("affectedOperationIds"));
        assertTrue(request.containsKey("deltaPlanWeights"));
        assertTrue(request.containsKey("oldPlan"));
    }

    @Test
    void buildSolveRequest_fullRescheduleHasNoAffectedIds() {
        when(seedService.changeoverMatrix()).thenReturn(Map.of());
        when(seedService.defaultObjectiveWeights("FULL_RESCHEDULE")).thenReturn(Map.of());
        when(seedService.defaultAlgorithmParams()).thenAnswer(inv -> new LinkedHashMap<>(
                Map.of("timeLimitSeconds", 60)));
        when(machineRepository.findAll()).thenReturn(List.of());
        when(eventRepository.findAll()).thenReturn(List.of());
        when(scheduleOperationRepository.findByPlanVersionId("PV-OLD")).thenReturn(List.of());
        when(orderOperationRepository.findAll()).thenReturn(List.of());
        when(productionOrderRepository.findByStatusIn(List.of("WAITING"))).thenReturn(List.of());

        Map<String, Object> request = snapshotBuilder.buildSolveRequest("FULL_RESCHEDULE", null,
                "PV-OLD", null, SIM_START, 30, null, null);

        assertTrue(request.containsKey("lockings"));
        assertTrue(request.containsKey("oldPlan"));
        assertFalse(request.containsKey("affectedOperationIds"));
    }
}
