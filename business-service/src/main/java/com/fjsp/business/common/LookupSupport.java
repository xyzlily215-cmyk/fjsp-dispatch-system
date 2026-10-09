package com.fjsp.business.common;

import java.util.Optional;
import java.util.function.Function;

/**
 * "先按 id 查、查不到按业务编码查"的公共下沉：任务/计划版本/事件等接口
 * 都接受 id 或 code 定位实体，notFound 消息由调用方按实体类型给出。
 */
public final class LookupSupport {

    private LookupSupport() {
    }

    public static <T> T byIdOrCode(String idOrCode,
                                   Function<String, Optional<T>> byId,
                                   Function<String, Optional<T>> byCode,
                                   String notFoundMessage) {
        return byId.apply(idOrCode).or(() -> byCode.apply(idOrCode))
                .orElseThrow(() -> BizException.notFound(notFoundMessage + ": " + idOrCode));
    }
}
