package com.fjsp.business.config;

import io.swagger.v3.oas.models.OpenAPI;
import io.swagger.v3.oas.models.info.Info;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * OpenAPI 元数据；接口清单由 springdoc 自动扫描生成，
 * 文档路径 /v3/api-docs，UI 路径 /swagger-ui/index.html（SecurityConfig 已放行）。
 */
@Configuration
public class OpenApiConfig {

    @Bean
    public OpenAPI fjspOpenAPI() {
        return new OpenAPI().info(new Info()
                .title("FJSP 业务服务 API")
                .description("动态柔性车间生产调度与仿真决策系统 - 业务服务")
                .version("v1"));
    }
}
