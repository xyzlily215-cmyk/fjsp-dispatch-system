# FJSP 动态调度系统 — 业务服务

动态柔性车间生产调度与仿真决策系统的业务服务：数据持久化、事件登记、影响集合计算、任务编排、计划版本与审核发布、执行反馈。算法求解由独立的算法服务（Python/FastAPI）完成，本服务通过 HTTP 调用并复核结果。

## 技术栈

- Java 17、Spring Boot 3.3.5、Spring Data JPA + Flyway（local profile 下 ddl-auto=update，默认 profile 下 validate）
- PostgreSQL 16（jsonb 快照字段）、RestClient（算法服务通信，超时 620s）
- 演示规模：20 订单 / 8 设备 / 3 产品族工艺模板

## 启动步骤

### 1. 基础设施

```bash
# PostgreSQL（已容器化则跳过）
# 先在项目根目录创建本地环境文件：cp .env.example .env
set -a; source ../.env; set +a
docker run -d --name fjsp-postgres -p "${FJSP_DB_PORT:-5432}:5432" \
  -e POSTGRES_DB="${FJSP_DB_NAME}" \
  -e POSTGRES_USER="${FJSP_DB_USER}" \
  -e POSTGRES_PASSWORD="${FJSP_DB_PASSWORD}" postgres:16
```

### 2. 算法服务

```bash
cd ../algorithm-service
python3 -m uvicorn app.api:app --port 8101
```

> 若 8101 被占用，改用其他端口并通过 `fjsp.algorithm.base-url` 指向它。

### 3. 业务服务

业务服务必须通过环境变量读取数据库密码。若使用项目根目录的 `.env`：

```bash
cd business-service
set -a; source ../.env; set +a
SPRING_PROFILES_ACTIVE=local mvn spring-boot:run          # 或 mvn -DskipTests package && SPRING_PROFILES_ACTIVE=local java -jar target/business-service-1.0.0.jar
```

> **Profile 与 schema 管理**：本地开发使用 `local` profile——Flyway 关闭、`ddl-auto=update`，Hibernate 自动同步表结构；不设 `SPRING_PROFILES_ACTIVE` 时为默认（生产姿态）——Flyway 执行 `src/main/resources/db/migration/` 下的迁移脚本（基线 `V1__baseline_schema.sql`），`ddl-auto=validate` 仅做一致性校验。存量库首次以默认 profile 启动会自动 baseline 到版本 1；schema 变更请新增 `V<n>__*.sql` 迁移脚本。`scripts/start-demo.sh` 已默认带上 local profile。
>
> **三个命名 profile**：`local`（本地开发，含 dev-only 密钥与 CORS localhost 白名单）、`test`（集成测试，datasource 由 Testcontainers 注入）、`prod`（所有连接与密钥强制环境变量，无默认值，缺失即启动失败）。默认（不带 profile）即生产姿态。

默认端口 **8081**（本机 8080 被其他应用占用；修改 `src/main/resources/application.yml` 的 `server.port` 可调整）。
首次启动时若 `machine` 表为空，自动从 `src/main/resources/seed/demo_instance.json` 导入：
8 台设备（含每台设备的日历可用区间）、3 个产品族工艺模板（按订单工序结构反推合并）、20 个订单（76 道工序，状态 WAITING）。

### 4. 验证

```bash
curl http://localhost:8081/api/v1/machines        # 应返回 8 台设备
./scripts/smoke-test.sh                            # 全流程冒烟测试
```

## 测试矩阵

`mvn test` 一次运行全部测试：Mockito 单元测试 + `@WebMvcTest` 安全矩阵 + Testcontainers 集成测试（`*IT`，真实 PostgreSQL 容器，Flyway 真实执行 V1-V4）。

