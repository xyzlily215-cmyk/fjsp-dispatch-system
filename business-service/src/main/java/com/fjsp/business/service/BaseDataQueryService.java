package com.fjsp.business.service;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import com.fjsp.business.dto.MachineResponse;
import com.fjsp.business.dto.OrderListItemResponse;
import com.fjsp.business.dto.OrderOperationItem;
import com.fjsp.business.dto.ProcessTemplateResponse;
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
import com.fjsp.business.repository.ScheduleOperationRepository;
import org.springframework.stereotype.Service;

/** 基础数据查询聚合：设备列表、订单列表（含工序与 scheduled 标记）、工艺模板列表。 */
@Service
public class BaseDataQueryService {

    private final MachineRepository machineRepository;
    private final ProductionOrderRepository productionOrderRepository;
    private final OrderOperationRepository orderOperationRepository;
    private final ProcessTemplateRepository processTemplateRepository;
    private final ProcessOperationRepository processOperationRepository;
    private final ScheduleOperationRepository scheduleOperationRepository;

    public BaseDataQueryService(MachineRepository machineRepository,
                                ProductionOrderRepository productionOrderRepository,
                                OrderOperationRepository orderOperationRepository,
                                ProcessTemplateRepository processTemplateRepository,
                                ProcessOperationRepository processOperationRepository,
                                ScheduleOperationRepository scheduleOperationRepository) {
        this.machineRepository = machineRepository;
        this.productionOrderRepository = productionOrderRepository;
        this.orderOperationRepository = orderOperationRepository;
        this.processTemplateRepository = processTemplateRepository;
        this.processOperationRepository = processOperationRepository;
        this.scheduleOperationRepository = scheduleOperationRepository;
    }

    public List<MachineResponse> listMachines() {
        List<MachineResponse> result = new ArrayList<>();
        for (Machine machine : machineRepository.findAll()) {
            result.add(new MachineResponse(machine.getId(), machine.getMachineCode(),
                    machine.getMachineName(), machine.getWorkCenterId(), machine.getCalendarId(),
                    machine.getProductFamilies(), machine.getStatus(), machine.getRemark()));
        }
        result.sort(Comparator.comparing(MachineResponse::machineId));
        return result;
    }

    public List<OrderListItemResponse> listOrders() {
        List<ProductionOrder> orders = productionOrderRepository.findAll();
        // 批量取回全部工序后按订单分组，避免每单一次查询（N+1）
        List<String> orderIds = orders.stream().map(ProductionOrder::getId).toList();
        Map<String, List<OrderOperation>> opsByOrder = new LinkedHashMap<>();
        for (OrderOperation op : orderOperationRepository.findByOrderIdIn(orderIds)) {
            opsByOrder.computeIfAbsent(op.getOrderId(), k -> new ArrayList<>()).add(op);
        }
        opsByOrder.values().forEach(list -> list.sort(Comparator.comparing(OrderOperation::getSequenceNo)));
        // 已排程订单集合（工序已进入任一计划版本）：前端据此走修订流程而非直接编辑
        Set<String> scheduledOrderIds = new HashSet<>(scheduleOperationRepository.findScheduledOrderIds());

        List<OrderListItemResponse> result = new ArrayList<>();
        for (ProductionOrder order : orders) {
            boolean scheduled = !"WAITING".equals(order.getStatus())
                    || scheduledOrderIds.contains(order.getId());
            List<OrderOperationItem> ops = new ArrayList<>();
            for (OrderOperation op : opsByOrder.getOrDefault(order.getId(), List.of())) {
                ops.add(new OrderOperationItem(op.getId(), op.getSequenceNo(), op.getStatus(),
                        op.getCandidates()));
            }
            result.add(new OrderListItemResponse(order.getId(), order.getOrderCode(),
                    order.getProductFamily(), order.getQuantity(), order.getArrivalAt(), order.getDueAt(),
                    order.getPriority(), order.getStatus(), order.getTemplateId(), order.getRemark(),
                    order.getRevisionNo(), scheduled, ops));
        }
        result.sort(Comparator.comparing(OrderListItemResponse::orderId));
        return result;
    }

    public List<ProcessTemplateResponse> listProcessTemplates() {
        List<ProcessTemplateResponse> result = new ArrayList<>();
        for (ProcessTemplate template : processTemplateRepository.findAll()) {
            result.add(new ProcessTemplateResponse(template.getId(), template.getTemplateCode(),
                    template.getProductFamily(), template.getTemplateVersion(), template.getStatus(),
                    templateOperations(template.getId())));
        }
        result.sort(Comparator.comparing(ProcessTemplateResponse::templateCode));
        return result;
    }

    private List<ProcessTemplateResponse.TemplateOperationItem> templateOperations(String templateId) {
        List<ProcessTemplateResponse.TemplateOperationItem> ops = new ArrayList<>();
        for (ProcessOperation po : processOperationRepository.findByTemplateIdOrderBySequenceNo(templateId)) {
            ops.add(new ProcessTemplateResponse.TemplateOperationItem(po.getSequenceNo(),
                    po.getOperationCode(), po.getDefaultCandidates()));
        }
        return ops;
    }
}
