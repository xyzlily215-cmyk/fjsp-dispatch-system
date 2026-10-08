package com.fjsp.business.dto;

import java.time.OffsetDateTime;

/** 事件修订链条目（事件详情内嵌，指向本事件的修订事件）。 */
public record EventRevisionItem(String eventId, String eventCode, String status,
                                String revisionReason, OffsetDateTime recordedAt) {
}
