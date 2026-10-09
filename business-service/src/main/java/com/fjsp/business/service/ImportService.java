package com.fjsp.business.service;

import java.nio.charset.StandardCharsets;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;

import com.fjsp.business.common.BizException;
import com.fjsp.business.common.HashUtil;
import com.fjsp.business.common.RequestContext;
import com.fjsp.business.dto.ImportBatchResponse;
import com.fjsp.business.dto.ImportCommitRequest;
import com.fjsp.business.dto.ImportRowError;
import com.fjsp.business.dto.MachineUpsertRequest;
import com.fjsp.business.dto.OrderUpsertRequest;
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
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * F-05 批量导入与校验（裁剪范围：订单 orders / 设备 machines，仅 CSV，UTF-8 兼容 BOM）。
 * 预览：文件预检（大小/扩展名/行数/表头）+ 逐行校验，批次落库 PENDING 并保存解析行，
 * 不写业务数据；提交：复检当前库状态，仅无错误批次整批入库（单事务全滚），
 * 幂等防重复提交，写导入审计。
 */
@Service
public class ImportService {

    public static final String TYPE_ORDERS = "orders";
    public static final String TYPE_MACHINES = "machines";

    static final long MAX_FILE_BYTES = 2L * 1024 * 1024;
    static final int MAX_ROWS = 1000;

    private static final String CRLF = "\r\n";

    static final List<String> ORDER_COLUMNS = List.of(
            "orderCode", "productFamily", "quantity", "arrivalAt", "dueAt", "priority", "templateId");
    static final List<String> MACHINE_COLUMNS = List.of(
            "machineCode", "machineName", "workCenterId", "calendarId", "productFamilies", "remark");

    private final ImportBatchRepository importBatchRepository;
    private final MachineRepository machineRepository;
    private final ProductionOrderRepository productionOrderRepository;
    private final ProcessTemplateRepository processTemplateRepository;
    private final ProcessOperationRepository processOperationRepository;
    private final WorkCalendarRepository workCalendarRepository;
    private final MachineCommandService machineCommandService;
    private final OrderCommandService orderCommandService;
    private final CodeGenerator codeGenerator;
    private final IdempotencyService idempotencyService;
    private final AuditService auditService;

    public ImportService(ImportBatchRepository importBatchRepository,
                         MachineRepository machineRepository,
                         ProductionOrderRepository productionOrderRepository,
                         ProcessTemplateRepository processTemplateRepository,
                         ProcessOperationRepository processOperationRepository,
                         WorkCalendarRepository workCalendarRepository,
                         MachineCommandService machineCommandService,
                         OrderCommandService orderCommandService,
                         CodeGenerator codeGenerator,
                         IdempotencyService idempotencyService,
                         AuditService auditService) {
        this.importBatchRepository = importBatchRepository;
        this.machineRepository = machineRepository;
        this.productionOrderRepository = productionOrderRepository;
        this.processTemplateRepository = processTemplateRepository;
        this.processOperationRepository = processOperationRepository;
        this.workCalendarRepository = workCalendarRepository;
        this.machineCommandService = machineCommandService;
        this.orderCommandService = orderCommandService;
        this.codeGenerator = codeGenerator;
        this.idempotencyService = idempotencyService;
        this.auditService = auditService;
    }

    public record TemplateFile(String filename, byte[] content) {
    }

    /* ---------------- 模板下载 ---------------- */

    public TemplateFile template(String type) {
        List<String> columns = requireColumns(type);
        StringBuilder sb = new StringBuilder("\uFEFF");
        sb.append(String.join(",", columns)).append(CRLF);
        if (TYPE_ORDERS.equals(type)) {
            sb.append("PO-IMP-001,轴类,100,2026-10-09T08:00:00+08:00,2026-10-20T18:00:00+08:00,3,").append(CRLF);
            sb.append("PO-IMP-002,盘类,50,2026-10-09T08:00:00+08:00,2026-10-25T18:00:00+08:00,2,").append(CRLF);
        } else {
            sb.append("M-IMP-01,车削中心 4 号机,WC-车削,,轴类|盘类,示例行，导入前请修改或删除").append(CRLF);
        }
        return new TemplateFile("import-" + type + "-template.csv",
                sb.toString().getBytes(StandardCharsets.UTF_8));
    }

    /* ---------------- 预览 ---------------- */

