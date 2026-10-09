package com.fjsp.business.service;

import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.fjsp.business.common.BizException;
import com.fjsp.business.common.RequestContext;
import com.fjsp.business.dto.OrderResponse;
import com.fjsp.business.dto.OrderRevisionRequest;
import com.fjsp.business.dto.OrderRevisionResponse;
import com.fjsp.business.dto.OrderRevisionResultResponse;
import com.fjsp.business.entity.OperationStatus;
import com.fjsp.business.entity.OrderOperation;
import com.fjsp.business.entity.OrderRevision;
import com.fjsp.business.entity.ProcessOperation;
import com.fjsp.business.entity.ProcessTemplate;
import com.fjsp.business.entity.ProductionOrder;
import com.fjsp.business.entity.TemplateStatus;
import com.fjsp.business.repository.OrderOperationRepository;
import com.fjsp.business.repository.OrderRevisionRepository;
import com.fjsp.business.repository.ProcessOperationRepository;
import com.fjsp.business.repository.ProcessTemplateRepository;
import com.fjsp.business.repository.ProductionOrderRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * F-04 已排程订单的工艺字段修订：必填修订原因，记录前后值差异，应用新值并递增修订号。
 * 模板/产品族变更时未开始（NOT_STARTED）的工序按新模板重新实例化，已开始的工序保持不变；
 * 其余工艺字段（数量/优先级/到达/交期）变更不影响已实例化工序。
 * 不自动触发重排：响应标记 needsReschedule=true，由计划员显式创建重排任务。
 */
@Service
public class OrderRevisionService {

    private final ProcessTemplateRepository processTemplateRepository;
    private final ProcessOperationRepository processOperationRepository;
    private final ProductionOrderRepository productionOrderRepository;
    private final OrderOperationRepository orderOperationRepository;
    private final OrderRevisionRepository orderRevisionRepository;
    private final OrderSupport orderSupport;
    private final IdempotencyService idempotencyService;
    private final AuditService auditService;

    public OrderRevisionService(ProcessTemplateRepository processTemplateRepository,
                                ProcessOperationRepository processOperationRepository,
                                ProductionOrderRepository productionOrderRepository,
                                OrderOperationRepository orderOperationRepository,
                                OrderRevisionRepository orderRevisionRepository,
                                OrderSupport orderSupport,
                                IdempotencyService idempotencyService,
                                AuditService auditService) {
        this.processTemplateRepository = processTemplateRepository;
        this.processOperationRepository = processOperationRepository;
        this.productionOrderRepository = productionOrderRepository;
        this.orderOperationRepository = orderOperationRepository;
        this.orderRevisionRepository = orderRevisionRepository;
        this.orderSupport = orderSupport;
        this.idempotencyService = idempotencyService;
        this.auditService = auditService;
    }

