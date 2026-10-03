package com.fjsp.business.service;

import java.util.UUID;

import com.fjsp.business.common.RequestContext;
import com.fjsp.business.entity.AuditLog;
import com.fjsp.business.repository.AuditLogRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
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
}