> 前提：本机 Docker 可用，且 postgres:16 镜像已在本地（Testcontainers 无法访问 Docker Hub 时无法拉取）。本仓库在 `src/test/resources/docker-java.properties` 固定 docker-java API 版本（Docker Desktop 最低支持 1.40，docker-java 默认 1.24），并在 surefire 配置中禁用 Ryuk（适配无法访问 Docker Hub 的环境，JVM 退出时 shutdown hook 仍会清理容器）。

评审 15 个集成场景的覆盖对照：

| # | 场景 | 覆盖位置 |
|---|---|---|
| 1-5 | 创建事件 → 影响计算 → 生成任务 → 生成计划 → 提交审核 | smoke-test.sh §2-6、e2e-api-check.mjs §4-9 |
| 6-8 | 驳回并修订 → 再提交 → 审核通过 | smoke-test.sh §15-17 |
| 9-11 | 发布计划 → 执行反馈 → 事件触发重调度 | smoke-test.sh §4-8、e2e §7-10 |
| 12 | 并发发布同一计划 | smoke-test.sh §9（API 层）、`ConcurrentPublishIT`（真实 DB 乐观锁） |
| 13 | 幂等键重复请求 | smoke-test.sh §2b/2c、`TransactionRollbackIT`（唯一约束真实生效） |
| 14 | 事务中途失败回滚 | `TransactionRollbackIT` |
| 15 | 服务重启后任务恢复 | `TaskRecoveryIT`（真实库残留 RUNNING 转重试、PENDING 重投递） |

另有 `FlywaySchemaIT`（迁移脚本与实体映射回归：4 条迁移全 success、18 张表、V4 索引存在）和 `JsonbMappingIT`（jsonb 读写往返、分页 total 正确性）。

## 配置项（FjspProperties，@Validated 启动校验）

默认值的唯一来源是 `config/FjspProperties.java` 的字段初始值；YAML 只做覆盖。Duration 类型支持 `30s`/`15m`/`8h` 写法。

| 配置 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `server.port` | int | 8081 | 服务端口 |
| `spring.datasource.url/username/password` | string | `${FJSP_DB_HOST:localhost}` 等；密码无默认 | prod profile 下全部无默认值，缺失即失败 |
| `spring.jpa.hibernate.ddl-auto` | enum | `validate`（local 为 `update`） | 默认仅校验 schema，本地开发自动同步 |
| `spring.flyway.enabled` | bool | `true`（local 为 `false`） | 默认由 Flyway 管理 schema，迁移脚本在 `db/migration/` |
| `fjsp.simulation.mode` | `RELATIVE`/`FIXED` | `RELATIVE` | RELATIVE：seed 基准=当前时间，任务默认起点=种子订单最小到达时间；FIXED：seed json `simulationStartAt` 优先，其次 `fjsp.simulation.start-at` |
| `fjsp.simulation.start-at` | ISO datetime | 空 | 仅 FIXED 模式兜底；缺失时报明确错误 |
| `fjsp.algorithm.base-url` | string | `${FJSP_ALGORITHM_BASE_URL:http://localhost:8101}` | 算法服务地址 |
| `fjsp.algorithm.timeout` | Duration | 620s | /solve、/validate 读超时 |
| `fjsp.algorithm.connect-timeout` | Duration | 10s | 连接超时 |
| `fjsp.task.scan-interval` | Duration | 30s | 任务超时/重试扫描间隔 |
| `fjsp.task.timeout-buffer` | Duration | 60s | RUNNING 任务 timeoutAt = now + algorithm.timeout + 该缓冲 |
| `fjsp.task.executor.core-size/max-size/queue-capacity` | int | 2/4/20 | 排程任务线程池 |
| `fjsp.auth.jwt-secret` | string ≥32 字节 | 无（`@NotNull`+`@Size(min=32)` 强制） | 默认/prod：必须设 `FJSP_JWT_SECRET`；local：dev-only 演示值；test：固定测试值 |
| `fjsp.auth.token-ttl` | Duration | 8h | JWT 有效期 |
| `fjsp.cors.allowed-origins` | list | 空（不允许跨域） | local：`http://localhost:8082`、`http://127.0.0.1:8082` |
| `fjsp.demo.enabled` | bool | `false` | `/demo/reset` 开关；local profile 显式置 `true`，禁用时返回 403 `E_FORBIDDEN` |
| `fjsp.freeze-window` | Duration | 30m | 重调度冻结窗口（API 入参 `freezeWindowMinutes` 仍为分钟，可覆盖） |
| `fjsp.idempotency-ttl` | Duration | 24h | 幂等记录有效期 |

