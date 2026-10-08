package com.fjsp.business.service;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.function.Supplier;

import com.fjsp.business.common.BizException;
import com.fjsp.business.dto.CalendarIntervalCreatedResponse;
import com.fjsp.business.dto.CalendarIntervalDeletedResponse;
import com.fjsp.business.dto.CalendarIntervalRequest;
import com.fjsp.business.entity.CalendarInterval;
import com.fjsp.business.entity.ExecutionRecord;
import com.fjsp.business.entity.Machine;
import com.fjsp.business.entity.ScheduleOperation;
import com.fjsp.business.entity.WorkCalendar;
import com.fjsp.business.repository.CalendarIntervalRepository;
import com.fjsp.business.repository.ExecutionRecordRepository;
import com.fjsp.business.repository.MachineRepository;
import com.fjsp.business.repository.ScheduleOperationRepository;
import com.fjsp.business.repository.WorkCalendarRepository;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.InOrder;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** F-02 日历版本管理：区间变更走"复制生成新版本"，历史版本不改写。 */
@ExtendWith(MockitoExtension.class)
class CalendarCommandServiceTest {

    @Mock
    private MachineRepository machineRepository;
    @Mock
    private CalendarIntervalRepository calendarIntervalRepository;
    @Mock
    private WorkCalendarRepository workCalendarRepository;
    @Mock
    private ScheduleOperationRepository scheduleOperationRepository;
    @Mock
    private ExecutionRecordRepository executionRecordRepository;
    @Mock
    private IdempotencyService idempotencyService;
    @Mock
    private AuditService auditService;

    @InjectMocks
    private CalendarCommandService service;

    /** 写接口统一走 idempotencyService.execute 模板：测试替身直接执行 action。 */
    private void stubExecuteRunsAction() {
        when(idempotencyService.execute(anyString(), any(), any(), any()))
                .thenAnswer(inv -> ((Supplier<Object>) inv.getArgument(2)).get());
    }

    private CalendarIntervalRequest repairRequest() {
        return new CalendarIntervalRequest("REPAIR",
                "2026-09-16T08:00:00+08:00", "2026-09-16T10:00:00+08:00", null);
    }

    private WorkCalendar activeCalendar(String id, int version) {
        WorkCalendar calendar = new WorkCalendar();
        calendar.setId(id);
        calendar.setCalendarCode("CAL-CODE-1");
        calendar.setCalendarVersion(version);
        calendar.setStatus("ACTIVE");
        return calendar;
    }

    private CalendarInterval interval(String id, String calendarId, String type, String start, String end) {
        CalendarInterval ci = new CalendarInterval();
        ci.setId(id);
        ci.setCalendarId(calendarId);
        ci.setIntervalType(type);
        ci.setStartAt(OffsetDateTime.parse(start));
        ci.setEndAt(OffsetDateTime.parse(end));
        return ci;
    }

    @Test
    void addCalendarInterval_locksParentCalendarRowBeforeOverlapCheck() {
        stubExecuteRunsAction();
        WorkCalendar current = activeCalendar("CAL-1", 1);
        when(workCalendarRepository.findByIdForUpdate("CAL-1")).thenReturn(Optional.of(current));
        when(calendarIntervalRepository.findByCalendarIdOrderByStartAt("CAL-1")).thenReturn(List.of());
        when(machineRepository.findByCalendarId("CAL-1")).thenReturn(List.of());

        CalendarIntervalCreatedResponse data = service.addCalendarInterval("key-1", "CAL-1", repairRequest());

        // 先锁父日历行（PESSIMISTIC_WRITE），再做重叠检查——锁必须先于查询发生
        InOrder order = inOrder(workCalendarRepository, calendarIntervalRepository);
        order.verify(workCalendarRepository).findByIdForUpdate("CAL-1");
        order.verify(calendarIntervalRepository).findByCalendarIdOrderByStartAt("CAL-1");
        // 生成新版本：区间落在新版本 id 下，旧版本归档
        assertEquals(2, data.calendarVersion());
        assertNotEquals("CAL-1", data.calendarId());
        assertEquals("ARCHIVED", current.getStatus());
        verify(calendarIntervalRepository).save(any(CalendarInterval.class));
    }

