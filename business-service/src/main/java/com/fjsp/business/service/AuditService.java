package com.fjsp.business.service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.fjsp.business.common.PageResponse;
import com.fjsp.business.common.PageSupport;
import com.fjsp.business.common.RequestContext;
import com.fjsp.business.entity.AuditLog;
import com.fjsp.business.repository.AuditLogRepository;
import jakarta.persistence.criteria.Predicate;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.domain.Sort;
import org.springframework.data.jpa.domain.Specification;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

@Service
public class AuditService {

    private static final Logger log = LoggerFactory.getLogger(AuditService.class);

    private final AuditLogRepository auditLogRepository;

    public AuditService(AuditLogRepository auditLogRepository) {
        this.auditLogRepository = auditLogRepository;
    }

    @Transactional(propagation = Propagation.REQUIRED)
    public void record(String action, String objectType, String objectId, String detail) {
        AuditLog entry = new AuditLog();
        entry.setId(UUID.randomUUID().toString());
        entry.setRequestId(RequestContext.requestId());
        entry.setOperator(RequestContext.operator());
        entry.setSource(RequestContext.source());
        entry.setSessionId(RequestContext.sessionId());
        entry.setAction(action);
        entry.setObjectType(objectType);
        entry.setObjectId(objectId);
        entry.setDetail(detail != null && detail.length() > 4000 ? detail.substring(0, 4000) : detail);
        auditLogRepository.save(entry);
        log.info("audit {} {} {}", action, objectType, objectId);
    }

    /** 审计检索（仅 ADMIN）：分页 + 可选过滤 objectType / objectId / operator / requestId / source / sessionId。 */
    public PageResponse<Map<String, Object>> query(String objectType, String objectId,
                                                   String operator, String requestId,
                                                   String source, String sessionId,
                                                   Integer page, Integer size) {
        var pageable = PageSupport.of(page, size, PageSupport.DEFAULT_MAX_SIZE,
                Sort.by(Sort.Direction.DESC, "createdAt"));
        Specification<AuditLog> spec = (root, q, cb) -> {
            List<Predicate> predicates = new ArrayList<>();
            if (objectType != null && !objectType.isBlank()) {
                predicates.add(cb.equal(root.get("objectType"), objectType));
            }
            if (objectId != null && !objectId.isBlank()) {
                predicates.add(cb.equal(root.get("objectId"), objectId));
            }
            if (operator != null && !operator.isBlank()) {
                predicates.add(cb.equal(root.get("operator"), operator));
            }
            if (requestId != null && !requestId.isBlank()) {
                predicates.add(cb.equal(root.get("requestId"), requestId));
            }
            if (source != null && !source.isBlank()) {
                predicates.add(cb.equal(root.get("source"), source));
            }
            if (sessionId != null && !sessionId.isBlank()) {
                predicates.add(cb.equal(root.get("sessionId"), sessionId));
            }
            return cb.and(predicates.toArray(new Predicate[0]));
        };
        return PageResponse.of(auditLogRepository.findAll(spec, pageable), AuditService::toMap);
    }

    private static Map<String, Object> toMap(AuditLog entry) {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("id", entry.getId());
        map.put("action", entry.getAction());
        map.put("objectType", entry.getObjectType());
        map.put("objectId", entry.getObjectId());
        map.put("operator", entry.getOperator());
        map.put("source", entry.getSource());
        map.put("sessionId", entry.getSessionId());
        map.put("requestId", entry.getRequestId());
        map.put("detail", entry.getDetail());
        map.put("createdAt", entry.getCreatedAt());
        return map;
    }
}