## 性能基线（V4 索引）

`db/migration/V4__indexes.sql` 为列表/看板/检索热点建了 18 个二级索引（event/schedule_task/plan_version/execution_record/schedule_operation/audit_log）。基线测量：`./scripts/perf-baseline.sh [标签]`（EXPLAIN ANALYZE；`PG_FORCE_INDEX=1` 可禁用顺序扫描验证索引可用性）。

演示数据量：schedule_task=4、plan_version=4、schedule_operation=233、event=3、audit_log=28。

| 查询 | V4 前 | V4 后 | V4 后（强制索引） |
|---|---|---|---|
| 看板最近事件 | Seq Scan 0.237ms | Seq Scan 0.021ms | Index Scan (idx_event_occurred_at) 0.059ms |
| 看板最近任务 | Seq Scan 0.065ms | Seq Scan 0.057ms | Index Scan (idx_schedule_task_created_at) 0.048ms |
| 任务列表分页 | Seq Scan 0.040ms | Seq Scan 0.031ms | Index Scan (idx_schedule_task_created_at) 0.023ms |
| 计划版本列表分页 | Seq Scan 0.024ms | Seq Scan 0.023ms | Index Scan (idx_plan_version_created_at) 0.022ms |
| 计划详情工序 | Seq Scan 0.046ms | Seq Scan 0.034ms | Bitmap Heap Scan 0.050ms |
| 事件列表过滤 | Seq Scan 0.028ms | Seq Scan 0.021ms | Index Scan (idx_event_occurred_at) 0.014ms |
| 审计查询 | Seq Scan 0.035ms | Seq Scan 0.025ms | Bitmap Heap Scan 0.079ms |

结论：演示规模（百行级）下规划器选择 Seq Scan 是最优决策，索引不改变计划节点属预期；强制禁用顺序扫描后全部命中新索引，证明索引定义正确，数据量增长到万行级时自动生效。本步骤的主要收益在查询形态（分页/派生查询替代全表拉取）而非当下耗时。

## 认证与角色

除 `POST /api/v1/auth/login` 与 `/actuator/health/**`、`/actuator/info` 外全部接口要求 `Authorization: Bearer <token>`（JWT，HS256，默认 8h）。未认证 401 `E_UNAUTHORIZED`，角色不足 403 `E_FORBIDDEN`。

## 健康检查与业务指标（Actuator）

| 端点 | 认证 | 内容 |
|---|---|---|
| `GET /actuator/health/liveness` | 匿名 | 仅 JVM 存活（livenessState），不含外部依赖 |
| `GET /actuator/health/readiness` | 匿名 | readinessState + db（PostgreSQL）+ flyway（迁移完成；Boot 3.3 移除了内置 flyway 探针，此处为自定义 `FlywayMigrationHealthIndicator`，存在失败迁移即 DOWN）；启动脚本以此为就绪判据 |
| `GET /actuator/health` | 匿名仅聚合状态；携带 JWT 可见组件明细 | 全量健康，含 `algorithmService` 组件（UP/DOWN + version/algorithmVersion） |
| `GET /actuator/metrics`、`/actuator/prometheus` | **需认证**（不放行，避免指标暴露面扩大） | Micrometer 指标 / Prometheus 抓取格式 |

