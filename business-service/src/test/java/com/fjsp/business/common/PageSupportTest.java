package com.fjsp.business.common;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class PageSupportTest {

    @Test
    void defaults_appliedWhenNull() {
        var pageable = PageSupport.of(null, null);
        assertEquals(0, pageable.getPageNumber());
        assertEquals(PageSupport.DEFAULT_SIZE, pageable.getPageSize());
    }

    @Test
    void explicitValues() {
        var pageable = PageSupport.of(2, 50, PageSupport.DEFAULT_MAX_SIZE,
                org.springframework.data.domain.Sort.by("createdAt"));
        assertEquals(2, pageable.getPageNumber());
        assertEquals(50, pageable.getPageSize());
    }

    @Test
    void negativePage_rejected() {
        BizException e = assertThrows(BizException.class, () -> PageSupport.of(-1, 20));
        assertEquals("E_VALIDATION", e.getCode());
    }

    @Test
    void sizeZero_rejected() {
        BizException e = assertThrows(BizException.class, () -> PageSupport.of(0, 0));
        assertEquals("E_VALIDATION", e.getCode());
    }

    @Test
    void sizeAboveMax_rejected() {
        BizException e = assertThrows(BizException.class,
                () -> PageSupport.of(0, 201, 200, org.springframework.data.domain.Sort.unsorted()));
        assertEquals("E_VALIDATION", e.getCode());
    }

    @Test
    void bulkMax_allowsLargeSize() {
        var pageable = PageSupport.of(0, 5000, PageSupport.BULK_MAX_SIZE,
                org.springframework.data.domain.Sort.unsorted());
        assertEquals(5000, pageable.getPageSize());
    }
}
