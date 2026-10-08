package com.fjsp.business.common;

import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;

/** 分页参数解析与校验：page 从 0 开始，size 1..maxSize，非法参数 400。 */
public final class PageSupport {

    public static final int DEFAULT_SIZE = 20;
    public static final int DEFAULT_MAX_SIZE = 200;
    /** 计划工序等需要一次取全量的端点放宽上限。 */
    public static final int BULK_MAX_SIZE = 5000;

    private PageSupport() {
    }

    public static PageRequest of(Integer page, Integer size) {
        return of(page, size, DEFAULT_MAX_SIZE, Sort.unsorted());
    }

    public static PageRequest of(Integer page, Integer size, int maxSize, Sort sort) {
        int p = page == null ? 0 : page;
        int s = size == null ? DEFAULT_SIZE : size;
        if (p < 0) {
            throw BizException.validation("page 必须 >= 0");
        }
        if (s < 1 || s > maxSize) {
            throw BizException.validation("size 必须在 1-" + maxSize + " 之间");
        }
        return PageRequest.of(p, s, sort);
    }
}
