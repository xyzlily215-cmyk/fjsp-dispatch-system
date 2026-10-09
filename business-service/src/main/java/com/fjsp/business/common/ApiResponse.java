package com.fjsp.business.common;

import java.time.OffsetDateTime;

public class ApiResponse<T> {

    private String requestId;
    private OffsetDateTime timestamp;
    private String code;
    private String message;
    private T data;

    public ApiResponse() {
    }

    public ApiResponse(String requestId, OffsetDateTime timestamp, String code, String message, T data) {
        this.requestId = requestId;
        this.timestamp = timestamp;
        this.code = code;
        this.message = message;
        this.data = data;
    }

    public static <T> ApiResponse<T> ok(T data) {
        return new ApiResponse<>(RequestContext.requestId(), OffsetDateTime.now(), "OK", "success", data);
    }

    public static <T> ApiResponse<T> error(String code, String message) {
        return new ApiResponse<>(RequestContext.requestId(), OffsetDateTime.now(), code, message, null);
    }

    public String getRequestId() {
        return requestId;
    }

    public void setRequestId(String requestId) {
        this.requestId = requestId;
    }

    public OffsetDateTime getTimestamp() {
        return timestamp;
    }

    public void setTimestamp(OffsetDateTime timestamp) {
        this.timestamp = timestamp;
    }

    public String getCode() {
        return code;
    }

    public void setCode(String code) {
        this.code = code;
    }

    public String getMessage() {
        return message;
    }

    public void setMessage(String message) {
        this.message = message;
    }

    public T getData() {
        return data;
    }

    public void setData(T data) {
        this.data = data;
    }
}
