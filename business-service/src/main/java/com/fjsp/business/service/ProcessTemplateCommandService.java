package com.fjsp.business.service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import com.fjsp.business.common.BizException;
import com.fjsp.business.dto.ProcessTemplateResponse;
import com.fjsp.business.dto.TemplateStatusRequest;
import com.fjsp.business.dto.TemplateUpsertRequest;
import com.fjsp.business.entity.ProcessOperation;
import com.fjsp.business.entity.ProcessTemplate;
import com.fjsp.business.entity.TemplateStatus;
import com.fjsp.business.repository.MachineRepository;
import com.fjsp.business.repository.ProcessOperationRepository;
import com.fjsp.business.repository.ProcessTemplateRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class ProcessTemplateCommandService {

    private static final Set<String> TEMPLATE_STATUSES =
            Set.of(TemplateStatus.ACTIVE, TemplateStatus.INACTIVE, TemplateStatus.DRAFT);

    private final MachineRepository machineRepository;
    private final ProcessTemplateRepository processTemplateRepository;
    private final ProcessOperationRepository processOperationRepository;
    private final IdempotencyService idempotencyService;
    private final AuditService auditService;

    public ProcessTemplateCommandService(MachineRepository machineRepository,
                                         ProcessTemplateRepository processTemplateRepository,
                                         ProcessOperationRepository processOperationRepository,
                                         IdempotencyService idempotencyService,
                                         AuditService auditService) {
        this.machineRepository = machineRepository;
        this.processTemplateRepository = processTemplateRepository;
        this.processOperationRepository = processOperationRepository;
        this.idempotencyService = idempotencyService;
        this.auditService = auditService;
    }

    @Transactional
    public ProcessTemplateResponse createTemplate(String idempotencyKey, TemplateUpsertRequest req) {
        return idempotencyService.execute(idempotencyKey, req, () -> {
            if (req == null || req.templateCode() == null || req.templateCode().isBlank()
                    || req.productFamily() == null || req.productFamily().isBlank()) {
                throw BizException.validation("templateCode/productFamily 必填");
            }
            boolean duplicated = processTemplateRepository
                    .existsByTemplateCodeAndTemplateVersion(req.templateCode(), 1);
            if (duplicated) {
                throw BizException.duplicate("模板编码已存在: " + req.templateCode() + "，如需新版本请使用复制功能");
            }
            validateTemplateOperations(req.operations());

            ProcessTemplate template = new ProcessTemplate();
            template.setId(UUID.randomUUID().toString());
            template.setTemplateCode(req.templateCode());
            template.setProductFamily(req.productFamily());
            template.setTemplateVersion(1);
            template.setStatus(TemplateStatus.ACTIVE);
            processTemplateRepository.save(template);
            saveTemplateOperations(template.getId(), req.operations());
            auditService.record("TEMPLATE_CREATE", "process_template", template.getId(),
                    "templateCode=" + req.templateCode());
            return toResponse(template);
        }, ProcessTemplateResponse.class);
    }

    @Transactional
    public ProcessTemplateResponse changeTemplateStatus(String idempotencyKey, String templateId,
                                                        TemplateStatusRequest req) {
        return idempotencyService.execute(idempotencyKey, req, () -> {
            if (req == null || req.status() == null || !TEMPLATE_STATUSES.contains(req.status())) {
                throw BizException.validation("status 必须是 ACTIVE / INACTIVE / DRAFT");
            }
            ProcessTemplate template = processTemplateRepository.findById(templateId)
                    .orElseThrow(() -> BizException.notFound("工艺模板不存在: " + templateId));
            if (TemplateStatus.ACTIVE.equals(req.status())) {
                List<ProcessOperation> ops =
                        processOperationRepository.findByTemplateIdOrderBySequenceNo(templateId);
                validateTemplateOperations(toInputs(ops));
            }
            template.setStatus(req.status());
            processTemplateRepository.save(template);
            auditService.record("TEMPLATE_STATUS", "process_template", templateId, "status=" + req.status());
            return toResponse(template);
        }, ProcessTemplateResponse.class);
    }

    @Transactional
    public ProcessTemplateResponse copyTemplate(String idempotencyKey, String templateId) {
        return idempotencyService.execute(idempotencyKey, Map.of("templateId", templateId), () -> {
            ProcessTemplate source = processTemplateRepository.findById(templateId)
                    .orElseThrow(() -> BizException.notFound("工艺模板不存在: " + templateId));
            Integer maxVersion = processTemplateRepository
                    .findMaxTemplateVersionByTemplateCode(source.getTemplateCode());
            int nextVersion = (maxVersion != null ? maxVersion : 0) + 1;

            ProcessTemplate copy = new ProcessTemplate();
            copy.setId(UUID.randomUUID().toString());
            copy.setTemplateCode(source.getTemplateCode());
            copy.setProductFamily(source.getProductFamily());
            copy.setTemplateVersion(nextVersion);
            copy.setStatus(TemplateStatus.DRAFT);
            processTemplateRepository.save(copy);
            for (ProcessOperation po
                    : processOperationRepository.findByTemplateIdOrderBySequenceNo(templateId)) {
                ProcessOperation op = new ProcessOperation();
                op.setId(UUID.randomUUID().toString());
                op.setTemplateId(copy.getId());
                op.setSequenceNo(po.getSequenceNo());
                op.setOperationCode(po.getOperationCode());
                op.setDefaultCandidates(po.getDefaultCandidates() != null
                        ? new ArrayList<>(po.getDefaultCandidates()) : List.of());
                processOperationRepository.save(op);
            }
            auditService.record("TEMPLATE_COPY", "process_template", copy.getId(),
                    "from=" + source.getTemplateCode() + " v" + source.getTemplateVersion()
                            + " -> v" + nextVersion);
            return toResponse(copy);
        }, ProcessTemplateResponse.class);
    }

    private List<TemplateUpsertRequest.TemplateOperationInput> toInputs(List<ProcessOperation> ops) {
        List<TemplateUpsertRequest.TemplateOperationInput> inputs = new ArrayList<>();
        for (ProcessOperation po : ops) {
            List<TemplateUpsertRequest.CandidateInput> candidates = new ArrayList<>();
            if (po.getDefaultCandidates() != null) {
                for (Map<String, Object> c : po.getDefaultCandidates()) {
                    candidates.add(new TemplateUpsertRequest.CandidateInput(
                            c.get("machineId") != null ? String.valueOf(c.get("machineId")) : null,
                            c.get("setupMinutes") != null ? ((Number) c.get("setupMinutes")).intValue() : null,
                            c.get("processMinutes") != null ? ((Number) c.get("processMinutes")).intValue()
                                    : null));
                }
            }
            inputs.add(new TemplateUpsertRequest.TemplateOperationInput(
                    po.getSequenceNo(), po.getOperationCode(), candidates));
        }
        return inputs;
    }

    private void validateTemplateOperations(List<TemplateUpsertRequest.TemplateOperationInput> operations) {
        if (operations == null || operations.isEmpty()) {
            throw BizException.validation("模板至少需要一道工序");
        }
        Integer prev = null;
        for (TemplateUpsertRequest.TemplateOperationInput op : operations) {
            if (op.sequenceNo() == null) {
                throw BizException.validation("工序序号必填");
            }
            if (prev != null && op.sequenceNo() <= prev) {
                throw BizException.validation("工序序号必须严格递增且不重复（当前 " + op.sequenceNo() + " 在 " + prev + " 之后）");
            }
            prev = op.sequenceNo();
            if (op.operationCode() == null || op.operationCode().isBlank()) {
                throw BizException.validation("工序 " + op.sequenceNo() + " 的工序名称/编码必填");
            }
            if (op.defaultCandidates() == null || op.defaultCandidates().isEmpty()) {
                throw BizException.validation("工序 " + op.operationCode() + " 的候选设备不能为空");
            }
            for (TemplateUpsertRequest.CandidateInput c : op.defaultCandidates()) {
                if (c.machineId() == null || c.machineId().isBlank()) {
                    throw BizException.validation("工序 " + op.operationCode() + " 存在未指定设备的候选");
                }
                if (machineRepository.findById(c.machineId()).isEmpty()) {
                    throw BizException.validation("候选设备不存在: " + c.machineId());
                }
                if (c.setupMinutes() == null || c.setupMinutes() <= 0
                        || c.processMinutes() == null || c.processMinutes() <= 0) {
                    throw BizException.validation("工序 " + op.operationCode() + " 设备 " + c.machineId()
                            + " 的准备/加工时长必须大于 0");
                }
            }
        }
    }

    private void saveTemplateOperations(String templateId,
                                        List<TemplateUpsertRequest.TemplateOperationInput> operations) {
        for (TemplateUpsertRequest.TemplateOperationInput op : operations) {
            ProcessOperation po = new ProcessOperation();
            po.setId(UUID.randomUUID().toString());
            po.setTemplateId(templateId);
            po.setSequenceNo(op.sequenceNo());
            po.setOperationCode(op.operationCode());
            List<Map<String, Object>> candidates = new ArrayList<>();
            for (TemplateUpsertRequest.CandidateInput c : op.defaultCandidates()) {
                Map<String, Object> candidate = new LinkedHashMap<>();
                candidate.put("machineId", c.machineId());
                candidate.put("setupMinutes", c.setupMinutes());
                candidate.put("processMinutes", c.processMinutes());
                candidates.add(candidate);
            }
            po.setDefaultCandidates(candidates);
            processOperationRepository.save(po);
        }
    }

    private ProcessTemplateResponse toResponse(ProcessTemplate template) {
        List<ProcessTemplateResponse.TemplateOperationItem> ops = new ArrayList<>();
        for (ProcessOperation po : processOperationRepository.findByTemplateIdOrderBySequenceNo(template.getId())) {
            ops.add(new ProcessTemplateResponse.TemplateOperationItem(po.getSequenceNo(),
                    po.getOperationCode(), po.getDefaultCandidates()));
        }
        return new ProcessTemplateResponse(template.getId(), template.getTemplateCode(),
                template.getProductFamily(), template.getTemplateVersion(), template.getStatus(), ops);
    }
}
