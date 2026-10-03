# FJSP 动态调度系统 — 业务服务

动态柔性车间生产调度与仿真决策系统的业务服务：数据持久化、事件登记、影响集合计算、任务编排、计划版本与审核发布、执行反馈。算法求解由独立的算法服务（Python/FastAPI）完成，本服务通过 HTTP 调用并复核结果。

## 技术栈

- Java 17、Spring Boot 3.3.5、Spring Data JPA（ddl-auto=update）
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
mvn spring-boot:run          # 或 mvn -DskipTests package && java -jar target/business-service-1.0.0.jar
```

默认端口 **8081**（本机 8080 被其他应用占用；修改 `src/main/resources/application.yml` 的 `server.port` 可调整）。
首次启动时若 `machine` 表为空，自动从 `src/main/resources/seed/demo_instance.json` 导入：
8 台设备（含每台设备的日历可用区间）、3 个产品族工艺模板（按订单工序结构反推合并）、20 个订单（76 道工序，状态 WAITING）。

### 4. 验证

```bash
curl http://localhost:8081/api/v1/machines        # 应返回 8 台设备
./scripts/smoke-test.sh                            # 全流程冒烟测试
```

## 配置项（application.yml）

| 配置 | 默认 | 说明 |
|---|---|---|
| `server.port` | 8081 | 服务端口 |
| `spring.datasource.url` | 由 `FJSP_DB_*` 变量组成 | PostgreSQL 连接地址 |
| `spring.datasource.password` | `FJSP_DB_PASSWORD` | 数据库密码，不写入仓库 |
| `fjsp.algorithm.base-url` | `FJSP_ALGORITHM_BASE_URL` 或 http://localhost:8101 | 算法服务地址 |
| `fjsp.algorithm.timeout-seconds` | 620 | 调用 /solve、/validate 超时 |
| `fjsp.simulation-start-at` | 2026-09-16T08:00:00+08:00 | 默认仿真起点（以 seed JSON 为准） |
| `fjsp.freeze-window-minutes` | 30 | 重调度冻结窗口 |
| `fjsp.idempotency-ttl-hours` | 24 | 幂等记录有效期 |

## 接口一览（前缀 /api/v1）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/schedule-tasks` | 创建排程任务（异步求解），需 `Idempotency-Key` |
| GET | `/schedule-tasks/{taskId}` | 任务状态/进度/结果/冲突 |
| GET | `/schedule-tasks` | 最近 20 条任务 |
| POST | `/events/new-orders` | 插单事件（同事务建单+实例化工序+影响集合） |
| POST | `/events/breakdowns` | 设备故障事件（执行中工序冲突返回 E_EVENT_IN_PROCESS） |
| GET | `/events/{eventId}` | 事件详情+影响集合明细 |
| GET | `/plan-versions` | 计划版本列表 |
| GET | `/plan-versions/{id}` | 版本详情（含全部 schedule_operation 与 KPI） |
| GET | `/plan-versions/{id}/diff?baselineVersionId=` | 逐工序差异 + KPI 差异 |
| POST | `/plan-versions/{id}/submit-review` | DRAFT→REVIEW_PENDING，需 `{"version": n}`（提交前重新 /validate） |
| POST | `/plan-versions/{id}/review` | {decision, comment, version}；REJECT 必须填 comment |
| POST | `/plan-versions/{id}/revise` | REJECTED→DRAFT，需 `{"version": n}` |
| POST | `/plan-versions/{id}/publish` | {version} 乐观锁发布；发布前做过期校验（基准版本须 PUBLISHED/EXECUTING、快照后无新事件，否则 E_PLAN_STALE）与完整性复核（E_INTEGRITY_VIOLATION），旧版本转 SUPERSEDED |
| POST | `/operations/{operationId}/execution` | 执行反馈 RUNNING/COMPLETED |
| GET | `/machines` `/orders` `/process-templates` `/dashboard` | 基础数据与聚合看板 |
| POST | `/demo/reset` | 清空业务数据并重新 seed |

## 关键设计

- **统一响应**：`{requestId, timestamp, code, message, data}`；`requestId` 经 MDC 贯穿日志。
- **请求头**：写操作可从 `X-Operator-Id`（默认 anonymous）、`X-Source`（默认 api）、`X-AGH-Session-Id` 读取操作者/来源/会话，落入审计。
- **幂等**：写接口校验 `Idempotency-Key`，同键同摘要 24h 内返回原结果，同键不同摘要返回 `E_DUPLICATE`；任务另有输入快照指纹（snapshotHash+mode 的 SHA-256）唯一约束。
- **异步任务**：任务落库提交事务后才触发异步求解（afterCommit），后台流程：/solve → /validate 复核 → 创建 DRAFT 计划版本 + schedule_operation 行；不可行保存冲突明细，异常标记 `FAILED`（resultStatus=FAILED，errorMessage 记录摘要）。
- **状态机**：DRAFT→REVIEW_PENDING→REVIEWED→PUBLISHED；REJECTED 经 `/revise` 回 DRAFT；首个 RUNNING 执行反馈使 PUBLISHED→EXECUTING；发布新版本时旧 PUBLISHED/EXECUTING→SUPERSEDED。非法跃迁（如 DRAFT/REVIEW_PENDING 直接发布）返回 409 `E_STATE_CONFLICT`。
- **影响集合**：新订单全部工序 / 故障设备未完成工序 / 后继工序 / 维修窗口同机冲突，存 `impactType`/`impactReason`/`lockType`（HARD_LOCKED=已完成+执行中+冻结窗口内，否则 ADJUSTABLE）。
- **计划硬约束完整性（ScheduleIntegrityGuard）**：在任务结果落库（创建计划版本前，违规则任务 FAILED、resultStatus=INTEGRITY_VIOLATION、审计 TASK_INTEGRITY_VIOLATION、不建版本）与发布时各校验一次。规则（重调度候选 vs 父版本）：已完成工序（execution_record COMPLETED）machineId/startAt/endAt 完全不可变；执行中工序（存在未关闭 RUNNING 记录）machineId+startAt 固定，仅可调整剩余部分（endAt ≥ actualStartAt）；冻结窗口内工序（startAt ∈ [freezeStart, freezeStart+freezeWindowMinutes)，freezeStart 取事件 occurredAt 否则仿真起点，且非事件受影响）machineId/startAt/endAt 不可变。违规返回 409 `E_INTEGRITY_VIOLATION`。
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
└── service/                           # Seed/Snapshot/Task/Event/Impact/PlanVersion/Execution/Dashboard/Demo
scripts/smoke-test.sh                  # 全流程 curl 冒烟
src/main/resources/seed/demo_instance.json
```
