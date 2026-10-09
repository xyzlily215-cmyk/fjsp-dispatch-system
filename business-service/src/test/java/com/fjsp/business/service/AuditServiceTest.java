package com.fjsp.business.service;

import java.util.List;
import java.util.Map;

import com.fjsp.business.common.BizException;
import com.fjsp.business.common.PageResponse;
import com.fjsp.business.entity.AuditLog;
import com.fjsp.business.repository.AuditLogRepository;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.data.domain.PageImpl;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.domain.Specification;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class AuditServiceTest {

    @Mock
    private AuditLogRepository auditLogRepository;

    @InjectMocks
    private AuditService auditService;

    @Test
    void query_pagedEnvelopeWithFilters() {
        AuditLog entry = new AuditLog();
        entry.setId("a1");
        entry.setAction("PLAN_PUBLISH");
        entry.setObjectType("plan_version");
        entry.setObjectId("pv-1");
        entry.setOperator("manager");
        when(auditLogRepository.findAll(any(Specification.class), any(Pageable.class)))
                .thenReturn(new PageImpl<>(List.of(entry)));

        PageResponse<Map<String, Object>> resp =
                auditService.query("plan_version", "pv-1", "manager", null, 0, 10);

        assertEquals(1, resp.getTotal());
        assertEquals(1, resp.getItems().size());
        Map<String, Object> item = resp.getItems().get(0);
        assertEquals("a1", item.get("id"));
        assertEquals("PLAN_PUBLISH", item.get("action"));
        assertEquals("manager", item.get("operator"));
    }

    @Test
    void query_invalidPageParams_rejected() {
        assertThrows(BizException.class, () -> auditService.query(null, null, null, null, -1, 10));
        assertThrows(BizException.class, () -> auditService.query(null, null, null, null, 0, 500));
    }
}