    @Transactional
    public ImportBatchResponse preview(String type, String fileName, byte[] content) {
        List<String> columns = requireColumns(type);
        precheckFile(fileName, content);
        List<List<String>> records = parseCsv(new String(content, StandardCharsets.UTF_8));
        if (records.isEmpty()) {
            throw BizException.validation("文件无内容，缺少表头行");
        }
        List<String> header = records.get(0).stream().map(ImportService::trimToEmpty).toList();
        if (!header.equals(columns)) {
            throw BizException.validation("表头与模板不一致，期望: " + String.join(",", columns));
        }
        List<Map<String, String>> rows = new ArrayList<>();
        for (int i = 1; i < records.size(); i++) {
            List<String> record = records.get(i);
            boolean allBlank = record.stream().allMatch(c -> trimToEmpty(c).isEmpty());
            if (allBlank) {
                continue;
            }
            Map<String, String> row = new LinkedHashMap<>();
            row.put("_row", String.valueOf(i + 1));
            for (int c = 0; c < columns.size(); c++) {
                row.put(columns.get(c), trimToEmpty(c < record.size() ? record.get(c) : ""));
            }
            rows.add(row);
        }
        if (rows.isEmpty()) {
            throw BizException.validation("文件无数据行");
        }
        if (rows.size() > MAX_ROWS) {
            throw BizException.validation("数据行超过上限 " + MAX_ROWS + " 行（当前 " + rows.size() + " 行）");
        }

        List<ImportRowError> errors = TYPE_ORDERS.equals(type)
                ? validateOrderRows(rows) : validateMachineRows(rows);
        long errorRowCount = errors.stream().map(ImportRowError::row).distinct().count();

        ImportBatch batch = new ImportBatch();
        batch.setId(UUID.randomUUID().toString());
        batch.setBatchCode(codeGenerator.next("IMP"));
        batch.setImportType(type);
        batch.setStatus(ImportBatch.STATUS_PENDING);
        batch.setFileName(fileName);
        batch.setFileSha256(HashUtil.sha256Hex(content));
        batch.setTotalRows(rows.size());
        batch.setErrorRows((int) errorRowCount);
        batch.setSuccessRows(rows.size() - (int) errorRowCount);
        batch.setErrors(toErrorMaps(errors));
        batch.setRowsJson(rows);
        batch.setOperator(RequestContext.operator());
        importBatchRepository.save(batch);
        auditService.record("IMPORT_PREVIEW", "import_batch", batch.getBatchCode(),
                "type=" + type + ", rows=" + rows.size() + ", errorRows=" + errorRowCount
                        + ", sha256=" + batch.getFileSha256());

        return toResponse(batch, errors, null);
    }

    /* ---------------- 提交 ---------------- */

    @Transactional
    public ImportBatchResponse commit(String type, String idempotencyKey, ImportCommitRequest req) {
        String batchCode = req != null ? req.batchCode() : null;
        return idempotencyService.execute(idempotencyKey,
                Map.of("type", type, "batchCode", batchCode != null ? batchCode : ""),
                () -> doCommit(type, batchCode), ImportBatchResponse.class);
    }

    private ImportBatchResponse doCommit(String type, String batchCode) {
        requireColumns(type);
        if (batchCode == null || batchCode.isBlank()) {
            throw BizException.validation("batchCode 必填");
        }
        ImportBatch batch = importBatchRepository.findByBatchCode(batchCode)
                .orElseThrow(() -> BizException.notFound("导入批次不存在: " + batchCode));
        if (!batch.getImportType().equals(type)) {
            throw BizException.validation("批次 " + batchCode + " 的类型是 "
                    + batch.getImportType() + "，与接口类型 " + type + " 不一致");
        }
        if (ImportBatch.STATUS_COMMITTED.equals(batch.getStatus())) {
            throw BizException.stateConflict("批次已入库，请勿重复提交: " + batchCode);
        }
        if (ImportBatch.STATUS_FAILED.equals(batch.getStatus())) {
            throw BizException.stateConflict("批次已标记失败，请修正文件后重新预览导入: " + batchCode);
        }
        if (batch.getErrorRows() > 0) {
            throw BizException.stateConflict("批次存在 " + batch.getErrorRows()
                    + " 行错误，禁止入库，请修正后重新预览");
        }

        List<Map<String, String>> rows = batch.getRowsJson() != null ? batch.getRowsJson() : List.of();
        // 提交复检：预览后基础数据可能已变化，按当前库状态重跑同一套校验
        List<ImportRowError> errors = TYPE_ORDERS.equals(type)
                ? validateOrderRows(rows) : validateMachineRows(rows);
        if (!errors.isEmpty()) {
            batch.setStatus(ImportBatch.STATUS_FAILED);
            batch.setErrors(toErrorMaps(errors));
            importBatchRepository.save(batch);
            auditService.record("IMPORT_COMMIT_FAILED", "import_batch", batchCode,
                    "type=" + type + ", 提交复检发现 " + errors.size() + " 个错误");
            return toResponse(batch, errors, null);
        }

        for (Map<String, String> row : rows) {
            if (TYPE_ORDERS.equals(type)) {
                orderCommandService.createOrderCore(toOrderRequest(row));
            } else {
                machineCommandService.createMachineCore(toMachineRequest(row));
            }
        }
        batch.setStatus(ImportBatch.STATUS_COMMITTED);
        batch.setCommittedAt(OffsetDateTime.now());
        batch.setSuccessRows(rows.size());
        importBatchRepository.save(batch);
        auditService.record("IMPORT_COMMIT", "import_batch", batchCode,
                "type=" + type + ", rows=" + rows.size() + ", sha256=" + batch.getFileSha256());

        return toResponse(batch, null, rows.size());
    }

