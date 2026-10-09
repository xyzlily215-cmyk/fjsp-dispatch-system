package com.fjsp.business.it;

import java.nio.charset.StandardCharsets;

import com.fjsp.business.dto.ImportBatchResponse;
import com.fjsp.business.dto.ImportCommitRequest;
import com.fjsp.business.entity.ImportBatch;
import com.fjsp.business.repository.AuditLogRepository;
import com.fjsp.business.repository.ImportBatchRepository;
import com.fjsp.business.repository.MachineRepository;
import com.fjsp.business.service.AuditService;
import com.fjsp.business.service.ImportService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.bean.override.mockito.MockitoBean;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doThrow;

/** F-05 半批回滚：整批入库中途失败 → 真实事务全滚，已写行不残留，批次保持 PENDING。 */
class ImportRollbackIT extends AbstractPostgresIT {

    @Autowired
    private ImportService importService;
    @Autowired
    private ImportBatchRepository importBatchRepository;
    @Autowired
    private MachineRepository machineRepository;
    @Autowired
    private AuditLogRepository auditLogRepository;

    @MockitoBean
    private AuditService auditService;

    @AfterEach
    void cleanup() {
        machineRepository.deleteAllById(java.util.List.of("M-IT-R1", "M-IT-R2"));
        importBatchRepository.deleteAll();
        auditLogRepository.deleteAll();
    }

    @Test
    void commit_midwayFailure_rollsBackWholeBatch() {
        byte[] csv = ("machineCode,machineName,workCenterId,calendarId,productFamilies,remark\r\n"
                + "M-IT-R1,车床,WC-车削,,FAM-IT,\r\n"
                + "M-IT-R2,铣床,WC-铣削,,FAM-IT,\r\n")
                .getBytes(StandardCharsets.UTF_8);
        ImportBatchResponse preview = importService.preview("machines", "machines-rollback.csv", csv);
        String batchCode = preview.batchCode();
        assertEquals(0, preview.errorRows());

        // 第一行入库后的行内审计抛异常，模拟中途失败
        doThrow(new IllegalStateException("simulated downstream failure"))
                .when(auditService).record(anyString(), anyString(), anyString(), any());

        assertThrows(IllegalStateException.class,
                () -> importService.commit("machines", "it-imp-key-rb", new ImportCommitRequest(batchCode)));

        assertTrue(machineRepository.findById("M-IT-R1").isEmpty(), "第一行应随事务回滚");
        assertTrue(machineRepository.findById("M-IT-R2").isEmpty());
        ImportBatch batch = importBatchRepository.findByBatchCode(batchCode).orElseThrow();
        assertEquals(ImportBatch.STATUS_PENDING, batch.getStatus(), "批次不应落 COMMITTED");
        assertTrue(auditLogRepository.findAll().stream()
                        .noneMatch(a -> "IMPORT_COMMIT".equals(a.getAction())),
                "失败批次不应有入库审计残留");
    }
}
