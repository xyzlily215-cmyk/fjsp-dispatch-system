package com.fjsp.business.it;

import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

import com.fjsp.business.entity.ScheduleTask;
import com.fjsp.business.repository.ScheduleTaskRepository;
import com.fjsp.business.service.ScheduleTaskCommandService;
import com.fjsp.business.service.ScheduleTaskStateService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class TaskCancellationRaceIT extends AbstractPostgresIT {

    @Autowired
    private ScheduleTaskRepository taskRepository;
    @Autowired
    private ScheduleTaskCommandService commandService;
    @Autowired
    private ScheduleTaskStateService stateService;
    @Autowired
    private PlatformTransactionManager transactionManager;

    @AfterEach
    void cleanup() {
        taskRepository.deleteAll();
    }

    @Test
    void dispatchWaitsForCancellationCommitAndDoesNotReviveTask() throws Exception {
        ScheduleTask task = new ScheduleTask();
        task.setId(UUID.randomUUID().toString());
        task.setTaskCode("TSK-RACE-" + UUID.randomUUID());
        task.setMode("BASELINE");
        taskRepository.saveAndFlush(task);

        CountDownLatch cancelledUnderLock = new CountDownLatch(1);
        CountDownLatch releaseCancellation = new CountDownLatch(1);
        var pool = Executors.newFixedThreadPool(2);
        try {
            var cancellation = pool.submit(() -> new TransactionTemplate(transactionManager).execute(tx -> {
                commandService.cancelTask(task.getId());
                cancelledUnderLock.countDown();
                try {
                    if (!releaseCancellation.await(10, TimeUnit.SECONDS)) {
                        throw new IllegalStateException("cancellation commit timed out");
                    }
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException(e);
                }
                return null;
            }));
            assertTrue(cancelledUnderLock.await(10, TimeUnit.SECONDS));
            CountDownLatch dispatchStarted = new CountDownLatch(1);
            var dispatch = pool.submit(() -> {
                dispatchStarted.countDown();
                return stateService.markRunning(task.getId());
            });
            assertTrue(dispatchStarted.await(10, TimeUnit.SECONDS));
            assertThrows(TimeoutException.class, () -> dispatch.get(200, TimeUnit.MILLISECONDS));

            releaseCancellation.countDown();
            cancellation.get(10, TimeUnit.SECONDS);
            assertFalse(dispatch.get(10, TimeUnit.SECONDS));
            assertEquals("CANCELLED", taskRepository.findById(task.getId()).orElseThrow().getStatus());
        } finally {
            releaseCancellation.countDown();
            pool.shutdownNow();
        }
    }
}
