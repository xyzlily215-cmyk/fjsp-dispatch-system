# 动态柔性车间生产调度与仿真决策系统

这是一个面向比赛演示的动态柔性车间生产调度与仿真决策系统，包含：

- `algorithm-service/`：Python/FastAPI 调度算法服务；
- `business-service/`：Java/Spring Boot 业务服务，负责数据、事件、计划版本、审核发布和执行反馈；
- `web/`：前端演示页面；
- `agh-integration/`：Agnes Harness（AGH）工具和技能集成；
- `deploy/`：PostgreSQL、Redis 等基础设施配置；
- `scripts/`：本地一键启动、重置、测试和证据采集脚本。

## 快速启动

> 本地演示会启动或复用 PostgreSQL、Redis、算法服务、业务服务和前端服务。脚本不会删除数据库卷；`start-demo.sh` 也不会自动重置业务数据。

```bash
cp .env.example .env
# 编辑 .env，至少把 FJSP_DB_PASSWORD 改成当前本地数据库使用的密码
./scripts/start-demo.sh
```

默认入口：

- 前端：<http://127.0.0.1:8082/index.html?api=http://localhost:8081/api/v1>
- 业务 API：<http://localhost:8081/api/v1>
- 算法健康检查：<http://localhost:8101/health>
- AGH 工作台：<http://localhost:4177/>

如果只需要业务服务和前端，不启动 AGH：

```bash
FJSP_START_AGH=0 ./scripts/start-demo.sh
```

## 验证与证据

```bash
# 清空并重新导入演示数据；会修改演示数据库中的业务数据
./scripts/reset-demo.sh

# 业务全流程冒烟测试
./scripts/run-smoke-test.sh

# 前端依赖的 API 字段契约检查
./scripts/run-e2e.sh

# 采集健康检查、核心接口和服务头信息；默认输出到 /tmp
./scripts/collect-evidence.sh
```

停止本批次脚本启动的进程并停止 Compose 容器（保留数据卷）：

```bash
./scripts/stop-demo.sh
```

## 配置与安全

不要把 `.env`、数据库密码或 AGH API Key 提交到 Git。复制 `.env.example` 后填写本地值；`scripts/check-env.sh` 会拒绝使用示例密码，并且不会打印密码或 API Key。

AGH 的审核发布流程要求显式审批：计划必须先提交审核，审核通过后才能发布；工具不会自动提交审核或自动审批。相关实现和验证证据见 `agh-integration/README.md`。

## 业务服务单独开发

业务服务的接口、数据模型、状态机和测试说明见 [`business-service/README.md`](business-service/README.md)。

## 数据库 schema 管理（Flyway + ddl-auto 分环境）

- 迁移脚本位于 `business-service/src/main/resources/db/migration/`，基线为 `V1__baseline_schema.sql`（17 张业务表）；schema 变更一律新增 `V<n>__*.sql`，不要改动已应用的脚本。
- **本地开发（dev profile）**：`scripts/start-demo.sh` 默认以 `SPRING_PROFILES_ACTIVE=dev` 启动业务服务，此时 Flyway 关闭、`ddl-auto=update`，由 Hibernate 自动同步表结构。
- **默认 profile（生产姿态）**：Flyway 启用并执行迁移，`ddl-auto=validate` 仅校验实体与库表一致，不再自动改表。存量库首次启动会自动 baseline 到版本 1（`baseline-on-migrate`），全新空库则执行 V1 建表。
- 手动启动时通过环境变量选择：`SPRING_PROFILES_ACTIVE=dev java -jar ...` 为开发模式；不设该变量即为生产姿态。
