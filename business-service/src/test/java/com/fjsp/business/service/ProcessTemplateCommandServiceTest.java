package com.fjsp.business.service;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.function.Supplier;

import com.fjsp.business.common.BizException;
import com.fjsp.business.dto.TemplateStatusRequest;
import com.fjsp.business.dto.TemplateUpsertRequest;
import com.fjsp.business.entity.Machine;
import com.fjsp.business.entity.ProcessOperation;
import com.fjsp.business.entity.ProcessTemplate;
import com.fjsp.business.repository.MachineRepository;
import com.fjsp.business.repository.ProcessOperationRepository;
import com.fjsp.business.repository.ProcessTemplateRepository;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class ProcessTemplateCommandServiceTest {
    @Mock private MachineRepository machineRepository;
    @Mock private ProcessTemplateRepository processTemplateRepository;
    @Mock private ProcessOperationRepository processOperationRepository;
    @Mock private IdempotencyService idempotencyService;
    @Mock private AuditService auditService;
    @InjectMocks private ProcessTemplateCommandService service;

    private void executeAction() {
        when(idempotencyService.execute(anyString(), any(), any(), any()))
                .thenAnswer(inv -> ((Supplier<?>) inv.getArgument(2)).get());
    }

    @Test
    void createRejectsDuplicateCandidateBeforeSaving() {
        executeAction();
        when(machineRepository.findById("M1")).thenReturn(Optional.of(new Machine()));
        var req = new TemplateUpsertRequest("TPL-1", "F1", List.of(
                new TemplateUpsertRequest.TemplateOperationInput(1, "OP", List.of(
                        new TemplateUpsertRequest.CandidateInput("M1", 5, 10),
                        new TemplateUpsertRequest.CandidateInput("M1", 5, 20)))));
        BizException error = assertThrows(BizException.class, () -> service.createTemplate("key", req));
        assertEquals("E_VALIDATION", error.getCode());
        assertTrue(error.getMessage().contains("候选设备不能重复"));
        verify(processTemplateRepository, never()).save(any());
        verify(processOperationRepository, never()).save(any());
    }

    @Test
    void activationRejectsExistingDuplicateCandidates() {
        executeAction();
        ProcessTemplate template = new ProcessTemplate();
        template.setId("TPL-1");
        template.setStatus("DRAFT");
        when(processTemplateRepository.findById("TPL-1")).thenReturn(Optional.of(template));
        ProcessOperation operation = new ProcessOperation();
        operation.setSequenceNo(1);
        operation.setOperationCode("OP");
        operation.setDefaultCandidates(List.of(
                Map.of("machineId", "M1", "setupMinutes", 5, "processMinutes", 10),
                Map.of("machineId", "M1", "setupMinutes", 5, "processMinutes", 20)));
        when(processOperationRepository.findByTemplateIdOrderBySequenceNo("TPL-1"))
                .thenReturn(List.of(operation));
        when(machineRepository.findById("M1")).thenReturn(Optional.of(new Machine()));
        BizException error = assertThrows(BizException.class, () -> service.changeTemplateStatus(
                "key", "TPL-1", new TemplateStatusRequest("ACTIVE")));
        assertEquals("E_VALIDATION", error.getCode());
        assertEquals("DRAFT", template.getStatus());
        verify(processTemplateRepository, never()).save(any());
    }

    @Test
    void sameMachineInDifferentOperationsIsAllowed() {
        executeAction();
        when(machineRepository.findById("M1")).thenReturn(Optional.of(new Machine()));
        var candidate = new TemplateUpsertRequest.CandidateInput("M1", 5, 10);
        var req = new TemplateUpsertRequest("TPL-1", "F1", List.of(
                new TemplateUpsertRequest.TemplateOperationInput(1, "OP1", List.of(candidate)),
                new TemplateUpsertRequest.TemplateOperationInput(2, "OP2", List.of(candidate))));
        assertEquals("TPL-1", service.createTemplate("key", req).templateCode());
        verify(processTemplateRepository).save(any());
    }
}
