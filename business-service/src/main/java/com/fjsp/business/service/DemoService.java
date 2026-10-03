package com.fjsp.business.service;

import java.util.LinkedHashMap;
import java.util.Map;

import com.fjsp.business.repository.AuditLogRepository;
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
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class DemoService {

    private final EventImpactRepository eventImpactRepository;
    private final ExecutionRecordRepository executionRecordRepository;
    private final ScheduleOperationRepository scheduleOperationRepository;
    private final PlanVersionRepository planVersionRepository;
    private final InputSnapshotRepository inputSnapshotRepository;
    private final ScheduleTaskRepository scheduleTaskRepository;
    private final EventRepository eventRepository;
    private final OrderOperationRepository orderOperationRepository;
    private final ProductionOrderRepository productionOrderRepository;
    private final OperationCandidateRepository operationCandidateRepository;
    private final ProcessOperationRepository processOperationRepository;
    private final ProcessTemplateRepository processTemplateRepository;
    private final CalendarIntervalRepository calendarIntervalRepository;
    private final WorkCalendarRepository workCalendarRepository;
    private final MachineRepository machineRepository;
    private final IdempotencyRecordRepository idempotencyRecordRepository;
    private final AuditLogRepository auditLogRepository;
    private final SeedService seedService;
    private final AuditService auditService;

    public DemoService(EventImpactRepository eventImpactRepository,
                       ExecutionRecordRepository executionRecordRepository,
                       ScheduleOperationRepository scheduleOperationRepository,
                       PlanVersionRepository planVersionRepository,
                       InputSnapshotRepository inputSnapshotRepository,
                       ScheduleTaskRepository scheduleTaskRepository,
                       EventRepository eventRepository,
                       OrderOperationRepository orderOperationRepository,
                       ProductionOrderRepository productionOrderRepository,
                       OperationCandidateRepository operationCandidateRepository,
                       ProcessOperationRepository processOperationRepository,
                       ProcessTemplateRepository processTemplateRepository,
                       CalendarIntervalRepository calendarIntervalRepository,
                       WorkCalendarRepository workCalendarRepository,
                       MachineRepository machineRepository,
                       IdempotencyRecordRepository idempotencyRecordRepository,
                       AuditLogRepository auditLogRepository,
                       SeedService seedService,
                       AuditService auditService) {
        this.eventImpactRepository = eventImpactRepository;
        this.executionRecordRepository = executionRecordRepository;
        this.scheduleOperationRepository = scheduleOperationRepository;
        this.planVersionRepository = planVersionRepository;
        this.inputSnapshotRepository = inputSnapshotRepository;
        this.scheduleTaskRepository = scheduleTaskRepository;
        this.eventRepository = eventRepository;
        this.orderOperationRepository = orderOperationRepository;
        this.productionOrderRepository = productionOrderRepository;
        this.operationCandidateRepository = operationCandidateRepository;
        this.processOperationRepository = processOperationRepository;
        this.processTemplateRepository = processTemplateRepository;
        this.calendarIntervalRepository = calendarIntervalRepository;
        this.workCalendarRepository = workCalendarRepository;
        this.machineRepository = machineRepository;
        this.idempotencyRecordRepository = idempotencyRecordRepository;
        this.auditLogRepository = auditLogRepository;
        this.seedService = seedService;
        this.auditService = auditService;
    }

    @Transactional
    public Map<String, Object> reset() {
        eventImpactRepository.deleteAll();
        executionRecordRepository.deleteAll();
        scheduleOperationRepository.deleteAll();
        planVersionRepository.deleteAll();
        inputSnapshotRepository.deleteAll();
        scheduleTaskRepository.deleteAll();
        eventRepository.deleteAll();
        orderOperationRepository.deleteAll();
        productionOrderRepository.deleteAll();
        operationCandidateRepository.deleteAll();
        processOperationRepository.deleteAll();
        processTemplateRepository.deleteAll();
        calendarIntervalRepository.deleteAll();
        workCalendarRepository.deleteAll();
        machineRepository.deleteAll();
        idempotencyRecordRepository.deleteAll();
        auditLogRepository.deleteAll();

        Map<String, Object> seedSummary = seedService.seed();
        auditService.record("DEMO_RESET", "system", "demo", "business data cleared and reseeded");

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("reset", true);
        data.put("seed", seedSummary);
        return data;
    }
}
