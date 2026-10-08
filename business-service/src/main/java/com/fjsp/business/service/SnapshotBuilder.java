package com.fjsp.business.service;

import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import com.fjsp.business.common.BizException;
import com.fjsp.business.entity.CalendarInterval;
import com.fjsp.business.entity.Event;
import com.fjsp.business.entity.EventImpact;
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
import org.springframework.stereotype.Service;

@Service
public class SnapshotBuilder {

    private final MachineRepository machineRepository;
    private final CalendarIntervalRepository calendarIntervalRepository;
    private final ProductionOrderRepository productionOrderRepository;
    private final OrderOperationRepository orderOperationRepository;
    private final ScheduleOperationRepository scheduleOperationRepository;
    private final ExecutionRecordRepository executionRecordRepository;
    private final EventRepository eventRepository;
    private final EventImpactRepository eventImpactRepository;
    private final SeedService seedService;

    public SnapshotBuilder(MachineRepository machineRepository,
                           CalendarIntervalRepository calendarIntervalRepository,
                           ProductionOrderRepository productionOrderRepository,
                           OrderOperationRepository orderOperationRepository,
                           ScheduleOperationRepository scheduleOperationRepository,
                           ExecutionRecordRepository executionRecordRepository,
                           EventRepository eventRepository,
                           EventImpactRepository eventImpactRepository,
                           SeedService seedService) {
        this.machineRepository = machineRepository;
        this.calendarIntervalRepository = calendarIntervalRepository;
        this.productionOrderRepository = productionOrderRepository;
        this.orderOperationRepository = orderOperationRepository;
        this.scheduleOperationRepository = scheduleOperationRepository;
        this.executionRecordRepository = executionRecordRepository;
        this.eventRepository = eventRepository;
        this.eventImpactRepository = eventImpactRepository;
        this.seedService = seedService;
    }

    public Map<String, Object> buildSolveRequest(String mode, List<String> orderIds,
                                                 String oldPlanVersionId, Event event,
                                                 OffsetDateTime simStart, int freezeWindowMinutes,
                                                 Map<String, Double> objectiveWeights,
                                                 Map<String, Object> algorithmOverrides) {
        Map<String, Object> request = new LinkedHashMap<>();
        request.put("mode", mode);
        request.put("simulationStartAt", simStart.toString());
        request.put("freezeWindowMinutes", freezeWindowMinutes);
        request.put("machines", buildMachines(simStart));
        request.put("orders", buildOrders(mode, orderIds, oldPlanVersionId, simStart));
        request.put("changeoverDefault", seedService.changeoverDefault());
        request.put("changeoverMatrix", seedService.changeoverMatrix());
        request.put("objectiveWeights",
                objectiveWeights != null ? objectiveWeights : seedService.defaultObjectiveWeights(mode));
        Map<String, Object> algorithm = seedService.defaultAlgorithmParams();
        if (algorithmOverrides != null) {
            algorithm.putAll(algorithmOverrides);
        }
        request.put("algorithm", algorithm);

        if (!"BASELINE".equals(mode)) {
            List<ScheduleOperation> oldOps = scheduleOperationRepository.findByPlanVersionId(oldPlanVersionId);
            List<Map<String, Object>> oldPlan = new ArrayList<>();
            for (ScheduleOperation op : oldOps) {
                Map<String, Object> entry = new LinkedHashMap<>();
                entry.put("operationId", op.getOperationId());
                entry.put("machineId", op.getMachineId());
                entry.put("startAtMinutes", minutesBetween(simStart, op.getStartAt()));
                entry.put("endAtMinutes", minutesBetween(simStart, op.getEndAt()));
                entry.put("changeoverMinutes", op.getChangeoverMinutes());
                oldPlan.add(entry);
            }
            request.put("oldPlan", oldPlan);

            Set<String> affected = new HashSet<>();
            if (event != null) {
                for (EventImpact impact : eventImpactRepository.findByEventId(event.getId())) {
                    if (!"HARD_LOCKED".equals(impact.getLockType())) {
                        affected.add(impact.getOperationId());
                    }
                }
            }
            OffsetDateTime freezeStart = event != null ? event.getOccurredAt() : simStart;
            List<Map<String, Object>> lockings = new ArrayList<>();
            for (ScheduleOperation op : oldOps) {
                String opId = op.getOperationId();
                boolean completed = executionRecordRepository.existsByOperationIdAndStatus(opId, "COMPLETED");
                var running = completed ? java.util.Optional.<ExecutionRecord>empty()
                        : executionRecordRepository.findFirstByOperationIdAndStatusAndActualEndAtIsNull(opId, "RUNNING");
                boolean inProgress = running.isPresent();
                boolean frozen = !completed && !inProgress && !affected.contains(opId)
                        && !op.getStartAt().isBefore(freezeStart)
                        && op.getStartAt().isBefore(freezeStart.plusMinutes(freezeWindowMinutes));
                Map<String, Object> lock = new LinkedHashMap<>();
                lock.put("operationId", opId);
                if (completed || inProgress || frozen) {
                    lock.put("lockType", completed ? "completed" : inProgress ? "in_progress" : "frozen");
                    lock.put("machineId", op.getMachineId());
                    lock.put("startAtMinutes", minutesBetween(simStart, op.getStartAt()));
                    lock.put("endAtMinutes", minutesBetween(simStart, op.getEndAt()));
                    lock.put("changeoverMinutes", op.getChangeoverMinutes());
                    if (inProgress && running.get().getActualStartAt() != null) {
                        lock.put("actualStartAtMinutes", minutesBetween(simStart, running.get().getActualStartAt()));
                    }
                } else if (!affected.contains(opId)) {
                    lock.put("lockType", "soft");
                    lock.put("softLocked", true);
                } else {
                    continue;
                }
                lockings.add(lock);
            }
            request.put("lockings", lockings);
            if ("LOCAL_RESCHEDULE".equals(mode)) {
                request.put("affectedOperationIds", new ArrayList<>(affected));
            }
            Map<String, Double> deltaWeights = new LinkedHashMap<>();
            deltaWeights.put("startTimeShift", 0.5);
            deltaWeights.put("machineChange", 0.3);
            deltaWeights.put("sequenceChange", 0.2);
            request.put("deltaPlanWeights", deltaWeights);
        }
        return request;
    }

