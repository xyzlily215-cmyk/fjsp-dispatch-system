package com.fjsp.business.controller;

import java.util.List;

import com.fjsp.business.common.ApiResponse;
import com.fjsp.business.dto.DashboardResponse;
import com.fjsp.business.dto.MachineResponse;
import com.fjsp.business.dto.OrderListItemResponse;
import com.fjsp.business.dto.OrderPositionResponse;
import com.fjsp.business.dto.ProcessTemplateResponse;
import com.fjsp.business.service.BaseDataQueryService;
import com.fjsp.business.service.DashboardService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1")
public class BaseDataController {

    private final BaseDataQueryService baseDataQueryService;
    private final DashboardService dashboardService;

    public BaseDataController(BaseDataQueryService baseDataQueryService,
                              DashboardService dashboardService) {
        this.baseDataQueryService = baseDataQueryService;
        this.dashboardService = dashboardService;
    }

    @GetMapping("/machines")
    public ApiResponse<List<MachineResponse>> machines() {
        return ApiResponse.ok(baseDataQueryService.listMachines());
    }

    @GetMapping("/orders")
    public ApiResponse<List<OrderListItemResponse>> orders() {
        return ApiResponse.ok(baseDataQueryService.listOrders());
    }

    /**
     * 订单加工位置聚合：当前在哪台设备加工、还剩几道工序（orderRef 支持订单 id 或 orderCode）。
     */
    @GetMapping("/orders/{orderRef}/position")
    public ApiResponse<OrderPositionResponse> orderPosition(@PathVariable String orderRef) {
        return ApiResponse.ok(baseDataQueryService.orderPosition(orderRef));
    }

    @GetMapping("/process-templates")
    public ApiResponse<List<ProcessTemplateResponse>> processTemplates() {
        return ApiResponse.ok(baseDataQueryService.listProcessTemplates());
    }

    /**
     * F-01 看板聚合：planVersionId（id 或 versionCode，缺省取当前发布版本）；
     * window = SHIFT / LAST_24H / CUSTOM（CUSTOM 需 from/to，ISO 8601），过滤事件与异常时间范围。
     */
    @GetMapping("/dashboard")
    public ApiResponse<DashboardResponse> dashboard(
            @RequestParam(required = false) String planVersionId,
            @RequestParam(required = false) String window,
            @RequestParam(required = false) String from,
            @RequestParam(required = false) String to) {
        return ApiResponse.ok(dashboardService.dashboard(planVersionId, window, from, to));
    }
}
