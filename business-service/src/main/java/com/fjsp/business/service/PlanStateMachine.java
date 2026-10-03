package com.fjsp.business.service;

import java.util.List;
import java.util.Map;

import com.fjsp.business.common.BizException;
import org.springframework.stereotype.Component;

@Component
public class PlanStateMachine {

    public static final String DRAFT = "DRAFT";
    public static final String REVIEW_PENDING = "REVIEW_PENDING";
    public static final String REVIEWED = "REVIEWED";
    public static final String REJECTED = "REJECTED";
    public static final String PUBLISHED = "PUBLISHED";
    public static final String EXECUTING = "EXECUTING";
    public static final String SUPERSEDED = "SUPERSEDED";

    private static final Map<String, List<String>> ALLOWED = Map.of(
            DRAFT, List.of(REVIEW_PENDING),
            REVIEW_PENDING, List.of(REVIEWED, REJECTED),
            REVIEWED, List.of(PUBLISHED),
            PUBLISHED, List.of(EXECUTING, SUPERSEDED),
            EXECUTING, List.of(SUPERSEDED),
            REJECTED, List.of(DRAFT));

    public void assertTransition(String from, String to) {
        if (!ALLOWED.getOrDefault(from, List.of()).contains(to)) {
            throw BizException.stateConflict(
                    "计划版本状态不允许从 " + from + " 变更为 " + to + "，请刷新后确认当前状态");
        }
    }
}