    @Test
    void addCalendarInterval_overlappingExisting_rejected() {
        stubExecuteRunsAction();
        WorkCalendar current = activeCalendar("CAL-1", 1);
        CalendarInterval existing = interval("ci-1", "CAL-1", "BREAK",
                "2026-09-16T09:00:00+08:00", "2026-09-16T11:00:00+08:00");
        when(workCalendarRepository.findByIdForUpdate("CAL-1")).thenReturn(Optional.of(current));
        when(calendarIntervalRepository.findByCalendarIdOrderByStartAt("CAL-1"))
                .thenReturn(List.of(existing));

        BizException e = assertThrows(BizException.class,
                () -> service.addCalendarInterval("key-1", "CAL-1", repairRequest()));

        assertEquals("E_VALIDATION", e.getCode());
        verify(calendarIntervalRepository, never()).save(any());
        verify(workCalendarRepository, never()).save(any());
    }

    @Test
    void addCalendarInterval_calendarMissing_rejected() {
        stubExecuteRunsAction();
        when(workCalendarRepository.findByIdForUpdate("CAL-X")).thenReturn(Optional.empty());

        BizException e = assertThrows(BizException.class,
                () -> service.addCalendarInterval("key-1", "CAL-X", repairRequest()));

        assertEquals("E_NOT_FOUND", e.getCode());
        verify(calendarIntervalRepository, never()).save(any());
    }

    @Test
    void addCalendarInterval_archivedVersion_rejected() {
        stubExecuteRunsAction();
        WorkCalendar archived = activeCalendar("CAL-1", 1);
        archived.setStatus("ARCHIVED");
        when(workCalendarRepository.findByIdForUpdate("CAL-1")).thenReturn(Optional.of(archived));

        BizException e = assertThrows(BizException.class,
                () -> service.addCalendarInterval("key-1", "CAL-1", repairRequest()));

        assertEquals("E_STATE_CONFLICT", e.getCode());
        verify(calendarIntervalRepository, never()).save(any());
    }

    @Test
    void addCalendarInterval_repairCoveringCompletedExecution_rejected() {
        stubExecuteRunsAction();
        WorkCalendar current = activeCalendar("CAL-1", 1);
        when(workCalendarRepository.findByIdForUpdate("CAL-1")).thenReturn(Optional.of(current));
        when(calendarIntervalRepository.findByCalendarIdOrderByStartAt("CAL-1")).thenReturn(List.of());
        Machine machine = new Machine();
        machine.setId("M-01");
        machine.setCalendarId("CAL-1");
        when(machineRepository.findByCalendarId("CAL-1")).thenReturn(List.of(machine));
        ScheduleOperation so = new ScheduleOperation();
        so.setOperationId("OP-1");
        so.setMachineId("M-01");
        when(scheduleOperationRepository.findByMachineIdIn(List.of("M-01"))).thenReturn(List.of(so));
        ExecutionRecord record = new ExecutionRecord();
        record.setOperationId("OP-1");
        record.setStatus("COMPLETED");
        record.setActualStartAt(OffsetDateTime.parse("2026-09-16T08:30:00+08:00"));
        record.setActualEndAt(OffsetDateTime.parse("2026-09-16T09:30:00+08:00"));
        when(executionRecordRepository.findByOperationIdIn(List.of("OP-1"))).thenReturn(List.of(record));

        BizException e = assertThrows(BizException.class,
                () -> service.addCalendarInterval("key-1", "CAL-1", repairRequest()));

        assertEquals("E_VALIDATION", e.getCode());
        verify(calendarIntervalRepository, never()).save(any());
        verify(workCalendarRepository, never()).save(any());
    }

