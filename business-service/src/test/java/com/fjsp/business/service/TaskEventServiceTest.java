package com.fjsp.business.service;

import java.time.OffsetDateTime;
import java.util.Optional;

import com.fjsp.business.config.FjspProperties;
import com.fjsp.business.entity.ScheduleTask;
import com.fjsp.business.repository.ScheduleTaskRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class TaskEventServiceTest {

    @Mock
    private ScheduleTaskRepository taskRepository;

    private TaskEventService service;

    @BeforeEach
    void setUp() {
        service = new TaskEventService(taskRepository, new FjspProperties());
    }

    private ScheduleTask task(String status) {
        ScheduleTask task = new ScheduleTask();
        task.setId("t1");
        task.setTaskCode("TSK-001");
        task.setStatus(status);
        task.setProgress("PENDING".equals(status) ? 0 : 10);
        if (!"PENDING".equals(status)) {
            task.setStartedAt(OffsetDateTime.now().minusSeconds(5));
        }
        if ("FAILED".equals(status) || "SUCCESS".equals(status)) {
            task.setFinishedAt(OffsetDateTime.now());
        }
        return task;
    }

    @Test
    void subscribe_nonTerminal_registersSubscriberAndKeepsStreamOpen() {
        service.subscribe(task("RUNNING"));

        assertEquals(1, service.subscriberCount("t1"));
    }

    @Test
    void subscribe_terminal_sendsSnapshotThenClosesStream() {
        service.subscribe(task("SUCCESS"));

        assertEquals(0, service.subscriberCount("t1"), "终态任务推送快照后应立即关流并清理");
    }

    @Test
    void publish_terminalStatus_pushesFinalEventAndClosesAllSubscribers() {
        service.subscribe(task("RUNNING"));
        service.subscribe(task("RUNNING"));
        assertEquals(2, service.subscriberCount("t1"));

        when(taskRepository.findById("t1")).thenReturn(Optional.of(task("FAILED")));
        service.publish("t1");

        assertEquals(0, service.subscriberCount("t1"), "终态事件推送后应关闭并移除全部订阅");
    }

    @Test
    void publish_noSubscribers_doesNotTouchRepository() {
        service.publish("t1");

        verifyNoInteractions(taskRepository);
    }

    @Test
    void heartbeat_nonTerminalKeepsStream_terminalCompletesAsFallback() {
        ScheduleTask running = task("RUNNING");
        ScheduleTask failed = task("FAILED");
        when(taskRepository.findById("t1"))
                .thenReturn(Optional.of(running), Optional.of(failed));
        service.subscribe(task("RUNNING"));

        service.heartbeat();
        assertEquals(1, service.subscriberCount("t1"), "非终态心跳不关流");

        service.heartbeat();
        assertEquals(0, service.subscriberCount("t1"), "心跳发现终态应补发并关流");
    }

    @Test
    void heartbeat_taskDeleted_completesSubscribers() {
        service.subscribe(task("RUNNING"));
        when(taskRepository.findById("t1")).thenReturn(Optional.empty());

        service.heartbeat();

        assertEquals(0, service.subscriberCount("t1"));
    }
}
