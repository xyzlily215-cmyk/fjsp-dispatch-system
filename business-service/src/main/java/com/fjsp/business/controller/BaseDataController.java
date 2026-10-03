package com.fjsp.business.controller;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.fjsp.business.common.ApiResponse;
import com.fjsp.business.common.BizException;
import com.fjsp.business.entity.Machine;
import com.fjsp.business.entity.OrderOperation;
import com.fjsp.business.entity.ProcessOperation;
import com.fjsp.business.entity.ProcessTemplate;
import com.fjsp.business.entity.ProductionOrder;
import com.fjsp.business.repository.MachineRepository;
import com.fjsp.business.repository.OrderOperationRepository;
import com.fjsp.business.repository.ProcessOperationRepository;
import com.fjsp.business.repository.ProcessTemplateRepository;
import com.fjsp.business.repository.ProductionOrderRepository;
import com.fjsp.business.service.DashboardService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1")
public class BaseDataController {

    private final MachineRepository machineRepository;
    private final ProductionOrderRepository productionOrderRepository;
    private final OrderOperationRepository orderOperationRepository;
    private final ProcessTemplateRepository processTemplateRepository;
    private final ProcessOperationRepository processOperationRepository;
    private final DashboardService dashboardService;

    public BaseDataController(MachineRepository machineRepository,
                              ProductionOrderRepository productionOrderRepository,
                              OrderOperationRepository orderOperationRepository,
                              ProcessTemplateRepository processTemplateRepository,
                              ProcessOperationRepository processOperationRepository,
                              DashboardService dashboardService) {
        this.machineRepository = machineRepository;
        this.productionOrderRepository = productionOrderRepository;
        this.orderOperationRepository = orderOperationRepository;
        this.processTemplateRepository = processTemplateRepository;
        this.processOperationRepository = processOperationRepository;
        this.dashboardService = dashboardService;
    }

    @GetMapping("/machines")
    public ApiResponse<List<Map<String, Object>>> machines() {
        List<Map<String, Object>> result = new ArrayList<>();
        for (Machine machine : machineRepository.findAll()) {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("machineId", machine.getId());
            entry.put("machineCode", machine.getMachineCode());
            entry.put("machineName", machine.getMachineName());
            entry.put("workCenterId", machine.getWorkCenterId());
            entry.put("calendarId", machine.getCalendarId());
            entry.put("productFamilies", machine.getProductFamilies());
            entry.put("status", machine.getStatus());
            entry.put("remark", machine.getRemark());
            result.add(entry);
        }
        result.sort(Comparator.comparing(m -> (String) m.get("machineId")));
        return ApiResponse.ok(result);
    }

    @GetMapping("/orders")
    public ApiResponse<List<Map<String, Object>>> orders() {
        List<Map<String, Object>> result = new ArrayList<>();
        for (ProductionOrder order : productionOrderRepository.findAll()) {
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
            List<Map<String, Object>> ops = new ArrayList<>();
            for (OrderOperation op : orderOperationRepository.findByOrderIdOrderBySequenceNo(order.getId())) {
                Map<String, Object> opEntry = new LinkedHashMap<>();
                opEntry.put("operationId", op.getId());
                opEntry.put("seqNo", op.getSequenceNo());
                opEntry.put("status", op.getStatus());
                opEntry.put("candidates", op.getCandidates());
                ops.add(opEntry);
            }
            entry.put("operations", ops);
            result.add(entry);
        }
        result.sort(Comparator.comparing(o -> (String) o.get("orderId")));
        return ApiResponse.ok(result);
    }

    @GetMapping("/process-templates")
    public ApiResponse<List<Map<String, Object>>> processTemplates() {
        List<Map<String, Object>> result = new ArrayList<>();
        for (ProcessTemplate template : processTemplateRepository.findAll()) {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("templateId", template.getId());
            entry.put("templateCode", template.getTemplateCode());
            entry.put("productFamily", template.getProductFamily());
            entry.put("templateVersion", template.getTemplateVersion());
            entry.put("status", template.getStatus());
            List<Map<String, Object>> ops = new ArrayList<>();
            for (ProcessOperation po : processOperationRepository
                    .findByTemplateIdOrderBySequenceNo(template.getId())) {
                Map<String, Object> opEntry = new LinkedHashMap<>();
                opEntry.put("sequenceNo", po.getSequenceNo());
                opEntry.put("operationCode", po.getOperationCode());
                opEntry.put("defaultCandidates", po.getDefaultCandidates());
                ops.add(opEntry);
            }
            entry.put("operations", ops);
            result.add(entry);
        }
        result.sort(Comparator.comparing(t -> (String) t.get("templateCode")));
        return ApiResponse.ok(result);
    }

    @GetMapping("/dashboard")
    public ApiResponse<Map<String, Object>> dashboard() {
        return ApiResponse.ok(dashboardService.dashboard());
    }
}
