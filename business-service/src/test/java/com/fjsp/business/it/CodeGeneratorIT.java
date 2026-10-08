package com.fjsp.business.it;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import com.fjsp.business.service.CodeGenerator;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 编号序列的真实回归：V7 序列并发取号唯一、6 位定宽、前缀隔离。 */
class CodeGeneratorIT extends AbstractPostgresIT {

    @Autowired
    private CodeGenerator codeGenerator;

    @Test
    void next_concurrentCalls_allUniqueAndFixedWidth() throws Exception {
        int n = 16;
        ExecutorService pool = Executors.newFixedThreadPool(8);
        try {
            List<Future<String>> futures = new ArrayList<>();
            for (int i = 0; i < n; i++) {
                futures.add(pool.submit(() -> codeGenerator.next("TSK")));
            }
            Set<String> codes = new HashSet<>();
            for (Future<String> f : futures) {
                codes.add(f.get());
            }
            assertEquals(n, codes.size(), "并发取号必须全局唯一: " + codes);
            assertTrue(codes.stream().allMatch(c -> c.matches("TSK-\\d{6}")),
                    "编号必须 6 位定宽: " + codes);
        } finally {
            pool.shutdown();
        }
    }

    @Test
    void next_eachPrefix_usesIndependentSequence() {
        assertTrue(codeGenerator.next("PV").startsWith("PV-"));
        assertTrue(codeGenerator.next("EVT").startsWith("EVT-"));
        assertTrue(codeGenerator.next("TSK").startsWith("TSK-"));
    }

    @Test
    void next_unknownPrefix_rejected() {
        assertThrows(IllegalArgumentException.class, () -> codeGenerator.next("XXX"));
    }
}
