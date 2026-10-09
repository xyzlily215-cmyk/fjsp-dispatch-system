package com.fjsp.business.service;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

class TaskRetryPolicyTest {

    @Test
    void backoff_doublesFromThirtySeconds() {
        assertEquals(30, TaskRetryPolicy.backoffSeconds(1));
        assertEquals(60, TaskRetryPolicy.backoffSeconds(2));
        assertEquals(120, TaskRetryPolicy.backoffSeconds(3));
        assertEquals(240, TaskRetryPolicy.backoffSeconds(4));
        assertEquals(480, TaskRetryPolicy.backoffSeconds(5));
    }

    @Test
    void backoff_capsAtSixHundredSeconds() {
        assertEquals(600, TaskRetryPolicy.backoffSeconds(6));
        assertEquals(600, TaskRetryPolicy.backoffSeconds(10));
        assertEquals(600, TaskRetryPolicy.backoffSeconds(100));
    }

    @Test
    void backoff_firstAndNonPositiveTreatedAsBase() {
        assertEquals(30, TaskRetryPolicy.backoffSeconds(0));
    }
}
