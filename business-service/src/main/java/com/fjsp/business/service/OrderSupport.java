package com.fjsp.business.service;

import java.time.OffsetDateTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

import com.fjsp.business.common.BizException;
import com.fjsp.business.dto.OrderResponse;
import com.fjsp.business.entity.OrderStatus;
import com.fjsp.business.entity.ProductionOrder;
import com.fjsp.business.repository.ProductionOrderRepository;
import com.fjsp.business.repository.ScheduleOperationRepository;
import org.springframework.stereotype.Component;

/** 订单领域共享逻辑：查询、已排程判定、字段校验与序列化，供订单写服务与修订服务复用。 */
@Component
public class OrderSupport {

    private final ProductionOrderRepository productionOrderRepository;
    private final ScheduleOperationRepository scheduleOperationRepository;

    public OrderSupport(ProductionOrderRepository productionOrderRepository,
                        ScheduleOperationRepository scheduleOperationRepository) {
        this.productionOrderRepository = productionOrderRepository;
        this.scheduleOperationRepository = scheduleOperationRepository;
    }

    /** 已排程 = 已有非 WAITING 状态，或任一工序已进入某个计划版本（调度结果）。 */
    boolean isOrderScheduled(ProductionOrder order) {
        return !OrderStatus.WAITING.equals(order.getStatus())
                || scheduleOperationRepository.existsScheduledByOrderId(order.getId());
    }

    ProductionOrder findOrder(String orderId) {
        return productionOrderRepository.findById(orderId)
                .or(() -> productionOrderRepository.findByOrderCode(orderId))
                .orElseThrow(() -> BizException.notFound("订单不存在: " + orderId));
    }

    void validateOrderFields(String productFamily, Integer quantity, Integer priority,
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

    OrderResponse toResponse(ProductionOrder order) {
        return new OrderResponse(order.getId(), order.getOrderCode(), order.getProductFamily(),
                order.getQuantity(), order.getArrivalAt(), order.getDueAt(), order.getPriority(),
                order.getStatus(), order.getTemplateId(), order.getRemark(), order.getRevisionNo());
    }

    void addChange(List<Map<String, Object>> changes, String field, Object oldValue, Object newValue) {
        if (Objects.equals(oldValue, newValue)) {
            return;
        }
        Map<String, Object> change = new LinkedHashMap<>();
        change.put("field", field);
        change.put("oldValue", oldValue);
        change.put("newValue", newValue);
        changes.add(change);
    }
}
