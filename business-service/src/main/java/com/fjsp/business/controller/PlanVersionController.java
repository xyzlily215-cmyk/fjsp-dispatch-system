package com.fjsp.business.controller;

import java.util.List;
import java.util.Map;

import com.fjsp.business.common.ApiResponse;
import com.fjsp.business.common.BizException;
import com.fjsp.business.dto.PublishRequest;
import com.fjsp.business.dto.ReviewRequest;
import com.fjsp.business.dto.SubmitReviewRequest;
import com.fjsp.business.service.PlanVersionService;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/plan-versions")
public class PlanVersionController {

    private final PlanVersionService planVersionService;

    public PlanVersionController(PlanVersionService planVersionService) {
        this.planVersionService = planVersionService;
    }

    @GetMapping
    public ApiResponse<List<Map<String, Object>>> list() {
        return ApiResponse.ok(planVersionService.list());
    }

    @GetMapping("/{id}")
    public ApiResponse<Map<String, Object>> get(@PathVariable String id) {
        return ApiResponse.ok(planVersionService.detail(id));
    }

    @GetMapping("/{id}/diff")
    public ApiResponse<Map<String, Object>> diff(@PathVariable String id,
                                                 @RequestParam String baselineVersionId) {
        return ApiResponse.ok(planVersionService.diff(id, baselineVersionId));
    }

    @PreAuthorize("hasAnyRole('DISPATCHER','ADMIN')")
    @PostMapping("/{id}/submit-review")
    public ApiResponse<Map<String, Object>> submitReview(@PathVariable String id,
                                                         @RequestBody SubmitReviewRequest request) {
        return ApiResponse.ok(planVersionService.submitReview(id, request));
    }

    @PreAuthorize("hasAnyRole('DISPATCHER','ADMIN')")
    @PostMapping("/{id}/revise")
    public ApiResponse<Map<String, Object>> revise(@PathVariable String id,
                                                   @RequestBody SubmitReviewRequest request) {
        return ApiResponse.ok(planVersionService.revise(id, request));
    }

    @PreAuthorize("hasAnyRole('REVIEWER','ADMIN')")
    @PostMapping("/{id}/review")
    public ApiResponse<Map<String, Object>> review(@PathVariable String id,
                                                   @RequestBody ReviewRequest request) {
        if (request == null) {
            throw BizException.validation("请求体必填");
        }
        return ApiResponse.ok(planVersionService.review(id, request));
    }

    @PreAuthorize("hasAnyRole('PRODUCTION_MANAGER','ADMIN')")
    @PostMapping("/{id}/publish")
    public ApiResponse<Map<String, Object>> publish(@PathVariable String id,
                                                    @RequestBody PublishRequest request) {
        return ApiResponse.ok(planVersionService.publish(id, request));
    }
}
