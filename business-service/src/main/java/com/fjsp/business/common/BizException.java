package com.fjsp.business.common;

import org.springframework.http.HttpStatus;

public class BizException extends RuntimeException {

    private final String code;
    private final HttpStatus status;

    public BizException(String code, String message) {
        this(code, message, HttpStatus.BAD_REQUEST);
    }

    public BizException(String code, String message, HttpStatus status) {
        super(message);
        this.code = code;
        this.status = status;
    }

    public static BizException validation(String message) {
        return new BizException("E_VALIDATION", message);
    }

    public static BizException duplicate(String message) {
        return new BizException("E_DUPLICATE", message, HttpStatus.CONFLICT);
    }

    public static BizException notFound(String message) {
        return new BizException("E_NOT_FOUND", message, HttpStatus.NOT_FOUND);
    }

    public static BizException versionStale(String message) {
        return new BizException("E_VERSION_STALE", message, HttpStatus.CONFLICT);
    }

    public static BizException eventInProcess(String message) {
        return new BizException("E_EVENT_IN_PROCESS", message, HttpStatus.CONFLICT);
    }

    public static BizException infeasible(String message) {
        return new BizException("E_INFEASIBLE", message, HttpStatus.UNPROCESSABLE_ENTITY);
    }

    public static BizException stateConflict(String message) {
        return new BizException("E_STATE_CONFLICT", message, HttpStatus.CONFLICT);
    }

    public static final String CODE_INTEGRITY_VIOLATION = "E_INTEGRITY_VIOLATION";

    public static BizException integrityViolation(String message) {
        return new BizException(CODE_INTEGRITY_VIOLATION, message, HttpStatus.CONFLICT);
    }

    public static BizException planStale(String message) {
        return new BizException("E_PLAN_STALE", message, HttpStatus.CONFLICT);
    }

    public String getCode() {
        return code;
    }

    public HttpStatus getStatus() {
        return status;
    }
}