    @Transactional
    public OrderRevisionResultResponse reviseOrder(String idempotencyKey, String orderId,
                                                   OrderRevisionRequest req) {
        return idempotencyService.execute(idempotencyKey, req, () -> {
            if (req == null || req.reason() == null || req.reason().isBlank()) {
                throw BizException.validation("修订原因必填");
            }
            ProductionOrder order = orderSupport.findOrder(orderId);
            if (!orderSupport.isOrderScheduled(order)) {
                throw BizException.stateConflict("订单尚未排程（WAITING），工艺字段可直接编辑，无需修订");
            }
            String productFamily = req.productFamily() != null && !req.productFamily().isBlank()
                    ? req.productFamily() : order.getProductFamily();
            Integer quantity = req.quantity() != null ? req.quantity() : order.getQuantity();
            Integer priority = req.priority() != null ? req.priority() : order.getPriority();
            String arrivalAt = req.arrivalAt() != null ? req.arrivalAt() : order.getArrivalAt().toString();
            String dueAt = req.dueAt() != null ? req.dueAt() : order.getDueAt().toString();
            orderSupport.validateOrderFields(productFamily, quantity, priority, arrivalAt, dueAt);

            ProcessTemplate newTemplate = null;
            boolean templateChanged = req.templateId() != null && !req.templateId().isBlank()
                    && !req.templateId().equals(order.getTemplateId());
            if (templateChanged) {
                newTemplate = processTemplateRepository.findById(req.templateId())
                        .orElseThrow(() -> BizException.validation("工艺模板不存在: " + req.templateId()));
                if (!TemplateStatus.ACTIVE.equals(newTemplate.getStatus())) {
                    throw BizException.validation("工艺模板未启用: " + newTemplate.getTemplateCode());
                }
                if (!newTemplate.getProductFamily().equals(productFamily)) {
                    throw BizException.validation("模板产品族 " + newTemplate.getProductFamily()
                            + " 与订单产品族 " + productFamily + " 不一致");
                }
            }
            if (!productFamily.equals(order.getProductFamily()) && !templateChanged) {
                throw BizException.validation("变更产品族时必须同时选择该产品族下启用中的工艺模板");
            }

            OffsetDateTime newArrival = OffsetDateTime.parse(arrivalAt);
            OffsetDateTime newDue = OffsetDateTime.parse(dueAt);
            List<Map<String, Object>> changedFields = new ArrayList<>();
            orderSupport.addChange(changedFields, "productFamily", order.getProductFamily(), productFamily);
            orderSupport.addChange(changedFields, "templateId", order.getTemplateId(),
                    templateChanged ? newTemplate.getId() : order.getTemplateId());
            orderSupport.addChange(changedFields, "quantity", order.getQuantity(), quantity);
            orderSupport.addChange(changedFields, "priority", order.getPriority(), priority);
            if (!order.getArrivalAt().isEqual(newArrival)) {
                orderSupport.addChange(changedFields, "arrivalAt", order.getArrivalAt().toString(),
                        newArrival.toString());
            }
            if (!order.getDueAt().isEqual(newDue)) {
                orderSupport.addChange(changedFields, "dueAt", order.getDueAt().toString(), newDue.toString());
            }
            if (changedFields.isEmpty()) {
                throw BizException.validation("修订未包含任何工艺字段变更");
            }

            int revisionNo = orderRevisionRepository.findTopByOrderIdOrderByRevisionNoDesc(order.getId())
                    .map(r -> r.getRevisionNo() + 1).orElse(1);

            order.setProductFamily(productFamily);
            order.setQuantity(quantity);
            order.setPriority(priority);
            order.setArrivalAt(newArrival);
            order.setDueAt(newDue);
            if (templateChanged) {
                order.setTemplateId(newTemplate.getId());
            }
            order.setRevisionNo(revisionNo);
            productionOrderRepository.save(order);

            if (templateChanged) {
                regenerateNotStartedOperations(order, newTemplate, revisionNo);
            }

            OrderRevision revision = new OrderRevision();
            revision.setId(UUID.randomUUID().toString());
            revision.setOrderId(order.getId());
            revision.setRevisionNo(revisionNo);
            revision.setReason(req.reason().trim());
            revision.setChangedFields(changedFields);
            revision.setOperator(RequestContext.operator());
            orderRevisionRepository.save(revision);

            auditService.record("ORDER_REVISE", "order", order.getId(),
                    "revisionNo=" + revisionNo + ", fields="
                            + changedFields.stream().map(f -> String.valueOf(f.get("field"))).toList());
            OrderResponse data = orderSupport.toResponse(order);
            return OrderRevisionResultResponse.of(data, true,
                    "已生成修订记录 #" + revisionNo + "，需重新排程后变更才会反映到计划");
        }, OrderRevisionResultResponse.class);
    }

    /** 订单修订记录（新→旧）。 */
    public List<OrderRevisionResponse> listOrderRevisions(String orderId) {
        ProductionOrder order = orderSupport.findOrder(orderId);
        List<OrderRevisionResponse> result = new ArrayList<>();
        for (OrderRevision r : orderRevisionRepository.findByOrderIdOrderByRevisionNoDesc(order.getId())) {
            result.add(new OrderRevisionResponse(r.getId(), r.getOrderId(), r.getRevisionNo(),
                    r.getReason(), r.getChangedFields(), r.getOperator(), r.getCreatedAt()));
        }
        return result;
    }

    /** 模板变更时重建工序：已开始（非 NOT_STARTED）的工序保持不变，未开始的按新模板重新实例化。 */
    private void regenerateNotStartedOperations(ProductionOrder order, ProcessTemplate template,
                                                int revisionNo) {
        List<OrderOperation> existing = orderOperationRepository.findByOrderIdOrderBySequenceNo(order.getId());
        int keptMaxSeq = 0;
        for (OrderOperation oo : existing) {
            if (OperationStatus.NOT_STARTED.equals(oo.getStatus())) {
                orderOperationRepository.delete(oo);
            } else {
                keptMaxSeq = Math.max(keptMaxSeq, oo.getSequenceNo());
            }
        }
        List<ProcessOperation> templateOps =
                processOperationRepository.findByTemplateIdOrderBySequenceNo(template.getId());
        if (templateOps.isEmpty()) {
            throw BizException.validation("工艺模板没有工序定义: " + template.getTemplateCode());
        }
        for (ProcessOperation po : templateOps) {
            OrderOperation oo = new OrderOperation();
            oo.setId(order.getOrderCode() + "-R" + revisionNo + "-" + po.getSequenceNo());
            oo.setOrderId(order.getId());
            // 存在已开始工序时新工序排在其后：避免 (orderId, sequenceNo) 唯一冲突并保持先后语义
            oo.setSequenceNo(keptMaxSeq == 0 ? po.getSequenceNo() : keptMaxSeq + po.getSequenceNo());
            oo.setStatus(OperationStatus.NOT_STARTED);
            oo.setCandidates(po.getDefaultCandidates());
            orderOperationRepository.save(oo);
        }
    }
}
