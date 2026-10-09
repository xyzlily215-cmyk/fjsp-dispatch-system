package com.fjsp.business.it;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

import com.fjsp.business.common.BizException;
import com.fjsp.business.dto.ImportBatchResponse;
import com.fjsp.business.dto.ImportCommitRequest;
import com.fjsp.business.entity.ImportBatch;
import com.fjsp.business.entity.ProcessOperation;
import com.fjsp.business.entity.ProcessTemplate;
import com.fjsp.business.repository.AuditLogRepository;
import com.fjsp.business.repository.IdempotencyRecordRepository;
import com.fjsp.business.repository.ImportBatchRepository;
import com.fjsp.business.repository.MachineRepository;
import com.fjsp.business.repository.OrderOperationRepository;
import com.fjsp.business.repository.ProcessOperationRepository;
import com.fjsp.business.repository.ProcessTemplateRepository;
import com.fjsp.business.repository.ProductionOrderRepository;
import com.fjsp.business.service.ImportService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** F-05 导入端到端：预览不写业务数据 → 整批入库（订单按模板实例化工序）→ 幂等重放与重复提交拦截。
 * 测试库可能已有演示种子数据，断言一律用增量，清理只删本用例创建的行。 */
class ImportFlowIT extends AbstractPostgresIT {

    @Autowired
    private ImportService importService;
    @Autowired
    private ImportBatchRepository importBatchRepository;
    @Autowired
    private ProductionOrderRepository productionOrderRepository;
    @Autowired
    private OrderOperationRepository orderOperationRepository;
    @Autowired
    private MachineRepository machineRepository;
    @Autowired
    private ProcessTemplateRepository processTemplateRepository;
    @Autowired
    private ProcessOperationRepository processOperationRepository;
    @Autowired
    private AuditLogRepository auditLogRepository;
    @Autowired
    private IdempotencyRecordRepository idempotencyRecordRepository;

    @AfterEach
    void cleanup() {
        orderOperationRepository.deleteAllById(
                List.of("IT-PO-1-1", "IT-PO-2-1", "IT-PO-9-1"));
        productionOrderRepository.deleteAllById(List.of("IT-PO-1", "IT-PO-2", "IT-PO-9"));
        machineRepository.deleteAllById(List.of("M-IT-1", "M-IT-2"));
        processOperationRepository.deleteAllById(List.of("PO-IT-IMP-1"));
        processTemplateRepository.deleteAllById(List.of("TPL-IT-IMP"));
        importBatchRepository.deleteAll();
        auditLogRepository.deleteAll();
        idempotencyRecordRepository.deleteAll();
    }

    private void seedTemplate() {
        ProcessTemplate template = new ProcessTemplate();
        template.setId("TPL-IT-IMP");
        template.setTemplateCode("TPL-IT-IMP");
        template.setProductFamily("FAM-IT");
        template.setTemplateVersion(1);
        template.setStatus("ACTIVE");
        processTemplateRepository.save(template);
        ProcessOperation op = new ProcessOperation();
        op.setId("PO-IT-IMP-1");
        op.setTemplateId(template.getId());
        op.setSequenceNo(1);
        op.setOperationCode("OP-粗加工");
        op.setDefaultCandidates(List.of(Map.of("machineId", "M-IT-SEED",
                "setupMinutes", 5, "processMinutes", 10)));
        processOperationRepository.save(op);
    }

