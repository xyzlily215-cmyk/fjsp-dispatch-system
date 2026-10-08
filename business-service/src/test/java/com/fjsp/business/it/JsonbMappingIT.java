package com.fjsp.business.it;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.fjsp.business.entity.ScheduleTask;
import com.fjsp.business.repository.ScheduleTaskRepository;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** jsonb 映射（kpi/conflicts）写入读回一致 + 分页查询 total 正确。 */
class JsonbMappingIT extends AbstractPostgresIT {

    @Autowired
    private ScheduleTaskRepository taskRepository;

    @AfterEach
    void cleanup() {
        taskRepository.deleteAll();
    }

    private ScheduleTask newTask(String code, OffsetDateTime createdAt) {
        ScheduleTask task = new ScheduleTask();
        task.setId(UUID.randomUUID().toString());
        task.setTaskCode(code);
        task.setMode("BASELINE");
        task.setStatus("SUCCESS");
        task.setProgress(100);
        task.setCreatedAt(createdAt);
        return task;
    }

    @Test
    void jsonbFields_roundTripExactly() throws Exception {
        ScheduleTask task = newTask("TSK-IT-JSON", OffsetDateTime.now());
        Map<String, Object> kpi = Map.of(
                "cMaxMinutes", 542,
                "weightedTardinessMinutes", 87.5,
                "utilizationByMachine", Map.of("M-01", 0.82, "M-02", 0.5));
        task.setKpi(kpi);
        task.setConflicts("[{\"type\":\"MACHINE_OVERLAP\",\"ops\":[\"O1\",\"O2\"]}]");
        taskRepository.saveAndFlush(task);

        ScheduleTask reloaded = taskRepository.findById(task.getId()).orElseThrow();
        assertEquals(542, reloaded.getKpi().get("cMaxMinutes"));
        assertEquals(87.5, reloaded.getKpi().get("weightedTardinessMinutes"));
        assertEquals(Map.of("M-01", 0.82, "M-02", 0.5), reloaded.getKpi().get("utilizationByMachine"));
        // jsonb 会规范化键序与空白，按解析后的 JSON 树比较
        com.fasterxml.jackson.databind.ObjectMapper om = new com.fasterxml.jackson.databind.ObjectMapper();
        assertEquals(om.readTree(task.getConflicts()), om.readTree(reloaded.getConflicts()));
    }

    @Test
    void pagedQuery_totalAndContentCorrect() {
        OffsetDateTime base = OffsetDateTime.now().minusMinutes(10);
        for (int i = 0; i < 5; i++) {
            taskRepository.save(newTask("TSK-IT-PAGE-" + i, base.plusMinutes(i)));
        }

        Page<ScheduleTask> page = taskRepository.findAllBy(
                PageRequest.of(1, 2, Sort.by(Sort.Direction.DESC, "createdAt")));

        assertEquals(5, page.getTotalElements());
        assertEquals(3, page.getTotalPages());
        assertEquals(2, page.getContent().size());
        // 倒序第 2 页（0 起）= createdAt 第 3、4 新
        List<String> codes = page.getContent().stream().map(ScheduleTask::getTaskCode).toList();
        assertEquals(List.of("TSK-IT-PAGE-2", "TSK-IT-PAGE-1"), codes);
        assertTrue(page.hasNext() && page.hasPrevious());
    }
}
