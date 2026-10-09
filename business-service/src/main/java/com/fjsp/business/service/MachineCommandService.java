package com.fjsp.business.service;

import java.util.ArrayList;
import java.util.Set;

import com.fjsp.business.common.BizException;
import com.fjsp.business.dto.MachineResponse;
import com.fjsp.business.dto.MachineStatusRequest;
import com.fjsp.business.dto.MachineUpsertRequest;
import com.fjsp.business.entity.Machine;
import com.fjsp.business.entity.MachineStatus;
import com.fjsp.business.repository.MachineRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class MachineCommandService {

    private static final Set<String> MACHINE_STATUSES = Set.of(MachineStatus.ACTIVE, MachineStatus.INACTIVE);

    private final MachineRepository machineRepository;
    private final IdempotencyService idempotencyService;
    private final AuditService auditService;

    public MachineCommandService(MachineRepository machineRepository,
                                 IdempotencyService idempotencyService,
                                 AuditService auditService) {
        this.machineRepository = machineRepository;
        this.idempotencyService = idempotencyService;
        this.auditService = auditService;
    }

    @Transactional
    public MachineResponse createMachine(String idempotencyKey, MachineUpsertRequest req) {
        return idempotencyService.execute(idempotencyKey, req, () -> createMachineCore(req),
                MachineResponse.class);
    }

    /** 设备创建核心逻辑（校验 + 落库 + 审计），无幂等包装；批量导入整批提交时复用并加入调用方事务。 */
    public MachineResponse createMachineCore(MachineUpsertRequest req) {
        validateMachine(req);
        if (machineRepository.existsByMachineCode(req.machineCode())) {
            throw BizException.duplicate("设备编码重复: " + req.machineCode());
        }
        Machine machine = new Machine();
        machine.setId(req.machineCode());
        applyMachine(machine, req);
        machine.setStatus(MachineStatus.ACTIVE);
        machineRepository.save(machine);
        auditService.record("MACHINE_CREATE", "machine", machine.getId(),
                "machineCode=" + machine.getMachineCode());
        return toResponse(machine);
    }

    @Transactional
    public MachineResponse updateMachine(String idempotencyKey, String machineId, MachineUpsertRequest req) {
        return idempotencyService.execute(idempotencyKey, req, () -> {
            Machine machine = machineRepository.findById(machineId)
                    .orElseThrow(() -> BizException.notFound("设备不存在: " + machineId));
            validateMachine(req);
            if (!machine.getMachineCode().equals(req.machineCode())
                    && machineRepository.existsByMachineCode(req.machineCode())) {
                throw BizException.duplicate("设备编码重复: " + req.machineCode());
            }
            applyMachine(machine, req);
            machineRepository.save(machine);
            auditService.record("MACHINE_UPDATE", "machine", machine.getId(),
                    "machineCode=" + machine.getMachineCode());
            return toResponse(machine);
        }, MachineResponse.class);
    }

    @Transactional
    public MachineResponse changeMachineStatus(String idempotencyKey, String machineId,
                                                   MachineStatusRequest req) {
        return idempotencyService.execute(idempotencyKey, req, () -> {
            if (req == null || req.status() == null || !MACHINE_STATUSES.contains(req.status())) {
                throw BizException.validation("status 必须是 ACTIVE / INACTIVE");
            }
            Machine machine = machineRepository.findById(machineId)
                    .orElseThrow(() -> BizException.notFound("设备不存在: " + machineId));
            machine.setStatus(req.status());
            machineRepository.save(machine);
            auditService.record("MACHINE_STATUS", "machine", machine.getId(), "status=" + req.status());
            return toResponse(machine);
        }, MachineResponse.class);
    }

    private void validateMachine(MachineUpsertRequest req) {
        if (req == null || req.machineCode() == null || req.machineCode().isBlank()) {
            throw BizException.validation("machineCode 必填");
        }
        if (req.workCenterId() == null || req.workCenterId().isBlank()) {
            throw BizException.validation("workCenterId 必填");
        }
        if (req.productFamilies() == null || req.productFamilies().isEmpty()) {
            throw BizException.validation("productFamilies 至少选择一个能力产品族");
        }
    }

    private void applyMachine(Machine machine, MachineUpsertRequest req) {
        machine.setMachineCode(req.machineCode());
        machine.setMachineName(req.machineName());
        machine.setWorkCenterId(req.workCenterId());
        machine.setCalendarId(req.calendarId());
        machine.setProductFamilies(new ArrayList<>(req.productFamilies()));
        machine.setRemark(req.remark());
    }

    private MachineResponse toResponse(Machine machine) {
        return new MachineResponse(machine.getId(), machine.getMachineCode(), machine.getMachineName(),
                machine.getWorkCenterId(), machine.getCalendarId(), machine.getProductFamilies(),
                machine.getStatus(), machine.getRemark());
    }
}