    /* ---------------- 文件预检与 CSV 解析 ---------------- */

    private void precheckFile(String fileName, byte[] content) {
        if (content == null || content.length == 0) {
            throw BizException.validation("上传文件为空");
        }
        if (content.length > MAX_FILE_BYTES) {
            throw BizException.validation("文件超过大小上限 2MB（当前 " + content.length + " 字节）");
        }
        if (fileName == null || !fileName.toLowerCase(Locale.ROOT).endsWith(".csv")) {
            throw BizException.validation("仅支持 .csv 文件（当前: " + fileName + "）");
        }
    }

    /** RFC4180 子集：逗号分隔、双引号包裹（内嵌 "" 转义）、CRLF/LF 换行、UTF-8 BOM。 */
    static List<List<String>> parseCsv(String text) {
        if (text.startsWith("\uFEFF")) {
            text = text.substring(1);
        }
        List<List<String>> records = new ArrayList<>();
        List<String> row = new ArrayList<>();
        StringBuilder cell = new StringBuilder();
        boolean inQuotes = false;
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (inQuotes) {
                if (c == '"') {
                    if (i + 1 < text.length() && text.charAt(i + 1) == '"') {
                        cell.append('"');
                        i++;
                    } else {
                        inQuotes = false;
                    }
                } else {
                    cell.append(c);
                }
            } else if (c == '"') {
                inQuotes = true;
            } else if (c == ',') {
                row.add(cell.toString());
                cell.setLength(0);
            } else if (c == '\r') {
                // 由紧随的 \n 结束记录；孤立的 \r 忽略
            } else if (c == '\n') {
                row.add(cell.toString());
                cell.setLength(0);
                records.add(row);
                row = new ArrayList<>();
            } else {
                cell.append(c);
            }
        }
        if (cell.length() > 0 || !row.isEmpty()) {
            row.add(cell.toString());
            records.add(row);
        }
        return records;
    }

    /* ---------------- 逐行校验 ---------------- */

    private List<ImportRowError> validateOrderRows(List<Map<String, String>> rows) {
        List<ImportRowError> errors = new ArrayList<>();
        Set<String> seenCodes = new HashSet<>();
        // 一次性批量查回文件内订单编号在库中的存在情况，替代逐行 existsByOrderCode 的 N+1
        List<String> orderCodes = rows.stream().map(row -> row.get("orderCode"))
                .filter(code -> !code.isEmpty()).distinct().toList();
        Set<String> existingCodes = orderCodes.isEmpty() ? Set.of()
                : productionOrderRepository.findByOrderCodeIn(orderCodes).stream()
                        .map(ProductionOrder::getOrderCode)
                        .collect(Collectors.toSet());
        for (Map<String, String> row : rows) {
            int rowNo = rowNo(row);
            String orderCode = row.get("orderCode");
            if (orderCode.isEmpty()) {
                errors.add(new ImportRowError(rowNo, "E_REQUIRED", "orderCode", orderCode, "订单编号必填"));
            } else if (!seenCodes.add(orderCode)) {
                errors.add(new ImportRowError(rowNo, "E_DUPLICATE", "orderCode", orderCode,
                        "订单编号在文件内重复，请去重"));
            } else if (existingCodes.contains(orderCode)) {
                errors.add(new ImportRowError(rowNo, "E_DUPLICATE", "orderCode", orderCode,
                        "订单编号已存在，请更换编号或删除该行"));
            }

            String family = row.get("productFamily");
            if (family.isEmpty()) {
                errors.add(new ImportRowError(rowNo, "E_REQUIRED", "productFamily", family, "产品族必填"));
            }

            Integer quantity = parseIntField(errors, rowNo, "quantity", row.get("quantity"), "数量必须是整数");
            if (quantity != null && quantity <= 0) {
                errors.add(new ImportRowError(rowNo, "E_RANGE", "quantity", row.get("quantity"),
                        "数量必须是正整数"));
            }
            Integer priority = parseIntField(errors, rowNo, "priority", row.get("priority"), "优先级必须是整数");
            if (priority != null && (priority < 1 || priority > 5)) {
                errors.add(new ImportRowError(rowNo, "E_RANGE", "priority", row.get("priority"),
                        "优先级必须在 1-5 之间"));
            }

            OffsetDateTime arrival = parseTimeField(errors, rowNo, "arrivalAt", row.get("arrivalAt"));
            OffsetDateTime due = parseTimeField(errors, rowNo, "dueAt", row.get("dueAt"));
            if (arrival != null && due != null && due.isBefore(arrival)) {
                errors.add(new ImportRowError(rowNo, "E_TIME_ORDER", "dueAt", row.get("dueAt"),
                        "交货期不能早于到达时间"));
            }

            if (!family.isEmpty()) {
                validateOrderTemplate(errors, rowNo, family, row.get("templateId"));
            }
        }
        return errors;
    }

    private void validateOrderTemplate(List<ImportRowError> errors, int rowNo,
                                       String family, String templateId) {
        ProcessTemplate template;
        if (templateId != null && !templateId.isEmpty()) {
            template = processTemplateRepository.findById(templateId).orElse(null);
            if (template == null) {
                errors.add(new ImportRowError(rowNo, "E_REFERENCE", "templateId", templateId,
                        "工艺模板不存在，请核对模板 ID 或留空按产品族自动匹配"));
                return;
            }
            if (!"ACTIVE".equals(template.getStatus())) {
                errors.add(new ImportRowError(rowNo, "E_REFERENCE", "templateId", templateId,
                        "工艺模板未启用: " + template.getTemplateCode()));
                return;
            }
            if (!template.getProductFamily().equals(family)) {
                errors.add(new ImportRowError(rowNo, "E_REFERENCE", "templateId", templateId,
                        "模板产品族 " + template.getProductFamily() + " 与订单产品族 " + family + " 不一致"));
                return;
            }
        } else {
            template = processTemplateRepository
                    .findFirstByProductFamilyAndStatusOrderByTemplateVersionDesc(family, "ACTIVE")
                    .orElse(null);
            if (template == null) {
                errors.add(new ImportRowError(rowNo, "E_REFERENCE", "productFamily", family,
                        "产品族无启用中的工艺模板，请先维护工艺模板"));
                return;
            }
        }
        if (processOperationRepository.findByTemplateIdOrderBySequenceNo(template.getId()).isEmpty()) {
            errors.add(new ImportRowError(rowNo, "E_REFERENCE", "templateId", template.getId(),
                    "工艺模板没有工序定义: " + template.getTemplateCode()));
        }
    }

    private List<ImportRowError> validateMachineRows(List<Map<String, String>> rows) {
        List<ImportRowError> errors = new ArrayList<>();
        Set<String> seenCodes = new HashSet<>();
        for (Map<String, String> row : rows) {
            int rowNo = rowNo(row);
            String machineCode = row.get("machineCode");
            if (machineCode.isEmpty()) {
                errors.add(new ImportRowError(rowNo, "E_REQUIRED", "machineCode", machineCode, "设备编码必填"));
            } else if (!seenCodes.add(machineCode)) {
                errors.add(new ImportRowError(rowNo, "E_DUPLICATE", "machineCode", machineCode,
                        "设备编码在文件内重复，请去重"));
            } else if (machineRepository.existsByMachineCode(machineCode)) {
                errors.add(new ImportRowError(rowNo, "E_DUPLICATE", "machineCode", machineCode,
                        "设备编码已存在，请更换编码或删除该行"));
            }
            if (row.get("workCenterId").isEmpty()) {
                errors.add(new ImportRowError(rowNo, "E_REQUIRED", "workCenterId", "",
                        "工作中心必填"));
            }
            if (parseFamilies(row.get("productFamilies")).isEmpty()) {
                errors.add(new ImportRowError(rowNo, "E_REQUIRED", "productFamilies",
                        row.get("productFamilies"), "至少填写一个能力产品族（多个用 | 分隔）"));
            }
            String calendarId = row.get("calendarId");
            if (!calendarId.isEmpty() && !workCalendarRepository.existsById(calendarId)) {
                errors.add(new ImportRowError(rowNo, "E_REFERENCE", "calendarId", calendarId,
                        "绑定的日历不存在，请核对或留空"));
            }
        }
        return errors;
    }

    private Integer parseIntField(List<ImportRowError> errors, int rowNo, String field,
                                  String raw, String suggestion) {
        if (raw == null || raw.isEmpty()) {
            errors.add(new ImportRowError(rowNo, "E_REQUIRED", field, "", field + " 必填"));
            return null;
        }
        try {
            return Integer.valueOf(raw);
        } catch (NumberFormatException e) {
            errors.add(new ImportRowError(rowNo, "E_FORMAT", field, raw, suggestion));
            return null;
        }
    }

    private OffsetDateTime parseTimeField(List<ImportRowError> errors, int rowNo,
                                          String field, String raw) {
        if (raw == null || raw.isEmpty()) {
            errors.add(new ImportRowError(rowNo, "E_REQUIRED", field, "", field + " 必填"));
            return null;
        }
        try {
            return OffsetDateTime.parse(raw);
        } catch (DateTimeParseException e) {
            errors.add(new ImportRowError(rowNo, "E_FORMAT", field, raw,
                    "时间格式应为 ISO-8601，如 2026-10-09T08:00:00+08:00"));
            return null;
        }
    }

    /* ---------------- 行 -> 写入请求 ---------------- */

    private OrderUpsertRequest toOrderRequest(Map<String, String> row) {
        return new OrderUpsertRequest(row.get("orderCode"), row.get("productFamily"),
                Integer.valueOf(row.get("quantity")), row.get("arrivalAt"), row.get("dueAt"),
                Integer.valueOf(row.get("priority")), blankToNull(row.get("templateId")),
                blankToNull(row.get("remark")));
    }

    private MachineUpsertRequest toMachineRequest(Map<String, String> row) {
        return new MachineUpsertRequest(row.get("machineCode"), blankToNull(row.get("machineName")),
                row.get("workCenterId"), blankToNull(row.get("calendarId")),
                parseFamilies(row.get("productFamilies")), blankToNull(row.get("remark")));
    }

    private static List<String> parseFamilies(String raw) {
        if (raw == null || raw.isBlank()) {
            return List.of();
        }
        List<String> families = new ArrayList<>();
        for (String part : raw.split("[|;,，；]")) {
            String family = part.trim();
            if (!family.isEmpty() && !families.contains(family)) {
                families.add(family);
            }
        }
        return families;
    }

    /* ---------------- 工具 ---------------- */

    private List<String> requireColumns(String type) {
        if (TYPE_ORDERS.equals(type)) {
            return ORDER_COLUMNS;
        }
        if (TYPE_MACHINES.equals(type)) {
            return MACHINE_COLUMNS;
        }
        throw BizException.validation("不支持的导入类型: " + type + "（仅支持 orders / machines）");
    }

    private static int rowNo(Map<String, String> row) {
        String raw = row.get("_row");
        return raw != null ? Integer.parseInt(raw) : -1;
    }

    private static List<Map<String, Object>> toErrorMaps(List<ImportRowError> errors) {
        List<Map<String, Object>> maps = new ArrayList<>();
        for (ImportRowError e : errors) {
            Map<String, Object> map = new LinkedHashMap<>();
            map.put("row", e.row());
            map.put("code", e.code());
            map.put("field", e.field());
            map.put("value", e.value());
            map.put("suggestion", e.suggestion());
            maps.add(map);
        }
        return maps;
    }

    private static ImportBatchResponse toResponse(ImportBatch batch, List<ImportRowError> errors,
                                                  Integer committedRows) {
        return new ImportBatchResponse(batch.getBatchCode(), batch.getImportType(), batch.getStatus(),
                batch.getFileName(), batch.getFileSha256(), batch.getTotalRows(), batch.getSuccessRows(),
                batch.getErrorRows(), batch.getOperator(), batch.getCreatedAt(), batch.getCommittedAt(),
                errors, committedRows);
    }

    private static String trimToEmpty(String value) {
        return value != null ? value.trim() : "";
    }

    private static String blankToNull(String value) {
        return value == null || value.isBlank() ? null : value;
    }
}
