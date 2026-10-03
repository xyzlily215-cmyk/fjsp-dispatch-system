package com.fjsp.business.service;

import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import com.fjsp.business.common.BizException;
import com.fjsp.business.dto.CalendarIntervalRequest;
import com.fjsp.business.dto.MachineStatusRequest;
import com.fjsp.business.dto.MachineUpsertRequest;
import com.fjsp.business.dto.OrderUpdateRequest;
import com.fjsp.business.dto.OrderUpsertRequest;
import com.fjsp.business.dto.TemplateStatusRequest;
import com.fjsp.business.dto.TemplateUpsertRequest;
import com.fjsp.business.entity.CalendarInterval;
import com.fjsp.business.entity.Machine;
import com.fjsp.business.entity.OrderOperation;
import com.fjsp.business.entity.ProcessOperation;
import com.fjsp.business.entity.ProcessTemplate;
import com.fjsp.business.entity.ProductionOrder;
import com.fjsp.business.repository.CalendarIntervalRepository;
import com.fjsp.business.repository.MachineRepository;
import com.fjsp.business.repository.OrderOperationRepository;
import com.fjsp.business.repository.ProcessOperationRepository;
import com.fjsp.business.repository.ProcessTemplateRepository;
import com.fjsp.business.repository.ProductionOrderRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class BaseDataWriteService {

    private static final Set<String> MACHINE_STATUSES = Set.of("ACTIVE", "INACTIVE");
    private static final Set<String> UNAVAILABLE_TYPES = Set.of("BREAK", "HOLIDAY", "REPAIR");
    private static final Set<String> TEMPLATE_STATUSES = Set.of("ACTIVE", "INACTIVE", "DRAFT");

    private final MachineRepository machineRepository;
    private final CalendarIntervalRepository calendarIntervalRepository;
    private final ProcessTemplateRepository processTemplateRepository;
    private final ProcessOperationRepository processOperationRepository;
    private final ProductionOrderRepository productionOrderRepository;
    private final OrderOperationRepository orderOperationRepository;
    private final IdempotencyService idempotencyService;
    private final AuditService auditService;

    public BaseDataWriteService(MachineRepository machineRepository,
                                CalendarIntervalRepository calendarIntervalRepository,
                                ProcessTemplateRepository processTemplateRepository,
                                ProcessOperationRepository processOperationRepository,
                                ProductionOrderRepository productionOrderRepository,
                                OrderOperationRepository orderOperationRepository,
                                IdempotencyService idempotencyService,
                                AuditService auditService) {
        this.machineRepository = machineRepository;
        this.calendarIntervalRepository = calendarIntervalRepository;
        this.processTemplateRepository = processTemplateRepository;
        this.processOperationRepository = processOperationRepository;
        this.productionOrderRepository = productionOrderRepository;
        this.orderOperationRepository = orderOperationRepository;
        this.idempotencyService = idempotencyService;
        this.auditService = auditService;
    }

    /* ---------------- 设备 ---------------- */

    @Transactional
    public Map<String, Object> createMachine(String idempotencyKey, MachineUpsertRequest req) {
        var replay = idempotencyService.findReplay(idempotencyKey, req);
        if (replay.isPresent()) {
            return castMap(replay.get());
        }
        validateMachine(req);
        if (machineRepository.findAll().stream().anyMatch(m -> m.getMachineCode().equals(req.machineCode()))) {
            throw BizException.duplicate("设备编码重复: " + req.machineCode());
        }
        Machine machine = new Machine();
        machine.setId(req.machineCode());
        applyMachine(machine, req);
        machine.setStatus("ACTIVE");
        machineRepository.save(machine);
        auditService.record("MACHINE_CREATE", "machine", machine.getId(), "machineCode=" + machine.getMachineCode());
        Map<String, Object> data = machineToMap(machine);
        idempotencyService.store(idempotencyKey, req, data);
        return data;
    }

    @Transactional
    public Map<String, Object> updateMachine(String idempotencyKey, String machineId, MachineUpsertRequest req) {
        var replay = idempotencyService.findReplay(idempotencyKey, req);
        if (replay.isPresent()) {
            return castMap(replay.get());
        }
        Machine machine = machineRepository.findById(machineId)
                .orElseThrow(() -> BizException.notFound("设备不存在: " + machineId));
        validateMachine(req);
        if (!machine.getMachineCode().equals(req.machineCode())
                && machineRepository.findAll().stream().anyMatch(m -> m.getMachineCode().equals(req.machineCode()))) {
            throw BizException.duplicate("设备编码重复: " + req.machineCode());
        }
        applyMachine(machine, req);
        machineRepository.save(machine);
        auditService.record("MACHINE_UPDATE", "machine", machine.getId(), "machineCode=" + machine.getMachineCode());
        Map<String, Object> data = machineToMap(machine);
        idempotencyService.store(idempotencyKey, req, data);
        return data;
    }

    @Transactional
    public Map<String, Object> changeMachineStatus(String idempotencyKey, String machineId, MachineStatusRequest req) {
        var replay = idempotencyService.findReplay(idempotencyKey, req);
        if (replay.isPresent()) {
            return castMap(replay.get());
        }
        if (req == null || req.status() == null || !MACHINE_STATUSES.contains(req.status())) {
            throw BizException.validation("status 必须是 ACTIVE / INACTIVE");
        }
        Machine machine = machineRepository.findById(machineId)
                .orElseThrow(() -> BizException.notFound("设备不存在: " + machineId));
        machine.setStatus(req.status());
        machineRepository.save(machine);
        auditService.record("MACHINE_STATUS", "machine", machine.getId(), "status=" + req.status());
        Map<String, Object> data = machineToMap(machine);
        idempotencyService.store(idempotencyKey, req, data);
        return data;
    }

    private void validateMachine(MachineUpsertRequest req) {
        if (req == null || req.machineCode() == null || req.machineCode().isBlank()) {
            throw BizException.validation("machineCode 必填");
        }
        if (req.workCenterId() == null || req.workCenterId().isBlank()) {
            throw BizException.validation("workCenterId 必填");
        }
        if (req.productFamilies() == null || req.productFamilies().isEmpty()) {
            throw BizException.validation("productFamilies 至少选择一个能力产品族");
        }
    }

    private void applyMachine(Machine machine, MachineUpsertRequest req) {
        machine.setMachineCode(req.machineCode());
        machine.setMachineName(req.machineName());
        machine.setWorkCenterId(req.workCenterId());
        machine.setCalendarId(req.calendarId());
        machine.setProductFamilies(new ArrayList<>(req.productFamilies()));
        machine.setRemark(req.remark());
    }

    private Map<String, Object> machineToMap(Machine machine) {
        Map<String, Object> entry = new LinkedHashMap<>();
        entry.put("machineId", machine.getId());
        entry.put("machineCode", machine.getMachineCode());
        entry.put("machineName", machine.getMachineName());
        entry.put("workCenterId", machine.getWorkCenterId());
        entry.put("calendarId", machine.getCalendarId());
        entry.put("productFamilies", machine.getProductFamilies());
        entry.put("status", machine.getStatus());
        entry.put("remark", machine.getRemark());
        return entry;
    }

    /* ---------------- 设备日历不可用区间 ---------------- */

    public List<Map<String, Object>> listCalendarIntervals(String calendarId) {
        List<Map<String, Object>> result = new ArrayList<>();
        for (CalendarInterval ci : calendarIntervalRepository.findByCalendarIdOrderByStartAt(calendarId)) {
            result.add(intervalToMap(ci));
        }
        return result;
    }

    @Transactional
    public Map<String, Object> addCalendarInterval(String idempotencyKey, String calendarId,
                                                   CalendarIntervalRequest req) {
        var replay = idempotencyService.findReplay(idempotencyKey, req);
        if (replay.isPresent()) {
            return castMap(replay.get());
        }
        if (req == null || req.intervalType() == null || !UNAVAILABLE_TYPES.contains(req.intervalType())) {
            throw BizException.validation("intervalType 必须是 BREAK / HOLIDAY / REPAIR");
        }
        if (req.startAt() == null || req.endAt() == null) {
            throw BizException.validation("startAt/endAt 必填");
        }
        OffsetDateTime startAt = OffsetDateTime.parse(req.startAt());
        OffsetDateTime endAt = OffsetDateTime.parse(req.endAt());
        if (!endAt.isAfter(startAt)) {
            throw BizException.validation("结束时间必须晚于开始时间");
        }
        for (CalendarInterval existing : calendarIntervalRepository.findByCalendarIdOrderByStartAt(calendarId)) {
            if ("WORK".equals(existing.getIntervalType())) {
                continue;
            }
            if (startAt.isBefore(existing.getEndAt()) && endAt.isAfter(existing.getStartAt())) {
                throw BizException.validation("不可用区间与已有区间 [" + existing.getStartAt() + " ~ "
                        + existing.getEndAt() + "] 重叠");
            }
        }
        CalendarInterval interval = new CalendarInterval();
        interval.setId(UUID.randomUUID().toString());
        interval.setCalendarId(calendarId);
        interval.setStartAt(startAt);
        interval.setEndAt(endAt);
        interval.setIntervalType(req.intervalType());
        interval.setNote(req.note());
        calendarIntervalRepository.save(interval);
        auditService.record("CALENDAR_INTERVAL_ADD", "calendar", calendarId,
                "type=" + req.intervalType() + ", start=" + startAt + ", end=" + endAt);
        Map<String, Object> data = intervalToMap(interval);
        idempotencyService.store(idempotencyKey, req, data);
        return data;
    }

    private Map<String, Object> intervalToMap(CalendarInterval ci) {
        Map<String, Object> entry = new LinkedHashMap<>();
        entry.put("intervalId", ci.getId());
        entry.put("calendarId", ci.getCalendarId());
        entry.put("intervalType", ci.getIntervalType());
        entry.put("startAt", ci.getStartAt());
        entry.put("endAt", ci.getEndAt());
        entry.put("note", ci.getNote());
        return entry;
    }

    /* ---------------- 工艺模板 ---------------- */

    @Transactional
    public Map<String, Object> createTemplate(String idempotencyKey, TemplateUpsertRequest req) {
        var replay = idempotencyService.findReplay(idempotencyKey, req);
        if (replay.isPresent()) {
            return castMap(replay.get());
        }
        if (req == null || req.templateCode() == null || req.templateCode().isBlank()
                || req.productFamily() == null || req.productFamily().isBlank()) {
            throw BizException.validation("templateCode/productFamily 必填");
        }
        boolean duplicated = processTemplateRepository.findAll().stream()
                .anyMatch(t -> t.getTemplateCode().equals(req.templateCode()) && t.getTemplateVersion() == 1);
        if (duplicated) {
            throw BizException.duplicate("模板编码已存在: " + req.templateCode() + "，如需新版本请使用复制功能");
        }
        validateTemplateOperations(req.operations());

        ProcessTemplate template = new ProcessTemplate();
        template.setId(UUID.randomUUID().toString());
        template.setTemplateCode(req.templateCode());
        template.setProductFamily(req.productFamily());
        template.setTemplateVersion(1);
        template.setStatus("ACTIVE");
        processTemplateRepository.save(template);
        saveTemplateOperations(template.getId(), req.operations());
        auditService.record("TEMPLATE_CREATE", "process_template", template.getId(),
                "templateCode=" + req.templateCode());
        Map<String, Object> data = templateToMap(template);
        idempotencyService.store(idempotencyKey, req, data);
        return data;
    }

    @Transactional
    public Map<String, Object> changeTemplateStatus(String idempotencyKey, String templateId,
                                                    TemplateStatusRequest req) {
        var replay = idempotencyService.findReplay(idempotencyKey, req);
        if (replay.isPresent()) {
            return castMap(replay.get());
        }
        if (req == null || req.status() == null || !TEMPLATE_STATUSES.contains(req.status())) {
            throw BizException.validation("status 必须是 ACTIVE / INACTIVE / DRAFT");
        }
        ProcessTemplate template = processTemplateRepository.findById(templateId)
                .orElseThrow(() -> BizException.notFound("工艺模板不存在: " + templateId));
        if ("ACTIVE".equals(req.status())) {
            List<ProcessOperation> ops = processOperationRepository.findByTemplateIdOrderBySequenceNo(templateId);
            validateTemplateOperations(toInputs(ops));
        }
        template.setStatus(req.status());
        processTemplateRepository.save(template);
        auditService.record("TEMPLATE_STATUS", "process_template", templateId, "status=" + req.status());
        Map<String, Object> data = templateToMap(template);
        idempotencyService.store(idempotencyKey, req, data);
        return data;
    }

    @Transactional
    public Map<String, Object> copyTemplate(String idempotencyKey, String templateId) {
        var replay = idempotencyService.findReplay(idempotencyKey, Map.of("templateId", templateId));
        if (replay.isPresent()) {
            return castMap(replay.get());
        }
        ProcessTemplate source = processTemplateRepository.findById(templateId)
                .orElseThrow(() -> BizException.notFound("工艺模板不存在: " + templateId));
        int nextVersion = processTemplateRepository.findAll().stream()
                .filter(t -> t.getTemplateCode().equals(source.getTemplateCode()))
                .map(ProcessTemplate::getTemplateVersion)
                .max(Comparator.naturalOrder())
                .orElse(0) + 1;

        ProcessTemplate copy = new ProcessTemplate();
        copy.setId(UUID.randomUUID().toString());
        copy.setTemplateCode(source.getTemplateCode());
        copy.setProductFamily(source.getProductFamily());
        copy.setTemplateVersion(nextVersion);
        copy.setStatus("DRAFT");
        processTemplateRepository.save(copy);
        for (ProcessOperation po : processOperationRepository.findByTemplateIdOrderBySequenceNo(templateId)) {
            ProcessOperation op = new ProcessOperation();
            op.setId(UUID.randomUUID().toString());
            op.setTemplateId(copy.getId());
            op.setSequenceNo(po.getSequenceNo());
            op.setOperationCode(po.getOperationCode());
            op.setDefaultCandidates(po.getDefaultCandidates() != null
                    ? new ArrayList<>(po.getDefaultCandidates()) : List.of());
            processOperationRepository.save(op);
        }
        auditService.record("TEMPLATE_COPY", "process_template", copy.getId(),
                "from=" + source.getTemplateCode() + " v" + source.getTemplateVersion() + " -> v" + nextVersion);
        Map<String, Object> data = templateToMap(copy);
        idempotencyService.store(idempotencyKey, Map.of("templateId", templateId), data);
        return data;
    }

    private List<TemplateUpsertRequest.TemplateOperationInput> toInputs(List<ProcessOperation> ops) {
        List<TemplateUpsertRequest.TemplateOperationInput> inputs = new ArrayList<>();
        for (ProcessOperation po : ops) {
            List<TemplateUpsertRequest.CandidateInput> candidates = new ArrayList<>();
            if (po.getDefaultCandidates() != null) {
                for (Map<String, Object> c : po.getDefaultCandidates()) {
                    candidates.add(new TemplateUpsertRequest.CandidateInput(
                            c.get("machineId") != null ? String.valueOf(c.get("machineId")) : null,
                            c.get("setupMinutes") != null ? ((Number) c.get("setupMinutes")).intValue() : null,
                            c.get("processMinutes") != null ? ((Number) c.get("processMinutes")).intValue() : null));
                }
            }
            inputs.add(new TemplateUpsertRequest.TemplateOperationInput(
                    po.getSequenceNo(), po.getOperationCode(), candidates));
        }
        return inputs;
    }

    private void validateTemplateOperations(List<TemplateUpsertRequest.TemplateOperationInput> operations) {
        if (operations == null || operations.isEmpty()) {
            throw BizException.validation("模板至少需要一道工序");
        }
        Integer prev = null;
        for (TemplateUpsertRequest.TemplateOperationInput op : operations) {
            if (op.sequenceNo() == null) {
                throw BizException.validation("工序序号必填");
            }
            if (prev != null && op.sequenceNo() <= prev) {
                throw BizException.validation("工序序号必须严格递增且不重复（当前 " + op.sequenceNo() + " 在 " + prev + " 之后）");
            }
            prev = op.sequenceNo();
            if (op.operationCode() == null || op.operationCode().isBlank()) {
                throw BizException.validation("工序 " + op.sequenceNo() + " 的工序名称/编码必填");
            }
            if (op.defaultCandidates() == null || op.defaultCandidates().isEmpty()) {
                throw BizException.validation("工序 " + op.operationCode() + " 的候选设备不能为空");
            }
            for (TemplateUpsertRequest.CandidateInput c : op.defaultCandidates()) {
                if (c.machineId() == null || c.machineId().isBlank()) {
                    throw BizException.validation("工序 " + op.operationCode() + " 存在未指定设备的候选");
                }
                if (machineRepository.findById(c.machineId()).isEmpty()) {
                    throw BizException.validation("候选设备不存在: " + c.machineId());
                }
                if (c.setupMinutes() == null || c.setupMinutes() <= 0
                        || c.processMinutes() == null || c.processMinutes() <= 0) {
                    throw BizException.validation("工序 " + op.operationCode() + " 设备 " + c.machineId()
                            + " 的准备/加工时长必须大于 0");
                }
            }
        }
    }

    private void saveTemplateOperations(String templateId,
                                        List<TemplateUpsertRequest.TemplateOperationInput> operations) {
        for (TemplateUpsertRequest.TemplateOperationInput op : operations) {
            ProcessOperation po = new ProcessOperation();
            po.setId(UUID.randomUUID().toString());
            po.setTemplateId(templateId);
            po.setSequenceNo(op.sequenceNo());
            po.setOperationCode(op.operationCode());
            List<Map<String, Object>> candidates = new ArrayList<>();
            for (TemplateUpsertRequest.CandidateInput c : op.defaultCandidates()) {
                Map<String, Object> candidate = new LinkedHashMap<>();
                candidate.put("machineId", c.machineId());
                candidate.put("setupMinutes", c.setupMinutes());
                candidate.put("processMinutes", c.processMinutes());
                candidates.add(candidate);
            }
            po.setDefaultCandidates(candidates);
            processOperationRepository.save(po);
        }
    }

    private Map<String, Object> templateToMap(ProcessTemplate template) {
        Map<String, Object> entry = new LinkedHashMap<>();
        entry.put("templateId", template.getId());
        entry.put("templateCode", template.getTemplateCode());
        entry.put("productFamily", template.getProductFamily());
        entry.put("templateVersion", template.getTemplateVersion());
        entry.put("status", template.getStatus());
        List<Map<String, Object>> ops = new ArrayList<>();
        for (ProcessOperation po : processOperationRepository.findByTemplateIdOrderBySequenceNo(template.getId())) {
            Map<String, Object> opEntry = new LinkedHashMap<>();
            opEntry.put("sequenceNo", po.getSequenceNo());
            opEntry.put("operationCode", po.getOperationCode());
            opEntry.put("defaultCandidates", po.getDefaultCandidates());
            ops.add(opEntry);
        }
        entry.put("operations", ops);
        return entry;
    }

    /* ---------------- 订单 ---------------- */

    @Transactional
    public Map<String, Object> createOrder(String idempotencyKey, OrderUpsertRequest req) {
        var replay = idempotencyService.findReplay(idempotencyKey, req);
        if (replay.isPresent()) {
            return castMap(replay.get());
        }
        if (req == null || req.orderCode() == null || req.orderCode().isBlank()) {
            throw BizException.validation("orderCode 必填");
        }
        if (productionOrderRepository.existsByOrderCode(req.orderCode())) {
            throw BizException.duplicate("同车间订单号重复: " + req.orderCode());
        }
        validateOrderFields(req.productFamily(), req.quantity(), req.priority(), req.arrivalAt(), req.dueAt());

        ProcessTemplate template;
        if (req.templateId() != null && !req.templateId().isBlank()) {
            template = processTemplateRepository.findById(req.templateId())
                    .orElseThrow(() -> BizException.validation("工艺模板不存在: " + req.templateId()));
            if (!"ACTIVE".equals(template.getStatus())) {
                throw BizException.validation("工艺模板未启用: " + template.getTemplateCode());
            }
            if (!template.getProductFamily().equals(req.productFamily())) {
                throw BizException.validation("模板产品族 " + template.getProductFamily()
                        + " 与订单产品族 " + req.productFamily() + " 不一致");
            }
        } else {
            template = processTemplateRepository
                    .findFirstByProductFamilyAndStatusOrderByTemplateVersionDesc(req.productFamily(), "ACTIVE")
                    .orElseThrow(() -> BizException.validation("产品族无启用中的工艺模板: " + req.productFamily()));
        }
        List<ProcessOperation> templateOps = processOperationRepository
                .findByTemplateIdOrderBySequenceNo(template.getId());
        if (templateOps.isEmpty()) {
            throw BizException.validation("工艺模板没有工序定义: " + template.getTemplateCode());
        }

        ProductionOrder order = new ProductionOrder();
        order.setId(req.orderCode());
        order.setOrderCode(req.orderCode());
        order.setProductFamily(req.productFamily());
        order.setQuantity(req.quantity());
        order.setArrivalAt(OffsetDateTime.parse(req.arrivalAt()));
        order.setDueAt(OffsetDateTime.parse(req.dueAt()));
        order.setPriority(req.priority());
        order.setStatus("WAITING");
        order.setTemplateId(template.getId());
        productionOrderRepository.save(order);

        List<String> operationIds = new ArrayList<>();
        for (ProcessOperation po : templateOps) {
            OrderOperation oo = new OrderOperation();
            oo.setId(req.orderCode() + "-" + po.getSequenceNo());
            oo.setOrderId(order.getId());
            oo.setSequenceNo(po.getSequenceNo());
            oo.setStatus("NOT_STARTED");
            oo.setCandidates(po.getDefaultCandidates());
            orderOperationRepository.save(oo);
            operationIds.add(oo.getId());
        }
        auditService.record("ORDER_CREATE", "order", order.getId(),
                "orderCode=" + order.getOrderCode() + ", template=" + template.getTemplateCode());
        Map<String, Object> data = orderToMap(order);
        data.put("operationIds", operationIds);
        idempotencyService.store(idempotencyKey, req, data);
        return data;
    }

    @Transactional
    public Map<String, Object> updateOrder(String idempotencyKey, String orderId, OrderUpdateRequest req) {
        var replay = idempotencyService.findReplay(idempotencyKey, req);
        if (replay.isPresent()) {
            return castMap(replay.get());
        }
        ProductionOrder order = productionOrderRepository.findById(orderId)
                .or(() -> productionOrderRepository.findByOrderCode(orderId))
                .orElseThrow(() -> BizException.notFound("订单不存在: " + orderId));
        if (!"WAITING".equals(order.getStatus())) {
            throw BizException.stateConflict("只有未排程（WAITING）的订单可以编辑，当前状态: " + order.getStatus());
        }
        Integer quantity = req != null && req.quantity() != null ? req.quantity() : order.getQuantity();
        Integer priority = req != null && req.priority() != null ? req.priority() : order.getPriority();
        String arrivalAt = req != null && req.arrivalAt() != null ? req.arrivalAt() : order.getArrivalAt().toString();
        String dueAt = req != null && req.dueAt() != null ? req.dueAt() : order.getDueAt().toString();
        validateOrderFields(order.getProductFamily(), quantity, priority, arrivalAt, dueAt);

        order.setQuantity(quantity);
        order.setPriority(priority);
        order.setArrivalAt(OffsetDateTime.parse(arrivalAt));
        order.setDueAt(OffsetDateTime.parse(dueAt));
        productionOrderRepository.save(order);
        auditService.record("ORDER_UPDATE", "order", order.getId(), "orderCode=" + order.getOrderCode());
        Map<String, Object> data = orderToMap(order);
        idempotencyService.store(idempotencyKey, req, data);
        return data;
    }

    private void validateOrderFields(String productFamily, Integer quantity, Integer priority,
                                     String arrivalAt, String dueAt) {
        if (productFamily == null || productFamily.isBlank()) {
            throw BizException.validation("productFamily 必填");
        }
        if (quantity == null || quantity <= 0) {
            throw BizException.validation("quantity 必须是正整数");
        }
        if (priority == null || priority < 1 || priority > 5) {
            throw BizException.validation("priority 必须在 1-5 之间");
        }
        if (arrivalAt == null || dueAt == null) {
            throw BizException.validation("arrivalAt/dueAt 必填");
        }
        OffsetDateTime arrival = OffsetDateTime.parse(arrivalAt);
        OffsetDateTime due = OffsetDateTime.parse(dueAt);
        if (due.isBefore(arrival)) {
            throw BizException.validation("dueAt 不能早于 arrivalAt");
        }
    }

    private Map<String, Object> orderToMap(ProductionOrder order) {
        Map<String, Object> entry = new LinkedHashMap<>();
        entry.put("orderId", order.getId());
        entry.put("orderCode", order.getOrderCode());
        entry.put("productFamily", order.getProductFamily());
        entry.put("quantity", order.getQuantity());
        entry.put("arrivalAt", order.getArrivalAt());
        entry.put("dueAt", order.getDueAt());
        entry.put("priority", order.getPriority());
        entry.put("status", order.getStatus());
        entry.put("templateId", order.getTemplateId());
        return entry;
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> castMap(Object stored) {
        return (Map<String, Object>) stored;
    }
}
