package com.fjsp.business.common;

import com.fjsp.business.entity.PlanVersion;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.orm.ObjectOptimisticLockingFailureException;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

class GlobalExceptionHandlerTest {

    private final GlobalExceptionHandler handler = new GlobalExceptionHandler();

    @Test
    void bizException_validation_mapsTo400() {
        ResponseEntity<ApiResponse<Void>> response = handler.handleBiz(BizException.validation("参数错误"));
        assertEquals(HttpStatus.BAD_REQUEST, response.getStatusCode());
        assertEquals("E_VALIDATION", response.getBody().getCode());
    }

    @Test
    void bizException_duplicate_mapsTo409() {
        ResponseEntity<ApiResponse<Void>> response = handler.handleBiz(BizException.duplicate("重复提交"));
        assertEquals(HttpStatus.CONFLICT, response.getStatusCode());
        assertEquals("E_DUPLICATE", response.getBody().getCode());
    }

    @Test
    void bizException_stateConflict_mapsTo409() {
        ResponseEntity<ApiResponse<Void>> response = handler.handleBiz(BizException.stateConflict("状态不允许"));
        assertEquals(HttpStatus.CONFLICT, response.getStatusCode());
        assertEquals("E_STATE_CONFLICT", response.getBody().getCode());
    }

    @Test
    void bizException_eventInProcess_mapsTo409() {
        ResponseEntity<ApiResponse<Void>> response = handler.handleBiz(BizException.eventInProcess("工序执行中"));
        assertEquals(HttpStatus.CONFLICT, response.getStatusCode());
        assertEquals("E_EVENT_IN_PROCESS", response.getBody().getCode());
    }

    @Test
    void bizException_infeasible_mapsTo422() {
        ResponseEntity<ApiResponse<Void>> response = handler.handleBiz(BizException.infeasible("不可行"));
        assertEquals(HttpStatus.UNPROCESSABLE_ENTITY, response.getStatusCode());
        assertEquals("E_INFEASIBLE", response.getBody().getCode());
    }

    @Test
    void bizException_notFound_mapsTo404() {
        ResponseEntity<ApiResponse<Void>> response = handler.handleBiz(BizException.notFound("不存在"));
        assertEquals(HttpStatus.NOT_FOUND, response.getStatusCode());
        assertEquals("E_NOT_FOUND", response.getBody().getCode());
    }

    @Test
    void optimisticLock_mapsTo409VersionStale() {
        // 并发发布的最终对外语义：409 + E_VERSION_STALE
        ResponseEntity<ApiResponse<Void>> response = handler.handleOptimisticLock(
                new ObjectOptimisticLockingFailureException(PlanVersion.class, "P1"));
        assertEquals(HttpStatus.CONFLICT, response.getStatusCode());
        assertEquals("E_VERSION_STALE", response.getBody().getCode());
    }

    @Test
    void dataIntegrity_mapsTo409Duplicate() {
        // fingerprint 唯一约束兜底：409 + E_DUPLICATE
        ResponseEntity<ApiResponse<Void>> response = handler.handleDataIntegrity(
                new DataIntegrityViolationException("duplicate key value violates unique constraint"));
        assertEquals(HttpStatus.CONFLICT, response.getStatusCode());
        assertEquals("E_DUPLICATE", response.getBody().getCode());
    }

    @Test
    void illegalArgument_mapsTo400() {
        ResponseEntity<ApiResponse<Void>> response = handler.handleBadRequest(
                new IllegalArgumentException("bad"));
        assertEquals(HttpStatus.BAD_REQUEST, response.getStatusCode());
        assertEquals("E_VALIDATION", response.getBody().getCode());
    }

    @Test
    void unhandled_mapsTo500() {
        ResponseEntity<ApiResponse<Void>> response = handler.handleOther(new RuntimeException("boom"));
        assertEquals(HttpStatus.INTERNAL_SERVER_ERROR, response.getStatusCode());
        assertEquals("E_INTERNAL", response.getBody().getCode());
        assertNotNull(response.getBody().getMessage());
    }
}