    @Test
    void addCalendarInterval_repairNotCoveringCompletedExecution_created() {
        stubExecuteRunsAction();
        WorkCalendar current = activeCalendar("CAL-1", 3);
        when(workCalendarRepository.findByIdForUpdate("CAL-1")).thenReturn(Optional.of(current));
        when(calendarIntervalRepository.findByCalendarIdOrderByStartAt("CAL-1")).thenReturn(List.of());
        Machine machine = new Machine();
        machine.setId("M-01");
        machine.setCalendarId("CAL-1");
        when(machineRepository.findByCalendarId("CAL-1")).thenReturn(List.of(machine));
        ScheduleOperation so = new ScheduleOperation();
        so.setOperationId("OP-1");
        so.setMachineId("M-01");
        when(scheduleOperationRepository.findByMachineIdIn(List.of("M-01"))).thenReturn(List.of(so));
        ExecutionRecord record = new ExecutionRecord();
        record.setOperationId("OP-1");
        record.setStatus("COMPLETED");
        // 已完成的执行记录在维修区间之外，不冲突
        record.setActualStartAt(OffsetDateTime.parse("2026-09-15T08:30:00+08:00"));
        record.setActualEndAt(OffsetDateTime.parse("2026-09-15T09:30:00+08:00"));
        when(executionRecordRepository.findByOperationIdIn(List.of("OP-1"))).thenReturn(List.of(record));

        CalendarIntervalCreatedResponse data = service.addCalendarInterval("key-1", "CAL-1", repairRequest());

        assertEquals(4, data.calendarVersion());
        // 设备被重指向新版本日历
        ArgumentCaptor<WorkCalendar> calendarCaptor = ArgumentCaptor.forClass(WorkCalendar.class);
        verify(workCalendarRepository, times(2)).save(calendarCaptor.capture());
        WorkCalendar next = calendarCaptor.getAllValues().get(0);
        assertEquals(4, next.getCalendarVersion());
        assertEquals("ACTIVE", next.getStatus());
        assertEquals(next.getId(), machine.getCalendarId());
        assertEquals("ARCHIVED", current.getStatus());
    }

    @Test
    void deleteCalendarInterval_createsNextVersionWithoutTarget() {
        stubExecuteRunsAction();
        WorkCalendar current = activeCalendar("CAL-1", 2);
        CalendarInterval target = interval("ci-9", "CAL-1", "BREAK",
                "2026-09-16T12:00:00+08:00", "2026-09-16T13:00:00+08:00");
        CalendarInterval work = interval("ci-1", "CAL-1", "WORK",
                "2026-09-16T08:00:00+08:00", "2026-09-16T18:00:00+08:00");
        when(workCalendarRepository.findByIdForUpdate("CAL-1")).thenReturn(Optional.of(current));
        when(calendarIntervalRepository.findByCalendarIdOrderByStartAt("CAL-1"))
                .thenReturn(List.of(work, target));
        when(machineRepository.findByCalendarId("CAL-1")).thenReturn(List.of());

        CalendarIntervalDeletedResponse data = service.deleteCalendarInterval("key-1", "CAL-1", "ci-9");

        assertEquals("ci-9", data.removedIntervalId());
        assertEquals(3, data.calendarVersion());
        // 复制到新版本的区间只剩 WORK 一条，目标区间不带入新版本
        ArgumentCaptor<CalendarInterval> captor = ArgumentCaptor.forClass(CalendarInterval.class);
        verify(calendarIntervalRepository, times(1)).save(captor.capture());
        assertEquals("WORK", captor.getValue().getIntervalType());
        assertNotEquals("ci-1", captor.getValue().getId());
        assertEquals("ARCHIVED", current.getStatus());
    }

    @Test
    void deleteCalendarInterval_intervalNotInCurrentVersion_rejected() {
        stubExecuteRunsAction();
        WorkCalendar current = activeCalendar("CAL-1", 2);
        when(workCalendarRepository.findByIdForUpdate("CAL-1")).thenReturn(Optional.of(current));
        when(calendarIntervalRepository.findByCalendarIdOrderByStartAt("CAL-1")).thenReturn(List.of());

        BizException e = assertThrows(BizException.class,
                () -> service.deleteCalendarInterval("key-1", "CAL-1", "ci-x"));

        assertEquals("E_NOT_FOUND", e.getCode());
        verify(calendarIntervalRepository, never()).save(any());
    }
}
