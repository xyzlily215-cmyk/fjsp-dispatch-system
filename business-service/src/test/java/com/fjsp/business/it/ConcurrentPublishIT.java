package com.fjsp.business.it;

import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import com.fjsp.business.common.BizException;
import com.fjsp.business.dto.PublishRequest;
import com.fjsp.business.entity.PlanVersion;
import com.fjsp.business.repository.PlanVersionRepository;
import com.fjsp.business.service.PlanStateMachine;
import com.fjsp.business.service.PlanVersionService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 场景 12（并发发布）真实 DB 版：两个 REVIEWED 候选同时发布，恰好一个成功。 */
class ConcurrentPublishIT extends AbstractPostgresIT {

    @Autowired
    private PlanVersionService planVersionService;
    @Autowired
    private PlanVersionRepository planVersionRepository;

    @AfterEach
    void cleanup() {
        planVersionRepository.deleteAll();
    }

    private PlanVersion saveVersion(String code, String status, String parentId) {
        PlanVersion pv = new PlanVersion();
        pv.setId(UUID.randomUUID().toString());
        pv.setVersionCode(code);
        pv.setCandidateType("LOCAL");
        pv.setStatus(status);
        pv.setParentId(parentId);
        return planVersionRepository.saveAndFlush(pv);
    }

    @Test
    void concurrentPublish_exactlyOneWins() throws Exception {
        PlanVersion parent = saveVersion("PV-IT-BASE", PlanStateMachine.PUBLISHED, null);
        PlanVersion candA = saveVersion("PV-IT-A", PlanStateMachine.REVIEWED, parent.getId());
        PlanVersion candB = saveVersion("PV-IT-B", PlanStateMachine.REVIEWED, parent.getId());

        CountDownLatch ready = new CountDownLatch(2);
        CountDownLatch go = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        Future<String> fa = pool.submit(() -> publishOne(candA.getId(), ready, go));
        Future<String> fb = pool.submit(() -> publishOne(candB.getId(), ready, go));
        assertTrue(ready.await(10, java.util.concurrent.TimeUnit.SECONDS));
        go.countDown();
        String ra = fa.get(30, java.util.concurrent.TimeUnit.SECONDS);
        String rb = fb.get(30, java.util.concurrent.TimeUnit.SECONDS);
        pool.shutdown();

        assertTrue(List.of(ra, rb).contains("OK"), "应有一个发布成功: " + ra + "/" + rb);
        String loser = ra.equals("OK") ? rb : ra;
        assertTrue(loser.startsWith("E_PLAN_STALE") || loser.startsWith("E_VERSION_STALE"),
                "败者应得到过期冲突: " + loser);

        PlanVersion a = planVersionRepository.findById(candA.getId()).orElseThrow();
        PlanVersion b = planVersionRepository.findById(candB.getId()).orElseThrow();
        PlanVersion p = planVersionRepository.findById(parent.getId()).orElseThrow();
        assertEquals(1, List.of(a, b).stream().filter(v -> PlanStateMachine.PUBLISHED.equals(v.getStatus())).count(),
                "恰好一个 PUBLISHED");
        assertEquals(PlanStateMachine.SUPERSEDED, p.getStatus(), "基准版本应被取代");
    }

    private String publishOne(String id, CountDownLatch ready, CountDownLatch go) {
        try {
            ready.countDown();
            go.await();
            planVersionService.publish(id, new PublishRequest(0L));
            return "OK";
        } catch (BizException e) {
            return e.getCode();
        } catch (Exception e) {
            // 乐观锁冲突经 GlobalExceptionHandler 才是 E_VERSION_STALE；服务层直抛时取异常语义
            if (e instanceof org.springframework.orm.ObjectOptimisticLockingFailureException) {
                return "E_VERSION_STALE";
            }
            return e.getClass().getSimpleName();
        }
    }
}
