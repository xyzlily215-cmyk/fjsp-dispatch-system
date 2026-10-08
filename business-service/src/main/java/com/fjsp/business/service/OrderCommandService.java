package com.fjsp.business.service;

import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.List;

import com.fjsp.business.common.BizException;
import com.fjsp.business.dto.OrderCreateResponse;
import com.fjsp.business.dto.OrderResponse;
import com.fjsp.business.dto.OrderUpdateRequest;
import com.fjsp.business.dto.OrderUpsertRequest;
import com.fjsp.business.entity.OrderOperation;
import com.fjsp.business.entity.ProcessOperation;
import com.fjsp.business.entity.ProcessTemplate;
import com.fjsp.business.entity.ProductionOrder;
import com.fjsp.business.repository.OrderOperationRepository;
import com.fjsp.business.repository.ProcessOperationRepository;
import com.fjsp.business.repository.ProcessTemplateRepository;
import com.fjsp.business.repository.ProductionOrderRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class OrderCommandService {

    private final ProcessTemplateRepository processTemplateRepository;
    private final ProcessOperationRepository processOperationRepository;
    private final ProductionOrderRepository productionOrderRepository;
    private final OrderOperationRepository orderOperationRepository;
    private final OrderSupport orderSupport;
    private final IdempotencyService idempotencyService;
    private final AuditService auditService;

    public OrderCommandService(ProcessTemplateRepository processTemplateRepository,
                               ProcessOperationRepository processOperationRepository,
                               ProductionOrderRepository productionOrderRepository,
                               OrderOperationRepository orderOperationRepository,
                               OrderSupport orderSupport,
                               IdempotencyService idempotencyService,
                               AuditService auditService) {
        this.processTemplateRepository = processTemplateRepository;
        this.processOperationRepository = processOperationRepository;
        this.productionOrderRepository = productionOrderRepository;
        this.orderOperationRepository = orderOperationRepository;
        this.orderSupport = orderSupport;
        this.idempotencyService = idempotencyService;
        this.auditService = auditService;
    }

    @Transactional
    public OrderCreateResponse createOrder(String idempotencyKey, OrderUpsertRequest req) {
        return idempotencyService.execute(idempotencyKey, req, () -> createOrderCore(req),
                OrderCreateResponse.class);
    }

    /** 订单创建核心逻辑（校验 + 模板实例化工序 + 审计），无幂等包装；批量导入整批提交时复用并加入调用方事务。 */
    public OrderCreateResponse createOrderCore(OrderUpsertRequest req) {
        if (req == null || req.orderCode() == null || req.orderCode().isBlank()) {
            throw BizException.validation("orderCode 必填");
        }
        if (productionOrderRepository.existsByOrderCode(req.orderCode())) {
            throw BizException.duplicate("同车间订单号重复: " + req.orderCode());
        }
        orderSupport.validateOrderFields(req.productFamily(), req.quantity(), req.priority(),
                req.arrivalAt(), req.dueAt());

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
        order.setRemark(req.remark());
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
        return OrderCreateResponse.of(orderSupport.toResponse(order), operationIds);
    }

    @Transactional
    public OrderResponse updateOrder(String idempotencyKey, String orderId, OrderUpdateRequest req) {
        return idempotencyService.execute(idempotencyKey, req, () -> {
            ProductionOrder order = orderSupport.findOrder(orderId);
            boolean hasProcessFieldChange = req != null && (req.quantity() != null || req.priority() != null
                    || req.arrivalAt() != null || req.dueAt() != null);
            // F-04 修订控制：已排程订单的工艺字段不可直接改，走 POST /orders/{id}/revisions；
            // 基础字段（remark）任何状态下都可直接改。
            if (orderSupport.isOrderScheduled(order)) {
                if (hasProcessFieldChange) {
                    throw BizException.stateConflict("订单已排程，工艺字段（数量/优先级/到达时间/交期）不可直接修改，"
                            + "请通过修订流程变更（POST /orders/{id}/revisions）");
                }
                if (req != null && req.remark() != null) {
                    order.setRemark(req.remark());
                    productionOrderRepository.save(order);
                    auditService.record("ORDER_UPDATE", "order", order.getId(),
                            "orderCode=" + order.getOrderCode() + ", remark only");
                }
                return orderSupport.toResponse(order);
            }
            Integer quantity = req != null && req.quantity() != null ? req.quantity() : order.getQuantity();
            Integer priority = req != null && req.priority() != null ? req.priority() : order.getPriority();
            String arrivalAt = req != null && req.arrivalAt() != null
                    ? req.arrivalAt() : order.getArrivalAt().toString();
            String dueAt = req != null && req.dueAt() != null ? req.dueAt() : order.getDueAt().toString();
            orderSupport.validateOrderFields(order.getProductFamily(), quantity, priority, arrivalAt, dueAt);

            order.setQuantity(quantity);
            order.setPriority(priority);
            order.setArrivalAt(OffsetDateTime.parse(arrivalAt));
            order.setDueAt(OffsetDateTime.parse(dueAt));
            if (req != null && req.remark() != null) {
                order.setRemark(req.remark());
            }
            productionOrderRepository.save(order);
            auditService.record("ORDER_UPDATE", "order", order.getId(), "orderCode=" + order.getOrderCode());
            return orderSupport.toResponse(order);
        }, OrderResponse.class);
    }
}