    @Test
    void ordersPreviewThenCommit_endToEnd() {
        seedTemplate();
        long ordersBefore = productionOrderRepository.count();
        long opsBefore = orderOperationRepository.count();
        byte[] csv = ("orderCode,productFamily,quantity,arrivalAt,dueAt,priority,templateId\r\n"
                + "IT-PO-1,FAM-IT,100,2026-10-09T08:00:00+08:00,2026-10-20T18:00:00+08:00,3,\r\n"
                + "IT-PO-2,FAM-IT,50,2026-10-09T08:00:00+08:00,2026-10-25T18:00:00+08:00,2,\r\n")
                .getBytes(StandardCharsets.UTF_8);

        ImportBatchResponse preview = importService.preview("orders", "orders-it.csv", csv);
        String batchCode = preview.batchCode();
        assertTrue(batchCode.startsWith("IMP-"), "批次号应由 IMP 序列生成");
        assertEquals(2, preview.totalRows());
        assertEquals(0, preview.errorRows());
        assertEquals(64, preview.fileSha256().length());
        // 预览不落业务数据
        assertEquals(ordersBefore, productionOrderRepository.count());

        ImportBatchResponse committed = importService.commit("orders", "it-imp-key-1",
                new ImportCommitRequest(batchCode));
        assertEquals("COMMITTED", committed.status());
        assertEquals(2, committed.committedRows());

        // 整批入库：订单 + 按模板实例化的工序
        assertTrue(productionOrderRepository.existsByOrderCode("IT-PO-1"));
        assertTrue(productionOrderRepository.existsByOrderCode("IT-PO-2"));
        assertEquals("TPL-IT-IMP",
                productionOrderRepository.findByOrderCode("IT-PO-1").orElseThrow().getTemplateId());
        assertEquals(opsBefore + 2, orderOperationRepository.count());

        ImportBatch batch = importBatchRepository.findByBatchCode(batchCode).orElseThrow();
        assertEquals(ImportBatch.STATUS_COMMITTED, batch.getStatus());
        assertNotNull(batch.getCommittedAt());
        assertEquals(2, batch.getRowsJson().size());

        // 同幂等键重放：不重复入库
        ImportBatchResponse replay = importService.commit("orders", "it-imp-key-1",
                new ImportCommitRequest(batchCode));
        assertEquals("COMMITTED", replay.status());
        assertEquals(2, replay.committedRows(), "回放应还原已存响应（含 committedRows）");
        assertEquals(ordersBefore + 2, productionOrderRepository.count());

        // 换幂等键重复提交同一批次：状态冲突
        BizException conflict = assertThrows(BizException.class,
                () -> importService.commit("orders", "it-imp-key-2", new ImportCommitRequest(batchCode)));
        assertEquals("E_STATE_CONFLICT", conflict.getCode());
        assertEquals(ordersBefore + 2, productionOrderRepository.count());

        // 导入审计：预览 + 入库各一条
        List<String> actions = auditLogRepository.findAll().stream()
                .map(a -> a.getAction() + ":" + a.getObjectId()).toList();
        assertTrue(actions.contains("IMPORT_PREVIEW:" + batchCode), "缺预览审计: " + actions);
        assertTrue(actions.contains("IMPORT_COMMIT:" + batchCode), "缺入库审计: " + actions);
    }

    @Test
    void machinesPreviewThenCommit_endToEnd() {
        long machinesBefore = machineRepository.count();
        byte[] csv = ("machineCode,machineName,workCenterId,calendarId,productFamilies,remark\r\n"
                + "M-IT-1,车床,WC-车削,,FAM-IT|FAM-IT2,\r\n"
                + "M-IT-2,铣床,WC-铣削,,FAM-IT,备注\r\n")
                .getBytes(StandardCharsets.UTF_8);

        ImportBatchResponse preview = importService.preview("machines", "machines-it.csv", csv);
        assertEquals(0, preview.errorRows());
        assertEquals(machinesBefore, machineRepository.count());

        ImportBatchResponse committed = importService.commit("machines", "it-imp-key-m1",
                new ImportCommitRequest(preview.batchCode()));
        assertEquals("COMMITTED", committed.status());
        assertEquals(machinesBefore + 2, machineRepository.count());
        assertEquals(List.of("FAM-IT", "FAM-IT2"),
                machineRepository.findById("M-IT-1").orElseThrow().getProductFamilies());
    }

    @Test
    void preview_withErrors_commitRejected() {
        seedTemplate();
        long ordersBefore = productionOrderRepository.count();
        byte[] csv = ("orderCode,productFamily,quantity,arrivalAt,dueAt,priority,templateId\r\n"
                + "IT-PO-9,FAM-IT,0,2026-10-09T08:00:00+08:00,2026-10-20T18:00:00+08:00,3,\r\n")
                .getBytes(StandardCharsets.UTF_8);

        ImportBatchResponse preview = importService.preview("orders", "orders-bad.csv", csv);
        assertEquals(1, preview.errorRows());

        BizException e = assertThrows(BizException.class, () -> importService.commit("orders",
                "it-imp-key-bad", new ImportCommitRequest(preview.batchCode())));
        assertEquals("E_STATE_CONFLICT", e.getCode());
        assertEquals(ordersBefore, productionOrderRepository.count());
    }
}
