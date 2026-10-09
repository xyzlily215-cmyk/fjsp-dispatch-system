package com.fjsp.business.it;

import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.testcontainers.containers.PostgreSQLContainer;

/**
 * 集成测试基类：真实 PostgreSQL（Testcontainers 独立容器，全 IT 类共享单例），
 * Flyway 真实执行全部迁移（V1-V13）+ Hibernate validate（test profile）。
 * 需要本机 Docker 且 postgres:16 镜像已在本地；容器随 JVM 退出由 shutdown hook 销毁。
 *
 * 注意：不能用 @Testcontainers + static @Container——该模式下容器在每个测试类
 * 结束后停止、下个类重启并更换端口，而 Spring 上下文缓存中的数据源仍指向旧端口。
 */
@SpringBootTest
@ActiveProfiles("test")
public abstract class AbstractPostgresIT {

    @ServiceConnection
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>("postgres:16");

    static {
        POSTGRES.start();
    }
}