    private List<Map<String, Object>> buildMachines(OffsetDateTime simStart) {
        List<Event> breakdowns = eventRepository.findAll().stream()
                .filter(e -> Event.TYPE_BREAKDOWN.equals(e.getEventType()) && e.getRepairEndAt() != null)
                .toList();
        List<Map<String, Object>> machines = new ArrayList<>();
        for (Machine machine : machineRepository.findAll()) {
            if (!"ACTIVE".equals(machine.getStatus())) {
                continue;
            }
            List<long[]> intervals = new ArrayList<>();
            if (machine.getCalendarId() != null) {
                for (CalendarInterval ci : calendarIntervalRepository
                        .findByCalendarIdOrderByStartAt(machine.getCalendarId())) {
                    if ("WORK".equals(ci.getIntervalType())) {
                        intervals.add(new long[]{minutesBetween(simStart, ci.getStartAt()),
                                minutesBetween(simStart, ci.getEndAt())});
                    }
                }
                for (CalendarInterval ci : calendarIntervalRepository
                        .findByCalendarIdOrderByStartAt(machine.getCalendarId())) {
                    if (!"WORK".equals(ci.getIntervalType())) {
                        intervals = subtract(intervals, minutesBetween(simStart, ci.getStartAt()),
                                minutesBetween(simStart, ci.getEndAt()));
                    }
                }
            }
            for (Event e : breakdowns) {
                if (e.getMachineId() != null && e.getMachineId().equals(machine.getId())) {
                    long from = minutesBetween(simStart, e.getOccurredAt());
                    long to = minutesBetween(simStart, e.getRepairEndAt());
                    intervals = subtract(intervals, from, to);
                }
            }
            List<long[]> merged = mergeAndClip(intervals);
            List<List<Long>> available = new ArrayList<>();
            for (long[] iv : merged) {
                available.add(List.of(iv[0], iv[1]));
            }
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("machineId", machine.getId());
            entry.put("workCenterId", machine.getWorkCenterId() != null ? machine.getWorkCenterId() : "");
            entry.put("productFamilies", machine.getProductFamilies() != null ? machine.getProductFamilies() : List.of());
            entry.put("availableIntervals", available);
            machines.add(entry);
        }
        machines.sort(Comparator.comparing(m -> (String) m.get("machineId")));
        return machines;
    }