`algorithmService` 健康指示器以独立 2s 短超时调用算法服务 `GET /health`，**不加入 readiness 分组**——算法服务宕机时业务服务保持 UP（仅 /actuator/health 全量视图中该组件 DOWN、整体 503），任务走既有 RETRY_WAIT 重试策略。

业务指标（`com.fjsp.business.metrics.FjspMetrics` 注册，HikariCP 连接池指标 `hikaricp.connections.*` 由 micrometer 自动采集）：

| 指标 | 类型 | 标签 | 埋点位置 |
|---|---|---|---|
| `fjsp.tasks.total` | Gauge | status（TaskStatus 全部取值） | ScheduleTaskRepository count supplier（scrape 时实时 count） |
| `fjsp.tasks.queue` | Gauge | — | PENDING + RETRY_WAIT count supplier |
| `fjsp.algorithm.solve.duration` | Timer | mode（BASELINE/LOCAL_RESCHEDULE/FULL_RESCHEDULE） | TaskRunner 包裹 /solve 调用（成功与瞬时失败均记录） |
| `fjsp.tasks.retries` | Counter | — | ScheduleTaskStateService 退避重投 + ScheduleTaskCommandService 人工重试 |
| `fjsp.tasks.result` | Counter | result（终态 SUCCESS/TIME_LIMIT/INFEASIBLE/FAILED/CANCELLED） | ScheduleResultAssembler 终态落库 + ScheduleTaskStateService applyFailed/applyCancelled |
| `fjsp.sse.connections` | Gauge | — | TaskEventService 当前 emitter 总数 |

实时失效：JWT 携带 `tv`（tokenVersion）claim；过滤器每次请求按 username 查 `app_user`，用户被删除/停用或 `tv` 不一致（停用、改角色、重置密码时递增）即视为未认证，角色始终以数据库当前值为准（即时生效）。

SSE 例外：`GET /schedule-tasks/{id}/events` 不接受 Bearer 头（EventSource 无法自定义请求头），改用一次性 stream ticket——先 `POST /schedule-tasks/{id}/events/ticket`（正常 Bearer 鉴权）换取 60 秒有效、一次性、绑定任务的 ticket，再以 `?ticket=` 建立连接；`?access_token=` 已不再接受。

角色-端点矩阵（GET 查询类端点任何已认证角色均可；ADMIN 拥有全部权限）：

| 端点 | DISPATCHER | REVIEWER | PRODUCTION_MANAGER | ADMIN |
|---|:-:|:-:|:-:|:-:|
| 任务创建/retry/cancel、事件登记 | ✓ | | | ✓ |
| submit-review、revise | ✓ | | | ✓ |
| review（审核/驳回） | | ✓ | | ✓ |
| publish（发布） | | | ✓ | ✓ |
| 执行反馈 execution | | | ✓ | ✓ |
| 基础数据写端点、demo/reset | | | | ✓ |
| 审计检索 audit-logs | | | | ✓ |

种子账号（**仅本地演示**，密码均为 `Fj@123456`，见 `db/migration/V3__auth.sql` 与 `auth/UserSeedRunner`。**生产部署后必须立即修改全部种子账号密码**；`prod` profile 下 `UserSeedRunner` 禁止使用内置演示密码，初始账号密码必须经环境变量 `FJSP_SEED_ADMIN_PASSWORD` 提供，缺失即启动失败；登录连续失败 5 次会临时锁定 10 分钟，返回 429 `E_LOGIN_LOCKED`）：

| 用户名 | 角色 | 显示名 |
|---|---|---|
| dispatcher | DISPATCHER | 调度员 |
| reviewer | REVIEWER | 审核员 |
| manager | PRODUCTION_MANAGER | 生产主管 |
| admin | ADMIN | 管理员 |

## 接口一览（前缀 /api/v1）

