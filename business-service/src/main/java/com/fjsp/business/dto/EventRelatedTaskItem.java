package com.fjsp.business.dto;

/** 事件关联任务摘要（事件详情内嵌）。 */
public record EventRelatedTaskItem(String taskId, String taskCode, String mode, String status) {
}
