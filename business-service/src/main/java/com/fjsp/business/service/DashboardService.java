package com.fjsp.business.service;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.fjsp.business.entity.Event;
import com.fjsp.business.entity.Machine;
import com.fjsp.business.entity.PlanVersion;
import com.fjsp.business.entity.ProductionOrder;
import com.fjsp.business.entity.ScheduleOperation;
import com.fjsp.business.entity.ScheduleTask;
import com.fjsp.business.repository.EventRepository;
import com.fjsp.business.repository.MachineRepository;
import com.fjsp.business.repository.ProductionOrderRepository;
import com.fjsp.business.repository.ScheduleOperationRepository;
import com.fjsp.business.repository.ScheduleTaskRepository;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;

@Service
public class DashboardService {

    private final MachineRepository machineRepository;
    private final ProductionOrderRepository productionOrderRepository;
    private final EventRepository eventRepository;
    private final ScheduleTaskRepository scheduleTaskRepository;
    private final ScheduleOperationRepository scheduleOperationRepository;
    private final ImpactCalculator impactCalculator;

    public DashboardService(MachineRepository machineRepository,
                            ProductionOrderRepository productionOrderRepository,
                            EventRepository eventRepository,
                            ScheduleTaskRepository scheduleTaskRepository,
                            ScheduleOperationRepository scheduleOperationRepository,
                            ImpactCalculator impactCalculator) {
        this.machineRepository = machineRepository;
        this.productionOrderRepository = productionOrderRepository;
        this.eventRepository = eventRepository;
        this.scheduleTaskRepository = scheduleTaskRepository;
        this.scheduleOperationRepository = scheduleOperationRepository;
        this.impactCalculator = impactCalculator;
    }

    public Map<String, Object> dashboard() {
        Map<String, Object> data = new LinkedHashMap<>();

        PlanVersion published = impactCalculator.currentPublishedPlan();
        Map<String, Object> currentPlan = null;
        if (published != null) {
            currentPlan = new LinkedHashMap<>();
            currentPlan.put("id", published.getId());
            currentPlan.put("versionCode", published.getVersionCode());
            currentPlan.put("status", published.getStatus());
            currentPlan.put("candidateType", published.getCandidateType());
            currentPlan.put("publishedAt", published.getPublishedAt());
            currentPlan.put("kpi", published.getKpi());
        }
        data.put("currentPlan", currentPlan);

        Map<String, Long> orderStats = new LinkedHashMap<>();
        for (ProductionOrder order : productionOrderRepository.findAll()) {
            orderStats.merge(order.getStatus(), 1L, Long::sum);
        }
        Map<String, Object> ordersCard = new LinkedHashMap<>();
        ordersCard.put("total", productionOrderRepository.count());
        ordersCard.put("byStatus", orderStats);
        data.put("orderStats", ordersCard);

        List<Map<String, Object>> machines = new ArrayList<>();
        for (Machine machine : machineRepository.findAll()) {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("machineId", machine.getId());
            entry.put("workCenterId", machine.getWorkCenterId());
            entry.put("status", machine.getStatus());
            entry.put("productFamilies", machine.getProductFamilies());
            machines.add(entry);
        }
        machines.sort(Comparator.comparing(m -> (String) m.get("machineId")));
        data.put("machines", machines);

        List<Map<String, Object>> recentEvents = new ArrayList<>();
        for (Event event : eventRepository.findAllByOrderByOccurredAtDesc(PageRequest.of(0, 5))) {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("eventId", event.getId());
            entry.put("eventCode", event.getEventCode());
            entry.put("eventType", event.getEventType());
            entry.put("subType", event.getSubType());
            entry.put("machineId", event.getMachineId());
            entry.put("occurredAt", event.getOccurredAt());
            entry.put("status", event.getStatus());
            recentEvents.add(entry);
        }
        data.put("recentEvents", recentEvents);

        List<Map<String, Object>> recentTasks = new ArrayList<>();
        for (ScheduleTask task : scheduleTaskRepository.findAllByOrderByCreatedAtDesc(PageRequest.of(0, 5))) {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("taskId", task.getId());
            entry.put("taskCode", task.getTaskCode());
            entry.put("mode", task.getMode());
            entry.put("status", task.getStatus());
            entry.put("planVersionId", task.getPlanVersionId());
            entry.put("createdAt", task.getCreatedAt());
            recentTasks.add(entry);
        }
        data.put("recentTasks", recentTasks);

        Map<String, Object> exceptions = new LinkedHashMap<>();
        List<Map<String, Object>> delayedOrders = new ArrayList<>();
        if (published != null) {
            Map<String, ScheduleOperation> lastEndByOrder = new LinkedHashMap<>();
            Map<String, String> opOrder = new LinkedHashMap<>();
            for (ScheduleOperation op : scheduleOperationRepository.findByPlanVersionId(published.getId())) {
                String orderId = op.getOperationId().contains("-")
                        ? op.getOperationId().substring(0, op.getOperationId().lastIndexOf('-'))
                        : op.getOperationId();
                opOrder.put(op.getOperationId(), orderId);
                ScheduleOperation existing = lastEndByOrder.get(orderId);
                if (existing == null || op.getEndAt().isAfter(existing.getEndAt())) {
                    lastEndByOrder.put(orderId, op);
                }
            }
            for (Map.Entry<String, ScheduleOperation> e : lastEndByOrder.entrySet()) {
                ProductionOrder order = productionOrderRepository.findById(e.getKey()).orElse(null);
                if (order != null && e.getValue().getEndAt().isAfter(order.getDueAt())
                        && !"COMPLETED".equals(order.getStatus())) {
                    Map<String, Object> entry = new LinkedHashMap<>();
                    entry.put("orderId", order.getId());
                    entry.put("orderCode", order.getOrderCode());
                    entry.put("dueAt", order.getDueAt());
                    entry.put("plannedCompletionAt", e.getValue().getEndAt());
                    delayedOrders.add(entry);
                }
            }
        }
        exceptions.put("delayedOrders", delayedOrders);
        List<Map<String, Object>> breakdowns = new ArrayList<>();
        for (Event event : eventRepository.findAll()) {
            if (Event.TYPE_BREAKDOWN.equals(event.getEventType())) {
                Map<String, Object> entry = new LinkedHashMap<>();
                entry.put("eventCode", event.getEventCode());
                entry.put("machineId", event.getMachineId());
                entry.put("occurredAt", event.getOccurredAt());
                entry.put("repairEndAt", event.getRepairEndAt());
                breakdowns.add(entry);
            }
        }
        exceptions.put("breakdowns", breakdowns);
        data.put("exceptions", exceptions);
        return data;
    }
}