> **分页契约**：列表端点统一返回 `data: {items, page, size, total, totalPages}`（page 从 0 起，size 默认 20、上限 200；工序端点放宽到 5000）。参数非法返回 400 `E_VALIDATION`。裸数组仅保留在 machines/orders/process-templates/dashboard 等小规模基础数据端点。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/auth/login` | 登录：{username, password} → {token, username, role, displayName, expiresAt}；失败统一 401 `E_UNAUTHORIZED` |
| GET | `/auth/me` | 当前登录用户信息 |
| POST | `/schedule-tasks` | 创建排程任务（异步求解），需 `Idempotency-Key`；DISPATCHER/ADMIN |
| GET | `/schedule-tasks/{taskId}` | 任务状态/进度/结果/冲突/重试信息（retryCount、maxRetries、nextRetryAt、timeoutAt、cancelRequested） |
| GET | `/schedule-tasks?page=&size=` | 分页任务列表（按创建时间倒序，含 total/totalPages） |
| POST | `/schedule-tasks/{taskId}/retry` | 人工重试：仅 FAILED/CANCELLED 可调用，重置为 PENDING 并重新投递，否则 409 `E_STATE_CONFLICT` |
| POST | `/schedule-tasks/{taskId}/cancel` | 取消：PENDING/RETRY_WAIT 直接 CANCELLED；RUNNING 置 cancelRequested 协作式取消（求解结果到达后丢弃）；终态 409 |
| POST | `/events/new-orders` | 插单事件（同事务建单+实例化工序+影响集合） |
| POST | `/events/breakdowns` | 设备故障事件（执行中工序冲突返回 E_EVENT_IN_PROCESS） |
| GET | `/events/{eventId}` | 事件详情+影响集合明细 |
| GET | `/events?page=&size=&status=&eventType=&from=&to=` | 事件列表（分页+过滤，from/to 为 occurredAt ISO 范围） |
| GET | `/plan-versions?page=&size=` | 计划版本分页列表 |
| GET | `/plan-versions/{id}` | 版本摘要（含 operationCount；不再内嵌全量工序） |
| GET | `/plan-versions/{id}/operations?page=&size=` | 版本工序分页（size 上限 5000，甘特图大 size 一次取回） |
| GET | `/plan-versions/{id}/diff?baselineVersionId=` | 逐工序差异 + KPI 差异 |
| POST | `/plan-versions/{id}/submit-review` | DRAFT→REVIEW_PENDING，需 `{"version": n}`（提交前重新 /validate） |
| POST | `/plan-versions/{id}/review` | {decision, comment, version}；REJECT 必须填 comment |
| POST | `/plan-versions/{id}/revise` | REJECTED→DRAFT，需 `{"version": n}` |
| POST | `/plan-versions/{id}/publish` | {version} 乐观锁发布；发布前做过期校验（基准版本须 PUBLISHED/EXECUTING、快照后无新事件，否则 E_PLAN_STALE）与完整性复核（E_INTEGRITY_VIOLATION），旧版本转 SUPERSEDED |
| POST | `/operations/{operationId}/execution` | 执行反馈 RUNNING/COMPLETED |
| GET | `/machines` `/orders` `/process-templates` `/dashboard` | 基础数据与聚合看板 |
| POST | `/demo/reset` | 清空业务数据并重新 seed（`audit_log` 保留不清空；`fjsp.demo.enabled=false` 时 403，默认禁用、仅 local profile 开启） |
| GET | `/audit-logs?page=&size=&objectType=&objectId=&operator=&requestId=` | 审计检索（分页+过滤），**仅 ADMIN** |

## 关键设计

- **统一响应**：`{requestId, timestamp, code, message, data}`；`requestId` 经 MDC 贯穿日志。
- **认证与审计身份**：Spring Security 无状态 JWT（`JwtAuthenticationFilter` 解析 Bearer，签名/过期失败视为未认证；每次请求查 `app_user` 校验启用状态并比对 `tv` tokenVersion，停用/改角色/重置密码即时失效，角色以数据库为准）；`RequestContext.operator()` 只从 SecurityContext 取登录用户名（未认证 HTTP 请求记 anonymous，异步/启动恢复等无请求场景记 system），客户端自报的 `X-Operator-Id` 头不再可信、已忽略。`X-Source`（默认 api）、`X-AGH-Session-Id` 仍作为来源/会话标签透传审计。reviewedBy/publishedBy 自动落真实登录用户。`RequestIdFilter` 以最高优先级排在安全过滤器链之前，401/403 响应同样带 requestId 与统一 JSON 包络。
- **幂等**：写接口校验 `Idempotency-Key`，同键同摘要 24h 内返回原结果，同键不同摘要返回 `E_DUPLICATE`；任务另有输入快照指纹（snapshotHash+mode 的 SHA-256）唯一约束。
- **异步任务**：任务落库提交事务后才触发异步求解（afterCommit），后台流程：/solve → /validate 复核 → 创建 DRAFT 计划版本 + schedule_operation 行；不可行保存冲突明细，异常标记 `FAILED`（resultStatus=FAILED，errorMessage 记录摘要）。任务状态机（`TaskStatus` 枚举，字符串列存取）：PENDING→RUNNING→SUCCESS/TIME_LIMIT/INFEASIBLE/FAILED；瞬时失败转 RETRY_WAIT 等待重投；PENDING/RETRY_WAIT/RUNNING 可取消转 CANCELLED。终态：SUCCESS/TIME_LIMIT/INFEASIBLE/FAILED/CANCELLED。
- **任务重试（瞬时失败）**：算法服务调用异常（`RestClientException`：连接拒绝/读超时/5xx）走重试策略——retryCount+1，未超 maxRetries（默认 3）转 RETRY_WAIT，nextRetryAt = now + min(30s×2^(retryCount-1), 600s)（`TaskRetryPolicy`），审计 `TASK_RETRY_SCHEDULED`；超过后转 FAILED 终态（死信），审计 `TASK_FAILED`。INFEASIBLE、validate 复核失败、完整性违规属业务性失败，不重试。FAILED/CANCELLED 任务释放输入指纹（置 null），相同输入可重新创建任务；进行中与成功终态仍按指纹去重（409 `E_DUPLICATE`）。
- **任务超时扫描**：`TaskTimeoutScanner` 每 `fjsp.task.scan-interval`（默认 30s）扫描——RUNNING 且超过 timeoutAt（markRunning 时设为 now + `fjsp.algorithm.timeout`（默认 620s）+ `fjsp.task.timeout-buffer`（默认 60s））按同一重试策略处理；到期的 RETRY_WAIT 重新投递 `TaskRunner`。
- **启动恢复**：`TaskRecoveryRunner`（ApplicationRunner）启动时处理上次进程死亡的残留——RUNNING 任务审计 `TASK_RECOVERED` 并按重试策略转 RETRY_WAIT/FAILED；PENDING 与到期 RETRY_WAIT 重新投递。
- **协作式取消**：算法 HTTP 调用无法中断，RUNNING 任务取消仅置 cancelRequested；`handleSolveResult` 入口检查到该标记则丢弃求解结果、落 CANCELLED、不建计划版本。人工重试端点重置 retryCount/错误信息/完成时间并恢复指纹，走与创建相同的 afterCommit 投递路径。相关审计：`TASK_CANCEL_REQUESTED`/`TASK_CANCELLED`/`TASK_MANUAL_RETRY`。
- **状态机**：DRAFT→REVIEW_PENDING→REVIEWED→PUBLISHED；REJECTED 经 `/revise` 回 DRAFT；首个 RUNNING 执行反馈使 PUBLISHED→EXECUTING；发布新版本时旧 PUBLISHED/EXECUTING→SUPERSEDED。非法跃迁（如 DRAFT/REVIEW_PENDING 直接发布）返回 409 `E_STATE_CONFLICT`。
- **影响集合**：新订单全部工序 / 故障设备未完成工序 / 后继工序 / 维修窗口同机冲突，存 `impactType`/`impactReason`/`lockType`（HARD_LOCKED=已完成+执行中+冻结窗口内，否则 ADJUSTABLE）。
- **计划硬约束完整性（ScheduleIntegrityGuard）**：在任务结果落库（创建计划版本前，违规则任务 FAILED、resultStatus=INTEGRITY_VIOLATION、审计 TASK_INTEGRITY_VIOLATION、不建版本）与发布时各校验一次。规则（重调度候选 vs 父版本）：已完成工序（execution_record COMPLETED）machineId/startAt/endAt 完全不可变；执行中工序（存在未关闭 RUNNING 记录）machineId 固定，actualStartAt 非空时候选 startAt 必须等于实际上报开工时间、endAt 不得早于 actualStartAt（actualStartAt 为空时退化为 startAt 与旧计划一致）；冻结窗口内工序（startAt ∈ [freezeStart, freezeStart+freezeWindowMinutes)，freezeStart 取事件 occurredAt 否则仿真起点，且非事件受影响）machineId/startAt/endAt 不可变。违规返回 409 `E_INTEGRITY_VIOLATION`。
- **执行中工序的锁定协议（actualStartAtMinutes）**：SnapshotBuilder 对 in_progress 锁定项额外携带 `actualStartAtMinutes`；算法侧以此为锚重算窗口（start=actualStart，end=actualStart+剩余工时，剩余=计划加工时长-已进行时长，至少 1 分钟），避免"实际开工晚于计划完工"时重调度必然不可行/被完整性守卫拒绝。业务侧守卫同步以 actualStartAt 为校验基准（见上条）。
- **冻结窗口**：SnapshotBuilder 将 `freezeWindowMinutes` 放入求解请求（并随 InputSnapshot 持久化）；算法服务对窗口内且不在 affectedOperationIds 的 oldPlan 工序独立自动冻结为硬锁，与调用方锁集合不一致时返回 LOCKING_INCONSISTENT 冲突。
- **发布并发**：乐观锁 `version`（submit-review/review/revise/publish 均需携带当前 version，不匹配返回 409 `E_VERSION_STALE`），两个 REVIEWED 候选并发发布时只有一个成功，另一个收到 `E_VERSION_STALE`。
- **发布过期校验（E_PLAN_STALE）**：发布时在状态/版本校验之后、状态变更之前检查——父版本（parentId）必须仍为 PUBLISHED/EXECUTING，否则 409 `E_PLAN_STALE`「基准版本已被取代」；任务输入快照 createdAt 之后若登记了任何新事件，返回 409 `E_PLAN_STALE`「快照之后发生新扰动」。
- **时间**：数据库 timestamptz 存 UTC，接口 ISO 8601。
- **审计**：关键写操作写 `audit_log`（action/objectType/objectId/operator/source/sessionId/requestId/时间）；plan_version 记录 reviewedBy/reviewedAt/publishedBy/publishedAt 与 reviewComment，并在版本摘要/详情 JSON 中返回。

## 目录结构

```text
src/main/java/com/fjsp/business/
├── BusinessServiceApplication.java
├── client/AlgorithmClient.java        # RestClient 封装 /solve /validate
├── common/                            # ApiResponse/BizException/异常处理/requestId/哈希
├── config/                            # FjspProperties/ObjectMapper/异步线程池
├── controller/                        # 6 个 REST 控制器
├── dto/                               # 请求 record
├── entity/                            # 17 张表的 JPA 实体
├── repository/                        # Spring Data JPA
└── service/                           # Seed/Snapshot/Task(+RetryPolicy/TimeoutScanner/RecoveryRunner)/Event/Impact/PlanVersion/Execution/Dashboard/Demo
scripts/smoke-test.sh                  # 全流程 curl 冒烟
src/main/resources/seed/demo_instance.json
```
