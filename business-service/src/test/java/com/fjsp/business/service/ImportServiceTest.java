package com.fjsp.business.service;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.function.Supplier;

import com.fjsp.business.common.BizException;
import com.fjsp.business.common.HashUtil;
import com.fjsp.business.dto.ImportBatchResponse;
import com.fjsp.business.dto.ImportCommitRequest;
import com.fjsp.business.dto.ImportRowError;
import com.fjsp.business.dto.MachineResponse;
import com.fjsp.business.dto.MachineUpsertRequest;
import com.fjsp.business.entity.ImportBatch;
import com.fjsp.business.entity.ProcessOperation;
import com.fjsp.business.entity.ProcessTemplate;
import com.fjsp.business.entity.ProductionOrder;
import com.fjsp.business.repository.ImportBatchRepository;
import com.fjsp.business.repository.MachineRepository;
import com.fjsp.business.repository.ProcessOperationRepository;
import com.fjsp.business.repository.ProcessTemplateRepository;
import com.fjsp.business.repository.ProductionOrderRepository;
import com.fjsp.business.repository.WorkCalendarRepository;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class ImportServiceTest {

    @Mock
    private ImportBatchRepository importBatchRepository;
    @Mock
    private MachineRepository machineRepository;
    @Mock
    private ProductionOrderRepository productionOrderRepository;
    @Mock
    private ProcessTemplateRepository processTemplateRepository;
    @Mock
    private ProcessOperationRepository processOperationRepository;
    @Mock
    private WorkCalendarRepository workCalendarRepository;
    @Mock
    private MachineCommandService machineCommandService;
    @Mock
    private OrderCommandService orderCommandService;
    @Mock
    private CodeGenerator codeGenerator;
    @Mock
    private IdempotencyService idempotencyService;
    @Mock
    private AuditService auditService;

    @InjectMocks
    private ImportService service;

    private void stubExecuteRunsAction() {
        when(idempotencyService.execute(any(), any(), any(), any()))
                .thenAnswer(inv -> ((Supplier<Object>) inv.getArgument(2)).get());
    }

    private static MachineResponse anyMachineResponse() {
        return new MachineResponse("M-1", "M-1", null, "WC-1", null, List.of("轴类"), "ACTIVE", null);
    }

    private ProcessTemplate activeTemplate(String id, String family) {
        ProcessTemplate template = new ProcessTemplate();
        template.setId(id);
        template.setTemplateCode("TPL-" + family);
        template.setProductFamily(family);
        template.setTemplateVersion(1);
        template.setStatus("ACTIVE");
        return template;
    }

    private void stubOrderTemplateOk(String family) {
        ProcessTemplate template = activeTemplate("TPL-1", family);
        when(processTemplateRepository
                .findFirstByProductFamilyAndStatusOrderByTemplateVersionDesc(family, "ACTIVE"))
                .thenReturn(Optional.of(template));
        when(processOperationRepository.findByTemplateIdOrderBySequenceNo("TPL-1"))
                .thenReturn(List.of(new ProcessOperation()));
    }

    private byte[] ordersCsv(String... rows) {
        StringBuilder sb = new StringBuilder(
                "orderCode,productFamily,quantity,arrivalAt,dueAt,priority,templateId\r\n");
        for (String row : rows) {
            sb.append(row).append("\r\n");
        }
        return sb.toString().getBytes(StandardCharsets.UTF_8);
    }

    private byte[] machinesCsv(String... rows) {
        StringBuilder sb = new StringBuilder(
                "machineCode,machineName,workCenterId,calendarId,productFamilies,remark\r\n");
        for (String row : rows) {
            sb.append(row).append("\r\n");
        }
        return sb.toString().getBytes(StandardCharsets.UTF_8);
    }

    /* ---------------- 模板 ---------------- */

    @Test
    void template_orders_hasBomHeaderAndSampleRows() {
        ImportService.TemplateFile file = service.template("orders");
        assertEquals("import-orders-template.csv", file.filename());
        String text = new String(file.content(), StandardCharsets.UTF_8);
        assertTrue(text.startsWith("﻿"), "模板应带 UTF-8 BOM");
        assertTrue(text.contains("orderCode,productFamily,quantity,arrivalAt,dueAt,priority,templateId"));
    }

    @Test
    void template_unknownType_rejected() {
        BizException e = assertThrows(BizException.class, () -> service.template("calendars"));
        assertEquals("E_VALIDATION", e.getCode());
    }

    /* ---------------- 预览：文件预检 ---------------- */

    @Test
    void preview_oversizeFile_rejected() {
        byte[] content = new byte[(int) ImportService.MAX_FILE_BYTES + 1];
        BizException e = assertThrows(BizException.class,
                () -> service.preview("orders", "orders.csv", content));
        assertEquals("E_VALIDATION", e.getCode());
        verify(importBatchRepository, never()).save(any());
    }

    @Test
    void preview_nonCsvExtension_rejected() {
        BizException e = assertThrows(BizException.class,
                () -> service.preview("orders", "orders.xlsx", ordersCsv("PO-1,轴类,1,2026-10-09T08:00:00+08:00,2026-10-20T18:00:00+08:00,3,")));
        assertEquals("E_VALIDATION", e.getCode());
        verify(importBatchRepository, never()).save(any());
    }

    @Test
    void preview_headerMismatch_rejected() {
        byte[] content = "a,b,c\r\n1,2,3\r\n".getBytes(StandardCharsets.UTF_8);
        BizException e = assertThrows(BizException.class,
                () -> service.preview("orders", "orders.csv", content));
        assertEquals("E_VALIDATION", e.getCode());
        assertTrue(e.getMessage().contains("表头"));
        verify(importBatchRepository, never()).save(any());
    }

    @Test
    void preview_tooManyRows_rejected() {
        StringBuilder sb = new StringBuilder(
                "machineCode,machineName,workCenterId,calendarId,productFamilies,remark\r\n");
        for (int i = 0; i < ImportService.MAX_ROWS + 1; i++) {
            sb.append("M-").append(i).append(",,WC-1,,轴类,\r\n");
        }
        BizException e = assertThrows(BizException.class,
                () -> service.preview("machines", "machines.csv",
                        sb.toString().getBytes(StandardCharsets.UTF_8)));
        assertEquals("E_VALIDATION", e.getCode());
        assertTrue(e.getMessage().contains("上限"));
        verify(importBatchRepository, never()).save(any());
    }

    /* ---------------- 预览：逐行校验 ---------------- */

    @Test
    void preview_validOrders_batchPendingWithDigest() {
        when(codeGenerator.next("IMP")).thenReturn("IMP-000001");
        stubOrderTemplateOk("轴类");
        byte[] content = ordersCsv(
                "PO-100,轴类,100,2026-10-09T08:00:00+08:00,2026-10-20T18:00:00+08:00,3,",
                "PO-101,轴类,50,2026-10-09T08:00:00+08:00,2026-10-25T18:00:00+08:00,2,");

        ImportBatchResponse data = service.preview("orders", "orders.csv", content);

        assertEquals("IMP-000001", data.batchCode());
        assertEquals("PENDING", data.status());
        assertEquals(2, data.totalRows());
        assertEquals(2, data.successRows());
        assertEquals(0, data.errorRows());
        assertEquals(HashUtil.sha256Hex(content), data.fileSha256());

        ArgumentCaptor<ImportBatch> captor = ArgumentCaptor.forClass(ImportBatch.class);
        verify(importBatchRepository).save(captor.capture());
        ImportBatch batch = captor.getValue();
        assertEquals(ImportBatch.STATUS_PENDING, batch.getStatus());
        assertEquals(2, batch.getRowsJson().size());
        assertNotNull(batch.getRowsJson().get(0).get("_row"));
        // 预览不产生任何业务数据写入
        verify(orderCommandService, never()).createOrderCore(any());
        verify(machineCommandService, never()).createMachineCore(any());
        verify(auditService).record(eq("IMPORT_PREVIEW"), eq("import_batch"), eq("IMP-000001"), anyString());
    }

    @Test
    void preview_orderRowErrors_reportedWithCodeFieldValue() {
        when(codeGenerator.next("IMP")).thenReturn("IMP-000002");
        ProductionOrder dup = new ProductionOrder();
        dup.setOrderCode("PO-DUP");
        when(productionOrderRepository.findByOrderCodeIn(any())).thenReturn(List.of(dup));
        stubOrderTemplateOk("轴类");
        byte[] content = ordersCsv(
                // 行2：编号与库中重复
                "PO-DUP,轴类,10,2026-10-09T08:00:00+08:00,2026-10-20T18:00:00+08:00,3,",
                // 行3：数量非整数 + 优先级超界
                "PO-200,轴类,abc,2026-10-09T08:00:00+08:00,2026-10-20T18:00:00+08:00,9,",
                // 行4：交期早于到达
                "PO-201,轴类,10,2026-10-20T08:00:00+08:00,2026-10-09T18:00:00+08:00,3,",
                // 行5：文件内重复
                "PO-201,轴类,10,2026-10-09T08:00:00+08:00,2026-10-20T18:00:00+08:00,3,",
                // 行6：产品族无启用模板
                "PO-202,未知族,10,2026-10-09T08:00:00+08:00,2026-10-20T18:00:00+08:00,3,");

        ImportBatchResponse data = service.preview("orders", "orders.csv", content);

        assertEquals(5, data.totalRows());
        assertEquals(0, data.successRows());
        assertEquals(5, data.errorRows());
        List<ImportRowError> errors = data.errors();
        assertError(errors, 2, "E_DUPLICATE", "orderCode", "PO-DUP");
        assertError(errors, 3, "E_FORMAT", "quantity", "abc");
        assertError(errors, 3, "E_RANGE", "priority", "9");
        assertError(errors, 4, "E_TIME_ORDER", "dueAt", "2026-10-09T18:00:00+08:00");
        assertError(errors, 5, "E_DUPLICATE", "orderCode", "PO-201");
        assertError(errors, 6, "E_REFERENCE", "productFamily", "未知族");
        for (ImportRowError error : errors) {
            assertNotNull(error.suggestion(), "每个错误应有修正建议");
        }
    }

    @Test
    void preview_machineRows_calendarReferenceChecked() {
        when(codeGenerator.next("IMP")).thenReturn("IMP-000003");
        when(workCalendarRepository.existsById("CAL-9")).thenReturn(false);
        byte[] content = machinesCsv(
                "M-100,车床,WC-车削,CAL-9,轴类|盘类,",
                "M-100,车床2,WC-车削,,轴类,");

        ImportBatchResponse data = service.preview("machines", "machines.csv", content);

        assertEquals(2, data.errorRows());
        assertError(data.errors(), 2, "E_REFERENCE", "calendarId", "CAL-9");
        assertError(data.errors(), 3, "E_DUPLICATE", "machineCode", "M-100");
    }

    @Test
    void preview_quotedCellsAndBom_parsed() {
        when(codeGenerator.next("IMP")).thenReturn("IMP-000004");
        byte[] content = ("﻿machineCode,machineName,workCenterId,calendarId,productFamilies,remark\r\n"
                + "\"M-100\",\"车床, 精密型\",\"WC-车削\",,\"轴类|盘类\",\"含\"\"引号\"\"备注\"\r\n")
                .getBytes(StandardCharsets.UTF_8);

        ImportBatchResponse data = service.preview("machines", "machines.csv", content);

        assertEquals(0, data.errorRows());
        ArgumentCaptor<ImportBatch> captor = ArgumentCaptor.forClass(ImportBatch.class);
        verify(importBatchRepository).save(captor.capture());
        Map<String, String> row = captor.getValue().getRowsJson().get(0);
        assertEquals("车床, 精密型", row.get("machineName"));
        assertEquals("含\"引号\"备注", row.get("remark"));
    }

    private static void assertError(List<ImportRowError> errors, int row,
                                    String code, String field, String value) {
        boolean found = errors.stream().anyMatch(e -> e.row() == row
                && e.code().equals(code) && e.field().equals(field)
                && e.value().equals(value));
        assertTrue(found, "缺少错误 row=" + row + " code=" + code + " field=" + field
                + " value=" + value + "，实际: " + errors);
    }

    /* ---------------- 提交 ---------------- */

    private ImportBatch pendingBatch(String type, int errorRows, List<Map<String, String>> rows) {
        ImportBatch batch = new ImportBatch();
        batch.setId("b-1");
        batch.setBatchCode("IMP-000010");
        batch.setImportType(type);
        batch.setStatus(ImportBatch.STATUS_PENDING);
        batch.setFileSha256("sha");
        batch.setTotalRows(rows.size());
        batch.setErrorRows(errorRows);
        batch.setSuccessRows(rows.size() - errorRows);
        batch.setRowsJson(rows);
        return batch;
    }

    private Map<String, String> machineRow(String code) {
        return new LinkedHashMapBuilder()
                .put("_row", "2").put("machineCode", code).put("machineName", "")
                .put("workCenterId", "WC-1").put("calendarId", "")
                .put("productFamilies", "轴类").put("remark", "")
                .build();
    }

    @Test
    void commit_batchWithErrors_rejectedNoWrites() {
        stubExecuteRunsAction();
        ImportBatch batch = pendingBatch("machines", 1, List.of(machineRow("M-1")));
        when(importBatchRepository.findByBatchCode("IMP-000010")).thenReturn(Optional.of(batch));

        BizException e = assertThrows(BizException.class,
                () -> service.commit("machines", "key-1", new ImportCommitRequest("IMP-000010")));

        assertEquals("E_STATE_CONFLICT", e.getCode());
        verify(machineCommandService, never()).createMachineCore(any());
    }

    @Test
    void commit_alreadyCommitted_conflict() {
        stubExecuteRunsAction();
        ImportBatch batch = pendingBatch("machines", 0, List.of(machineRow("M-1")));
        batch.setStatus(ImportBatch.STATUS_COMMITTED);
        when(importBatchRepository.findByBatchCode("IMP-000010")).thenReturn(Optional.of(batch));

        BizException e = assertThrows(BizException.class,
                () -> service.commit("machines", "key-1", new ImportCommitRequest("IMP-000010")));

        assertEquals("E_STATE_CONFLICT", e.getCode());
    }

    @Test
    void commit_validBatch_insertsAllRowsAndAudits() {
        stubExecuteRunsAction();
        ImportBatch batch = pendingBatch("machines", 0,
                List.of(machineRow("M-1"), machineRow("M-2")));
        when(importBatchRepository.findByBatchCode("IMP-000010")).thenReturn(Optional.of(batch));
        when(machineCommandService.createMachineCore(any())).thenReturn(anyMachineResponse());

        ImportBatchResponse data = service.commit("machines", "key-1", new ImportCommitRequest("IMP-000010"));

        assertEquals("COMMITTED", data.status());
        assertEquals(2, data.committedRows());
        verify(machineCommandService, times(2)).createMachineCore(any(MachineUpsertRequest.class));
        assertEquals(ImportBatch.STATUS_COMMITTED, batch.getStatus());
        assertNotNull(batch.getCommittedAt());
        verify(auditService).record(eq("IMPORT_COMMIT"), eq("import_batch"), eq("IMP-000010"), anyString());
    }

    @Test
    void commit_idempotentReplay_skipsAction() {
        when(idempotencyService.execute(any(), any(), any(), eq(ImportBatchResponse.class)))
                .thenReturn(new ImportBatchResponse("IMP-000010", "machines", "COMMITTED", null, null,
                        1, 1, 0, null, null, null, null, 1));

        ImportBatchResponse data = service.commit("machines", "key-1", new ImportCommitRequest("IMP-000010"));

        assertEquals("COMMITTED", data.status());
        verify(importBatchRepository, never()).findByBatchCode(anyString());
        verify(machineCommandService, never()).createMachineCore(any());
    }

    @Test
    void commit_revalidationFails_batchFailedWithoutWrites() {
        stubExecuteRunsAction();
        ImportBatch batch = pendingBatch("machines", 0, List.of(machineRow("M-1")));
        when(importBatchRepository.findByBatchCode("IMP-000010")).thenReturn(Optional.of(batch));
        // 预览后其他管理员已创建同编码设备：提交复检应拦截
        when(machineRepository.existsByMachineCode("M-1")).thenReturn(true);

        ImportBatchResponse data = service.commit("machines", "key-1", new ImportCommitRequest("IMP-000010"));

        assertEquals("FAILED", data.status());
        assertEquals(ImportBatch.STATUS_FAILED, batch.getStatus());
        assertEquals(1, batch.getErrors().size());
        verify(machineCommandService, never()).createMachineCore(any());
        verify(auditService).record(eq("IMPORT_COMMIT_FAILED"), eq("import_batch"), eq("IMP-000010"), anyString());
    }

    @Test
    void commit_insertFailure_propagatesAndStaysPending() {
        stubExecuteRunsAction();
        ImportBatch batch = pendingBatch("machines", 0,
                List.of(machineRow("M-1"), machineRow("M-2")));
        when(importBatchRepository.findByBatchCode("IMP-000010")).thenReturn(Optional.of(batch));
        // 复检通过但第二行写入失败：异常向上抛，外层事务整体回滚（不产生半批数据），批次不落 COMMITTED
        when(machineCommandService.createMachineCore(any()))
                .thenReturn(anyMachineResponse())
                .thenThrow(BizException.duplicate("设备编码重复: M-2"));

        BizException e = assertThrows(BizException.class,
                () -> service.commit("machines", "key-1", new ImportCommitRequest("IMP-000010")));

        assertEquals("E_DUPLICATE", e.getCode());
        assertEquals(ImportBatch.STATUS_PENDING, batch.getStatus());
        verify(importBatchRepository, never()).save(any());
        verify(auditService, never()).record(eq("IMPORT_COMMIT"), anyString(), anyString(), anyString());
    }

    @Test
    void commit_typeMismatch_rejected() {
        stubExecuteRunsAction();
        ImportBatch batch = pendingBatch("machines", 0, List.of(machineRow("M-1")));
        when(importBatchRepository.findByBatchCode("IMP-000010")).thenReturn(Optional.of(batch));

        BizException e = assertThrows(BizException.class,
                () -> service.commit("orders", "key-1", new ImportCommitRequest("IMP-000010")));

        assertEquals("E_VALIDATION", e.getCode());
    }

    private static final class LinkedHashMapBuilder {
        private final Map<String, String> map = new java.util.LinkedHashMap<>();

        LinkedHashMapBuilder put(String key, String value) {
            map.put(key, value);
            return this;
        }

        Map<String, String> build() {
            return map;
        }
    }
}
