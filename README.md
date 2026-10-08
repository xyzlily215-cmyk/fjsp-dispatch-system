# 动态柔性车间生产调度与仿真决策系统

这是本科毕业设计项目「动态柔性车间生产调度与仿真决策系统」，包含：

- `algorithm-service/`：Python/FastAPI 调度算法服务；
- `business-service/`：Java/Spring Boot 业务服务，负责数据、事件、计划版本、审核发布和执行反馈；
- `web/`：前端演示页面；
- `agh-integration/`：Agnes Harness（AGH）工具和技能集成；
- `deploy/`：PostgreSQL 基础设施配置（Redis 预留未启用，未来引入缓存/队列时再加回 compose）；
- `scripts/`：本地一键启动、重置、测试和证据采集脚本。

## 快速启动

> 本地演示会启动或复用 PostgreSQL、算法服务、业务服务和前端服务。脚本不会删除数据库卷；`start-demo.sh` 也不会自动重置业务数据。业务服务默认以 `local` profile 运行。

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

不经脚本单独操作 PostgreSQL 的 Compose 配置时，需显式指定 env 文件（`deploy/docker-compose.yml` 中数据库名/用户/密码为 `:?` 必填变量，缺失会直接报错；端口仅绑定到 127.0.0.1）：

```bash
docker compose --env-file .env -f deploy/docker-compose.yml up -d
```

## 验证与证据

```bash
# 清空并重新导入演示数据；会修改演示数据库中的业务数据
./scripts/reset-demo.sh

# 业务全流程冒烟测试
./scripts/run-smoke-test.sh

# ⚠️ 前端依赖的 API 字段契约检查；会先调用 POST /demo/reset 清空并重建演示数据，
#    请勿在含手工录入数据的环境运行
./scripts/run-e2e.sh

# 核心 SQL 性能基线：对关键查询跑 EXPLAIN ANALYZE，输出扫描方式与耗时，用于对比索引生效前后
./scripts/perf-baseline.sh

# 基础数据写接口冒烟（正例 + 负例校验）
bash web/scripts/crud-check.sh

# 前端（8082）跨域访问业务服务（8081）的 CORS 检查
bash web/scripts/ui-check.sh

# 采集健康检查、核心接口和服务头信息；默认输出到 /tmp
./scripts/collect-evidence.sh
```

停止本批次脚本启动的进程并停止 Compose 容器（保留数据卷）：

```bash
./scripts/stop-demo.sh
```

## 认证与账号

业务服务已启用 Spring Security + JWT 认证：前端打开后先登录（token 存 localStorage，401 自动退回登录页）；脚本（smoke/e2e/reset/collect-evidence）自动以 `FJSP_AUTH_USER`/`FJSP_AUTH_PASSWORD`（默认 admin）先调 `/api/v1/auth/login` 再访问业务接口。

演示种子账号（**仅本地演示**，密码均为 `Fj@123456`）：

| 用户名 | 角色 | 权限要点 |
|---|---|---|
| dispatcher | DISPATCHER 调度员 | 创建/重试/取消任务、登记事件、提交审核 |
| reviewer | REVIEWER 审核员 | 审核/驳回计划版本、回滚已替代（SUPERSEDED）历史版本 |
| manager | PRODUCTION_MANAGER 生产主管 | 发布计划版本、执行反馈 |
| admin | ADMIN 管理员 | 全部权限（含基础数据维护、demo/reset） |

JWT 密钥走 `FJSP_JWT_SECRET`（见 `.env.example`，不设置时使用仅开发用默认值，有效期默认 8h）。角色-端点完整矩阵见 [`business-service/README.md`](business-service/README.md)。

> ⚠️ 上述种子账号密码与 Flyway V3 迁移写入生产库的初始密码是同一个（`Fj@123456`），生产部署后必须立即改密。`prod` profile 下 `UserSeedRunner` 不再使用内置演示密码：初始账号密码必须经环境变量 `FJSP_SEED_ADMIN_PASSWORD` 提供，缺失则启动失败。登录接口有防爆破保护：同一账号连续失败 5 次锁定 10 分钟，锁定期内返回 429。

## 配置与安全

`POST /api/v1/demo/reset` 由配置项 `fjsp.demo.enabled` 控制（默认 `false`，`application-local.yml` 中显式开启供本地演示与脚本使用，关闭时返回 403）；重置只清空业务表并重新导入种子数据，`audit_log` 审计日志保留。

不要把 `.env`、数据库密码或 AGH API Key 提交到 Git。复制 `.env.example` 后填写本地值；`scripts/check-env.sh` 会拒绝使用示例密码，并且不会打印密码或 API Key。

AGH 的审核发布流程要求显式审批：计划必须先提交审核，审核通过后才能发布；工具不会自动提交审核或自动审批。相关实现和验证证据见 `agh-integration/README.md`。

## 业务服务单独开发

业务服务的接口、数据模型、状态机和测试说明见 [`business-service/README.md`](business-service/README.md)。

## 数据库 schema 管理（Flyway + ddl-auto 分环境）

- 迁移脚本位于 `business-service/src/main/resources/db/migration/`，基线为 `V1__baseline_schema.sql`（17 张业务表）；schema 变更一律新增 `V<n>__*.sql`，不要改动已应用的脚本。
- **本地开发（local profile）**：`scripts/start-demo.sh` 默认以 `SPRING_PROFILES_ACTIVE=local` 启动业务服务，此时 Flyway 关闭、`ddl-auto=update`，由 Hibernate 自动同步表结构。
- **默认 profile（生产姿态）**：Flyway 启用并执行迁移，`ddl-auto=validate` 仅校验实体与库表一致，不再自动改表。存量库首次启动会自动 baseline 到版本 1（`baseline-on-migrate`），全新空库则执行 V1 建表。
- 手动启动时通过环境变量选择：`SPRING_PROFILES_ACTIVE=local java -jar ...` 为本地开发模式；不设该变量即为生产姿态。`prod` profile 下所有连接与密钥强制来自环境变量（无默认值，缺失即启动失败）；`test` profile 预留给 Testcontainers 集成测试。
- 业务服务配置矩阵（配置项/类型/默认值/各 profile 差异/环境变量）见 [`business-service/README.md`](business-service/README.md) 的「配置项」一节。
