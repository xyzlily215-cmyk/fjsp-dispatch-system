package com.fjsp.business.service;

import java.util.Map;

import com.fjsp.business.common.BizException;
import com.fjsp.business.config.FjspProperties;
import com.fjsp.business.repository.CalendarIntervalRepository;
import com.fjsp.business.repository.EventImpactRepository;
import com.fjsp.business.repository.EventRepository;
import com.fjsp.business.repository.ExecutionRecordRepository;
import com.fjsp.business.repository.IdempotencyRecordRepository;
import com.fjsp.business.repository.InputSnapshotRepository;
import com.fjsp.business.repository.MachineRepository;
import com.fjsp.business.repository.OperationCandidateRepository;
import com.fjsp.business.repository.OrderOperationRepository;
import com.fjsp.business.repository.PlanVersionRepository;
import com.fjsp.business.repository.ProcessOperationRepository;
import com.fjsp.business.repository.ProcessTemplateRepository;
import com.fjsp.business.repository.ProductionOrderRepository;
import com.fjsp.business.repository.ScheduleOperationRepository;
import com.fjsp.business.repository.ScheduleTaskRepository;
import com.fjsp.business.repository.WorkCalendarRepository;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.http.HttpStatus;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class DemoServiceTest {

    @Mock
    private EventImpactRepository eventImpactRepository;
    @Mock
    private ExecutionRecordRepository executionRecordRepository;
    @Mock
    private ScheduleOperationRepository scheduleOperationRepository;
    @Mock
    private PlanVersionRepository planVersionRepository;
    @Mock
    private InputSnapshotRepository inputSnapshotRepository;
    @Mock
    private ScheduleTaskRepository scheduleTaskRepository;
    @Mock
    private EventRepository eventRepository;
    @Mock
    private OrderOperationRepository orderOperationRepository;
    @Mock
    private ProductionOrderRepository productionOrderRepository;
    @Mock
    private OperationCandidateRepository operationCandidateRepository;
    @Mock
    private ProcessOperationRepository processOperationRepository;
    @Mock
    private ProcessTemplateRepository processTemplateRepository;
    @Mock
    private CalendarIntervalRepository calendarIntervalRepository;
    @Mock
    private WorkCalendarRepository workCalendarRepository;
    @Mock
    private MachineRepository machineRepository;
    @Mock
    private IdempotencyRecordRepository idempotencyRecordRepository;
    @Mock
    private SeedService seedService;
    @Mock
    private AuditService auditService;

    private DemoService demoService(boolean demoEnabled) {
        FjspProperties properties = new FjspProperties();
        properties.getDemo().setEnabled(demoEnabled);
        return new DemoService(eventImpactRepository, executionRecordRepository, scheduleOperationRepository,
                planVersionRepository, inputSnapshotRepository, scheduleTaskRepository, eventRepository,
                orderOperationRepository, productionOrderRepository, operationCandidateRepository,
                processOperationRepository, processTemplateRepository, calendarIntervalRepository,
                workCalendarRepository, machineRepository, idempotencyRecordRepository,
                seedService, auditService, properties);
    }

    @Test
    void reset_disabled_rejectedWithoutTouchingData() {
        DemoService service = demoService(false);

        BizException e = assertThrows(BizException.class, service::reset);

        assertEquals("E_FORBIDDEN", e.getCode());
        assertEquals(HttpStatus.FORBIDDEN, e.getStatus());
        verifyNoInteractions(machineRepository, eventRepository, seedService);
    }

    @Test
    void reset_enabled_clearsBusinessDataAndReseeds() {
        when(seedService.seed()).thenReturn(Map.of("orders", 4));

        Map<String, Object> data = demoService(true).reset();

        assertEquals(Boolean.TRUE, data.get("reset"));
        assertTrue(data.containsKey("seed"));
        verify(machineRepository).deleteAll();
        verify(idempotencyRecordRepository).deleteAll();
        verify(auditService).record(eq("DEMO_RESET"), anyString(), anyString(), anyString());
    }
}
