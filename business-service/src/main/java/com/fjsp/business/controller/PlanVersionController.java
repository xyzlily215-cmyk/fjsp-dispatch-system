package com.fjsp.business.controller;

import com.fjsp.business.common.ApiResponse;
import com.fjsp.business.common.BizException;
import com.fjsp.business.common.PageResponse;
import com.fjsp.business.dto.PlanDiffResponse;
import com.fjsp.business.dto.PlanOperationResponse;
import com.fjsp.business.dto.PlanVersionDetailResponse;
import com.fjsp.business.dto.PlanVersionSummaryResponse;
import com.fjsp.business.dto.PublishRequest;
import com.fjsp.business.dto.ReviewRequest;
import com.fjsp.business.dto.RollbackRequest;
import com.fjsp.business.dto.SubmitReviewRequest;
import com.fjsp.business.service.PlanDiffService;
import com.fjsp.business.service.PlanPublishService;
import com.fjsp.business.service.PlanReviewService;
import com.fjsp.business.service.PlanRollbackService;
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
    private final PlanReviewService planReviewService;
    private final PlanPublishService planPublishService;
    private final PlanRollbackService planRollbackService;
    private final PlanDiffService planDiffService;

    public PlanVersionController(PlanVersionService planVersionService,
                                 PlanReviewService planReviewService,
                                 PlanPublishService planPublishService,
                                 PlanRollbackService planRollbackService,
                                 PlanDiffService planDiffService) {
        this.planVersionService = planVersionService;
        this.planReviewService = planReviewService;
        this.planPublishService = planPublishService;
        this.planRollbackService = planRollbackService;
        this.planDiffService = planDiffService;
    }

    @GetMapping
    public ApiResponse<PageResponse<PlanVersionSummaryResponse>> list(
            @RequestParam(required = false) Integer page,
            @RequestParam(required = false) Integer size) {
        return ApiResponse.ok(planVersionService.list(page, size));
    }

    @GetMapping("/{id}")
    public ApiResponse<PlanVersionDetailResponse> get(@PathVariable String id) {
        return ApiResponse.ok(planVersionService.detail(id));
    }

    @GetMapping("/{id}/operations")
    public ApiResponse<PageResponse<PlanOperationResponse>> operations(
            @PathVariable String id,
            @RequestParam(required = false) Integer page,
            @RequestParam(required = false) Integer size) {
        return ApiResponse.ok(planVersionService.operations(id, page, size));
    }

    @GetMapping("/{id}/diff")
    public ApiResponse<PlanDiffResponse> diff(@PathVariable String id,
                                                 @RequestParam String baselineVersionId) {
        return ApiResponse.ok(planDiffService.diff(id, baselineVersionId));
    }

    @PreAuthorize("hasAnyRole('DISPATCHER','ADMIN')")
    @PostMapping("/{id}/submit-review")
    public ApiResponse<PlanVersionSummaryResponse> submitReview(@PathVariable String id,
                                                         @RequestBody SubmitReviewRequest request) {
        return ApiResponse.ok(planReviewService.submitReview(id, request));
    }

    @PreAuthorize("hasAnyRole('DISPATCHER','ADMIN')")
    @PostMapping("/{id}/revise")
    public ApiResponse<PlanVersionSummaryResponse> revise(@PathVariable String id,
                                                   @RequestBody SubmitReviewRequest request) {
        return ApiResponse.ok(planReviewService.revise(id, request));
    }

    @PreAuthorize("hasAnyRole('REVIEWER','ADMIN')")
    @PostMapping("/{id}/review")
    public ApiResponse<PlanVersionSummaryResponse> review(@PathVariable String id,
                                                   @RequestBody ReviewRequest request) {
        if (request == null) {
            throw BizException.validation("请求体必填");
        }
        return ApiResponse.ok(planReviewService.review(id, request));
    }

    @PreAuthorize("hasAnyRole('PRODUCTION_MANAGER','ADMIN')")
    @PostMapping("/{id}/publish")
    public ApiResponse<PlanVersionSummaryResponse> publish(@PathVariable String id,
                                                    @RequestBody PublishRequest request) {
        return ApiResponse.ok(planPublishService.publish(id, request));
    }

    @PreAuthorize("hasAnyRole('REVIEWER','ADMIN')")
    @PostMapping("/{id}/rollback")
    public ApiResponse<PlanVersionSummaryResponse> rollback(@PathVariable String id,
                                                     @RequestBody RollbackRequest request) {
        return ApiResponse.ok(planRollbackService.rollback(id, request));
    }
}