    private List<Map<String, Object>> buildOrders(String mode, List<String> orderIds,
                                                  String oldPlanVersionId, OffsetDateTime simStart) {
        List<ProductionOrder> orders;
        if ("BASELINE".equals(mode)) {
            if (orderIds != null && !orderIds.isEmpty()) {
                orders = new ArrayList<>();
                for (String id : orderIds) {
                    orders.add(productionOrderRepository.findById(id)
                            .or(() -> productionOrderRepository.findByOrderCode(id))
                            .orElseThrow(() -> BizException.notFound("订单不存在: " + id)));
                }
            } else {
                orders = new ArrayList<>(
                        productionOrderRepository.findByStatusIn(List.of("WAITING")));
            }
        } else {
            Set<String> included = new HashSet<>();
            List<ScheduleOperation> oldOps = scheduleOperationRepository.findByPlanVersionId(oldPlanVersionId);
            Map<String, OrderOperation> opById = new HashMap<>();
            for (OrderOperation oo : orderOperationRepository.findAll()) {
                opById.put(oo.getId(), oo);
            }
            for (ScheduleOperation so : oldOps) {
                OrderOperation oo = opById.get(so.getOperationId());
                if (oo != null) {
                    included.add(oo.getOrderId());
                }
            }
            for (ProductionOrder o : productionOrderRepository.findByStatusIn(List.of("WAITING"))) {
                included.add(o.getId());
            }
            orders = new ArrayList<>();
            for (String id : included) {
                productionOrderRepository.findById(id).ifPresent(orders::add);
            }
        }
        orders.sort(Comparator.comparing(ProductionOrder::getId));
        List<Map<String, Object>> result = new ArrayList<>();
        for (ProductionOrder order : orders) {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("orderId", order.getId());
            entry.put("productFamily", order.getProductFamily());
            entry.put("quantity", order.getQuantity());
            entry.put("arrivalMinutes", Math.max(0, minutesBetween(simStart, order.getArrivalAt())));
            entry.put("dueMinutes", Math.max(0, minutesBetween(simStart, order.getDueAt())));
            entry.put("priority", order.getPriority());
            List<Map<String, Object>> ops = new ArrayList<>();
            for (OrderOperation oo : orderOperationRepository.findByOrderIdOrderBySequenceNo(order.getId())) {
                Map<String, Object> op = new LinkedHashMap<>();
                op.put("operationId", oo.getId());
                op.put("seqNo", oo.getSequenceNo());
                op.put("candidates", oo.getCandidates());
                ops.add(op);
            }
            entry.put("operations", ops);
            result.add(entry);
        }
        return result;
    }

    static long minutesBetween(OffsetDateTime from, OffsetDateTime to) {
        return Duration.between(from.toInstant(), to.toInstant()).toMinutes();
    }

    private static List<long[]> subtract(List<long[]> intervals, long from, long to) {
        List<long[]> result = new ArrayList<>();
        for (long[] iv : intervals) {
            if (to <= iv[0] || from >= iv[1]) {
                result.add(iv);
                continue;
            }
            if (from > iv[0]) {
                result.add(new long[]{iv[0], Math.min(from, iv[1])});
            }
            if (to < iv[1]) {
                result.add(new long[]{Math.max(to, iv[0]), iv[1]});
            }
        }
        return result;
    }

    private static List<long[]> mergeAndClip(List<long[]> intervals) {
        List<long[]> sorted = new ArrayList<>();
        for (long[] iv : intervals) {
            long a = Math.max(0, iv[0]);
            long b = Math.max(0, iv[1]);
            if (b > a) {
                sorted.add(new long[]{a, b});
            }
        }
        sorted.sort(Comparator.comparingLong(iv -> iv[0]));
        List<long[]> merged = new ArrayList<>();
        for (long[] iv : sorted) {
            if (!merged.isEmpty() && iv[0] <= merged.get(merged.size() - 1)[1]) {
                long[] last = merged.get(merged.size() - 1);
                last[1] = Math.max(last[1], iv[1]);
            } else {
                merged.add(iv);
            }
        }
        return merged;
    }
}
