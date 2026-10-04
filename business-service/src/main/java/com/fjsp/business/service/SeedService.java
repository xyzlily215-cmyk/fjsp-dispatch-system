package com.fjsp.business.service;

import java.io.InputStream;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fjsp.business.config.FjspProperties;
import com.fjsp.business.entity.CalendarInterval;
import com.fjsp.business.entity.Machine;
import com.fjsp.business.entity.OperationCandidate;
import com.fjsp.business.entity.OrderOperation;
import com.fjsp.business.entity.ProcessOperation;
import com.fjsp.business.entity.ProcessTemplate;
import com.fjsp.business.entity.ProductionOrder;
import com.fjsp.business.entity.WorkCalendar;
import com.fjsp.business.repository.CalendarIntervalRepository;
import com.fjsp.business.repository.MachineRepository;
import com.fjsp.business.repository.OperationCandidateRepository;
import com.fjsp.business.repository.OrderOperationRepository;
import com.fjsp.business.repository.ProcessOperationRepository;
import com.fjsp.business.repository.ProcessTemplateRepository;
import com.fjsp.business.repository.ProductionOrderRepository;
import com.fjsp.business.repository.WorkCalendarRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

@Component
public class SeedService implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(SeedService.class);
    private static final String SEED_RESOURCE = "seed/demo_instance.json";
    private static final java.time.format.DateTimeFormatter ORDER_CODE_DATE =
            java.time.format.DateTimeFormatter.ofPattern("yyyyMMdd");

    private final ObjectMapper objectMapper;
    private final FjspProperties properties;
    private final MachineRepository machineRepository;
    private final WorkCalendarRepository workCalendarRepository;
    private final CalendarIntervalRepository calendarIntervalRepository;
    private final ProcessTemplateRepository processTemplateRepository;
    private final ProcessOperationRepository processOperationRepository;
    private final OperationCandidateRepository operationCandidateRepository;
    private final ProductionOrderRepository productionOrderRepository;
    private final OrderOperationRepository orderOperationRepository;

    private volatile JsonNode demoInstance;

    public SeedService(ObjectMapper objectMapper, FjspProperties properties,
                       MachineRepository machineRepository,
                       WorkCalendarRepository workCalendarRepository,
                       CalendarIntervalRepository calendarIntervalRepository,
                       ProcessTemplateRepository processTemplateRepository,
                       ProcessOperationRepository processOperationRepository,
                       OperationCandidateRepository operationCandidateRepository,
                       ProductionOrderRepository productionOrderRepository,
                       OrderOperationRepository orderOperationRepository) {
        this.objectMapper = objectMapper;
        this.properties = properties;
        this.machineRepository = machineRepository;
        this.workCalendarRepository = workCalendarRepository;
        this.calendarIntervalRepository = calendarIntervalRepository;
        this.processTemplateRepository = processTemplateRepository;
        this.processOperationRepository = processOperationRepository;
        this.operationCandidateRepository = operationCandidateRepository;
        this.productionOrderRepository = productionOrderRepository;
        this.orderOperationRepository = orderOperationRepository;
    }

    @Override
    public void run(ApplicationArguments args) {
        if (machineRepository.count() > 0) {
            log.info("seed skipped: machine table not empty");
            return;
        }
        seed();
    }

    @Transactional
    public Map<String, Object> seed() {
        JsonNode root = demoInstance();
        OffsetDateTime simStart = seedSimulationStartAt(root);

        int machineCount = 0;
        for (JsonNode m : root.get("machines")) {
            String machineId = m.get("machineId").asText();
            WorkCalendar calendar = new WorkCalendar();
            calendar.setId("CAL-" + machineId);
            calendar.setCalendarCode("CAL-" + machineId);
            calendar.setCalendarVersion(1);
            calendar.setStatus("ACTIVE");
            workCalendarRepository.save(calendar);

            for (JsonNode iv : m.get("availableIntervals")) {
                CalendarInterval interval = new CalendarInterval();
                interval.setId(UUID.randomUUID().toString());
                interval.setCalendarId(calendar.getId());
                interval.setStartAt(simStart.plusMinutes(iv.get(0).asLong()));
                interval.setEndAt(simStart.plusMinutes(iv.get(1).asLong()));
                interval.setIntervalType("WORK");
                calendarIntervalRepository.save(interval);
            }

            Machine machine = new Machine();
            machine.setId(machineId);
            machine.setMachineCode(machineId);
            machine.setWorkCenterId(m.get("workCenterId").asText());
            machine.setCalendarId(calendar.getId());
            List<String> families = new ArrayList<>();
            m.get("productFamilies").forEach(f -> families.add(f.asText()));
            machine.setProductFamilies(families);
            machine.setStatus("ACTIVE");
            machineRepository.save(machine);
            machineCount++;
        }

        Map<String, List<JsonNode>> ordersByFamily = new LinkedHashMap<>();
        for (JsonNode o : root.get("orders")) {
            ordersByFamily.computeIfAbsent(o.get("productFamily").asText(), k -> new ArrayList<>()).add(o);
        }

        Map<String, String> familyTemplateId = new HashMap<>();
        int templateCount = 0;
        for (Map.Entry<String, List<JsonNode>> entry : ordersByFamily.entrySet()) {
            String family = entry.getKey();
            ProcessTemplate template = new ProcessTemplate();
            template.setId(UUID.randomUUID().toString());
            template.setTemplateCode("TPL-" + family);
            template.setProductFamily(family);
            template.setTemplateVersion(1);
            template.setStatus("ACTIVE");
            processTemplateRepository.save(template);
            familyTemplateId.put(family, template.getId());
            templateCount++;

            Map<Integer, Map<String, JsonNode>> merged = new LinkedHashMap<>();
            for (JsonNode order : entry.getValue()) {
                for (JsonNode op : order.get("operations")) {
                    int seq = op.get("seqNo").asInt();
                    Map<String, JsonNode> byMachine = merged.computeIfAbsent(seq, k -> new LinkedHashMap<>());
                    for (JsonNode c : op.get("candidates")) {
                        byMachine.putIfAbsent(c.get("machineId").asText(), c);
                    }
                }
            }
            merged.entrySet().stream()
                    .sorted(Comparator.comparingInt(Map.Entry::getKey))
                    .forEach(seqEntry -> {
                        ProcessOperation po = new ProcessOperation();
                        po.setId(UUID.randomUUID().toString());
                        po.setTemplateId(template.getId());
                        po.setSequenceNo(seqEntry.getKey());
                        po.setOperationCode("OP-" + seqEntry.getKey());
                        List<Map<String, Object>> defaults = new ArrayList<>();
                        for (JsonNode c : seqEntry.getValue().values()) {
                            Map<String, Object> cand = new LinkedHashMap<>();
                            cand.put("machineId", c.get("machineId").asText());
                            cand.put("processMinutes", c.get("processMinutes").asInt());
                            cand.put("setupMinutes", c.get("setupMinutes").asInt());
                            defaults.add(cand);

                            OperationCandidate oc = new OperationCandidate();
                            oc.setId(UUID.randomUUID().toString());
                            oc.setOperationId(po.getId());
                            oc.setMachineId(c.get("machineId").asText());
                            oc.setProcessMinutes(c.get("processMinutes").asInt());
                            oc.setSetupMinutes(c.get("setupMinutes").asInt());
                            operationCandidateRepository.save(oc);
                        }
                        po.setDefaultCandidates(defaults);
                        processOperationRepository.save(po);
                    });
        }

        int orderCount = 0;
        int operationCount = 0;
        for (JsonNode o : root.get("orders")) {
            String orderId = o.get("orderId").asText();
            String numeric = orderId.replaceAll("\\D", "");
            ProductionOrder order = new ProductionOrder();
            order.setId(orderId);
            order.setOrderCode("ORD-" + simStart.format(ORDER_CODE_DATE)
                    + "-" + String.format("%03d", Integer.parseInt(numeric)));
            order.setProductFamily(o.get("productFamily").asText());
            order.setQuantity(o.get("quantity").asInt());
            order.setArrivalAt(simStart.plusMinutes(o.get("arrivalMinutes").asLong()));
            order.setDueAt(simStart.plusMinutes(o.get("dueMinutes").asLong()));
            order.setPriority(o.get("priority").asInt());
            order.setStatus("WAITING");
            order.setTemplateId(familyTemplateId.get(order.getProductFamily()));
            productionOrderRepository.save(order);
            orderCount++;

            for (JsonNode op : o.get("operations")) {
                OrderOperation oo = new OrderOperation();
                oo.setId(op.get("operationId").asText());
                oo.setOrderId(orderId);
                oo.setSequenceNo(op.get("seqNo").asInt());
                oo.setStatus("NOT_STARTED");
                List<Map<String, Object>> candidates = new ArrayList<>();
                for (JsonNode c : op.get("candidates")) {
                    Map<String, Object> cand = new LinkedHashMap<>();
                    cand.put("machineId", c.get("machineId").asText());
                    cand.put("processMinutes", c.get("processMinutes").asInt());
                    cand.put("setupMinutes", c.get("setupMinutes").asInt());
                    candidates.add(cand);
                }
                oo.setCandidates(candidates);
                orderOperationRepository.save(oo);
                operationCount++;
            }
        }
        log.info("seed done: {} machines, {} templates, {} orders, {} operations",
                machineCount, templateCount, orderCount, operationCount);
        Map<String, Object> summary = new LinkedHashMap<>();
        summary.put("machines", machineCount);
        summary.put("processTemplates", templateCount);
        summary.put("orders", orderCount);
        summary.put("operations", operationCount);
        summary.put("simulationStartAt", simStart.toString());
        return summary;
    }

    public JsonNode demoInstance() {
        if (demoInstance == null) {
            synchronized (this) {
                if (demoInstance == null) {
                    try (InputStream in = new ClassPathResource(SEED_RESOURCE).getInputStream()) {
                        demoInstance = objectMapper.readTree(in);
                    } catch (Exception e) {
                        throw new IllegalStateException("cannot load " + SEED_RESOURCE, e);
                    }
                }
            }
        }
        return demoInstance;
    }

    /**
     * 任务默认仿真起点（与 seed 共用同一解析入口，避免两处漂移）：
     * FIXED —— 优先 seed json 的 simulationStartAt，其次 fjsp.simulation.start-at，都没有则明确报错；
     * RELATIVE —— 取种子订单的最小到达时间（即 seed 时的基准 now），库为空时回退 now（截断到分钟）。
     */
    public OffsetDateTime defaultSimulationStartAt() {
        if (properties.getSimulation().getMode() == FjspProperties.SimulationMode.FIXED) {
            JsonNode node = demoInstance().get("simulationStartAt");
            if (node != null && !node.isNull()) {
                return OffsetDateTime.parse(node.asText());
            }
            if (properties.getSimulation().getStartAt() != null) {
                return properties.getSimulation().getStartAt();
            }
            throw new IllegalStateException(
                    "fjsp.simulation.mode=FIXED 但未提供起点：seed json 无 simulationStartAt 且 fjsp.simulation.start-at 未配置");
        }
        OffsetDateTime seededBase = productionOrderRepository.findMinArrivalAt();
        return seededBase != null
                ? seededBase
                : OffsetDateTime.now().truncatedTo(java.time.temporal.ChronoUnit.MINUTES);
    }

    /** seed/reset 时的基准：RELATIVE = 当前时间（截断到分钟）；FIXED = 与 defaultSimulationStartAt 同一优先级。 */
    private OffsetDateTime seedSimulationStartAt(JsonNode root) {
        if (properties.getSimulation().getMode() == FjspProperties.SimulationMode.FIXED) {
            JsonNode node = root.get("simulationStartAt");
            if (node != null && !node.isNull()) {
                return OffsetDateTime.parse(node.asText());
            }
            if (properties.getSimulation().getStartAt() != null) {
                return properties.getSimulation().getStartAt();
            }
            throw new IllegalStateException(
                    "fjsp.simulation.mode=FIXED 但未提供起点：seed json 无 simulationStartAt 且 fjsp.simulation.start-at 未配置");
        }
        return OffsetDateTime.now().truncatedTo(java.time.temporal.ChronoUnit.MINUTES);
    }

    public int changeoverDefault() {
        return demoInstance().path("changeoverDefault").asInt(20);
    }

    public Map<String, Integer> changeoverMatrix() {
        Map<String, Integer> matrix = new LinkedHashMap<>();
        demoInstance().path("changeoverMatrix").fields()
                .forEachRemaining(e -> matrix.put(e.getKey(), e.getValue().asInt()));
        return matrix;
    }

    public Map<String, Double> defaultObjectiveWeights(String mode) {
        Map<String, Double> weights = new LinkedHashMap<>();
        if ("BASELINE".equals(mode)) {
            JsonNode ow = demoInstance().path("objectiveWeights");
            weights.put("makespan", ow.path("makespan").asDouble(0.4));
            weights.put("weightedTardiness", ow.path("weightedTardiness").asDouble(0.4));
            weights.put("loadImbalance", ow.path("loadImbalance").asDouble(0.2));
        } else {
            weights.put("weightedTardiness", 0.4);
            weights.put("makespan", 0.3);
            weights.put("deltaPlan", 0.2);
            weights.put("machineChange", 0.1);
        }
        return weights;
    }

    public Map<String, Object> defaultAlgorithmParams() {
        Map<String, Object> params = new LinkedHashMap<>();
        JsonNode algo = demoInstance().path("algorithm");
        params.put("populationSize", algo.path("populationSize").asInt(100));
        params.put("maxGenerations", algo.path("maxGenerations").asInt(300));
        params.put("timeLimitSeconds", algo.path("timeLimitSeconds").asInt(60));
        params.put("randomSeed", algo.path("randomSeed").asInt(20260916));
        return params;
    }
}
