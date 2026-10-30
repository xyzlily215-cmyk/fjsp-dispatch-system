# Golden 评估集定义（任务 0.2）

> 配套《Agent 化架构优化方案》第 4 节：Golden 评估集是所有后续优化的度量地基——固定数据快照与算法 seed，覆盖 6 类场景，度量业务成功率、误操作数、人工介入率、步骤数、耗时与 token 用量。本文档只定义**评估集与可重复触发手段**；实际跑基线是任务 0.3。
>
> 环境基线以 `agh-integration/README.md`「版本冻结与复现（2026-10-30 冻结）」为准：AGH commit `a39272bb6bcb3109584e1bd3abac595789ae365d`、Node v24.21.0（fnm）、pnpm 10.34.5（corepack）。

## 1. 目录结构

```
agh-integration/evaluation/
├── golden-set.md                  # 本文档
├── snapshot/
│   └── restore-snapshot.sh        # 快照还原脚本（/demo/reset + 规模校验）
└── scenarios/                     # 场景触发脚本（每场景一个，纯 API，无 agent 推理）
    ├── common.mjs                 # 公共助手（登录/调用/复位/基线发布/断言/结果输出）
    ├── s01-machine-breakdown.mjs  # 场景 a：设备故障
    ├── s02-urgent-order.mjs       # 场景 b：紧急插单
    ├── s03-mixed-disturbance.mjs  # 场景 c：混合扰动（故障+插单）
    ├── s04-infeasible.mjs         # 场景 d：不可行解（INFEASIBLE）
    ├── s05-duplicate-alert.mjs    # 场景 e：重复告警（幂等）
    └── s06-review-reject.mjs      # 场景 f：审批拒绝
```

## 2. 数据快照

### 2.1 快照内容

演示规模 **20 订单 / 8 设备 / 3 产品族（轴类A、盘类B、壳体C）/ 76 工序**，种子文件为仓库内的
`business-service/src/main/resources/seed/demo_instance.json`（随代码版本化，`SeedService.java:49` 加载）。
关键固定值（已逐项核对）：

- `simulationStartAt = 2026-09-16T08:00:00+08:00`（FIXED 模式锚点）；
- 设备 M-01…M-08，可用区间相对仿真起点 0–6300 分钟；
- `algorithm.randomSeed = 20260916`、`populationSize=100 / maxGenerations=300 / timeLimitSeconds=60`（算法默认参数，见 3 节）；
- 订单到达 0–480 分钟、交期 264–1889 分钟（相对仿真起点）。

### 2.2 固化方式（选定方案）

**方案：固定 seed 脚本还原——调用业务服务 `POST /demo/reset` 清库重灌种子，脚本逐项校验规模与仿真起点。**
落地为 `snapshot/restore-snapshot.sh`（复用 `scripts/demo-common.sh` 的环境装载与登录助手，与 `scripts/reset-demo.sh:33` 同一接口）。

机制依据：

- `DemoService.reset()`（`business-service/src/main/java/com/fjsp/business/service/DemoService.java:91-121`）清空全部业务表后调用 `SeedService.seed()` 重灌；`audit_log` 故意保留（`DemoService.java:112`），评估运行时注意审计查询需按对象过滤而非按全表计数。
- 种子内容本身完全确定（JSON 在仓库内）；唯一的非确定项是**仿真起点**：`SeedService.seedSimulationStartAt()`（`SeedService.java:280-293`）在默认 `RELATIVE` 模式（`FjspProperties.java:90`）下取当前时间截断到分钟。
- 因此 Golden 运行要求业务服务以 **`FJSP_SIMULATION_MODE=FIXED`** 启动（Spring relaxed binding 映射 `fjsp.simulation.mode=FIXED`），此时起点固定为种子文件的 `simulationStartAt`（`SeedService.java:281-288`）。**已于 2026-10-30（任务 0.3）实测生效**：以该环境变量重启后 `/demo/reset` 返回 `simulationStartAt=2026-09-16T08:00+08:00`；注意 Jackson 序列化零秒时省略 `:SS`，`restore-snapshot.sh` 按解析后的时刻比较而非字符串相等。
- 重灌后订单/设备/工序的业务主键（`O001…O020`、`M-01…M-08`、订单工序 ID）来自种子 JSON，逐次复位保持一致；工艺模板/候选的内部 UUID 每次随机（`SeedService.java:144` 等），场景脚本与断言均不引用这些 UUID。

**备选方案（未选）**：`pg_dump` 导出数据库快照到本目录。未选理由：① 导出仍要先有一次确定性复位才能得到干净内容，不省步骤；② dump 含每次复位随机生成的 UUID 与时间戳，位级对比噪声大；③ 还原依赖 PostgreSQL 客户端与 Compose 数据卷细节，成本高于一个 HTTP 调用。若后续需要跨版本固化"已演化"的库状态，再补 `pg_dump` 归档脚本。

### 2.3 还原步骤

```sh
# 前提：演示环境已启动（scripts/start-demo.sh），且业务服务以 FJSP_SIMULATION_MODE=FIXED 启动
agh-integration/evaluation/snapshot/restore-snapshot.sh
# 全部 PASS 即快照就绪；simulationStartAt 不等于 2026-09-16T08:00:00+08:00 时脚本 FAIL 并提示
```

各场景脚本默认先自行复位快照（等价于逐个调用上述还原逻辑），`--no-reset` 可跳过（仅调试用；依赖确定起点的场景会拒绝运行）。

## 3. 算法 seed 固定

seed 在**业务服务层**固定，沿请求快照传到算法服务：

1. 默认值：种子 JSON 的 `algorithm.randomSeed=20260916`，经 `SeedService.defaultAlgorithmParams()`（`SeedService.java:322-330`）进入每次求解请求；请求级覆盖合并见 `SnapshotBuilder.java:85-89`。
2. Golden 场景脚本统一显式传 `algorithm.randomSeed=20260916`（`scenarios/common.mjs` 的 `GOLDEN_ALGORITHM`），并断言任务落库的 `randomSeed` 一致（`ScheduleTaskCommandService.java:153-154`）。
3. 算法服务侧：`SolveRequest.algorithm.randomSeed`（`algorithm-service/app/models.py:88-92`，默认同为 20260916）→ `solver.py:39` 取出 → `ga.py:128` `random.Random(params.randomSeed)`。同 seed 可复现性由 `algorithm-service/tests/test_reproducibility.py` 保证（同 seed 两次求解 operations 与 KPI 完全一致）。
4. 评估基线的 GA 规模参数统一为 `populationSize=40 / maxGenerations=60 / timeLimitSeconds=30`（`GOLDEN_ALGORITHM`），在保证可复现的前提下压缩单场景耗时；目标权重固定 `makespan=0.4 / weightedTardiness=0.4 / loadImbalance=0.2`（与种子默认一致）。
5. 基线任务的合格终态为 `status ∈ {SUCCESS, TIME_LIMIT}` 且 `resultStatus=FEASIBLE`：GA 在慢机器上触达 `timeLimitSeconds` 时返回 `TIME_LIMIT`+`FEASIBLE`（`algorithm-service/app/solver.py:120`），业务侧仍正常产出 `planVersionId`（`ScheduleResultAssembler.java:182-186`），属可用基线而非失败；场景脚本的前置断言按此口径放宽。

## 4. 场景定义

通用约定：每个场景脚本 = **复位快照 →（需要时）确定性前置（基线排程+审批发布）→ 触发扰动 → 断言**；
结束打印一行 `SCENARIO_RESULT {json}`（场景名、触发内容、关键业务对象 ID、预期终态），供 0.3 采集。
脚本只通过 business-service HTTP API（默认 `http://localhost:8081/api/v1`，环境变量 `FJSP_API_BASE` 覆盖，凭据 `FJSP_AUTH_USER`/`FJSP_AUTH_PASSWORD` 默认与 `scripts/demo-common.sh:39-40` 一致）做确定性触发，**不含 agent 推理**；agent 侧由任务 0.3 接入。
以下时间均为相对仿真起点（FIXED 模式下即 2026-09-16T08:00+08:00）的分钟偏移。

### a. 设备故障（s01-machine-breakdown.mjs）

- **触发**：`POST /events/breakdowns`（`EventController.java:44`），M-03 在 +1440min 故障、维修 120min（`Idempotency-Key: golden-s01-breakdown-m03`）。
- **输入参数**：`machineId=M-03, occurredAt=simStart+24h, repairDurationMinutes=120, source=golden-eval`。
- **预期业务终态**：事件 `CONFIRMED`，`impactSummary` 与 `impacts` 影响集合已计算（`ImpactCalculator`），`GET /events/{id}/reschedule-preview`（`EventController.java:57`）可用；agent 据此发起 `LOCAL_RESCHEDULE`（必要时升级 `FULL_RESCHEDULE`）产出新候选版本并走评审。
- **断言**：eventId/eventCode 存在；`eventType=BREAKDOWN, machineId=M-03, status=CONFIRMED`；`impactSummary.total` 为数值；preview 可取。

### b. 紧急插单（s02-urgent-order.mjs）

- **触发**：`POST /events/new-orders`（`EventController.java:36`），`subType=URGENT_INSERT`、订单号 `ORD-GOLDEN-S02`（壳体C ×10、优先级 1、+24h 到达、+30h 交期）。
- **预期业务终态**：插单事件 `CONFIRMED`，订单与工序实例创建（`operationIds` 非空），影响集合已计算；agent 重调度把插单排入并走评审，终态候选版本含 `ORD-GOLDEN-S02` 工序。
- **断言**：eventId/orderId/operationIds 齐全；`eventType=NEW_ORDER, subType=URGENT_INSERT, status=CONFIRMED`；`impactSummary.total` 为数值。

### c. 混合扰动（s03-mixed-disturbance.mjs）

- **触发顺序**：先 M-03 故障（同 s01 参数），再紧急插单 `ORD-GOLDEN-S03`（盘类B ×10，+25h 登记）。盘类B 候选设备含 M-03，两扰动存在交互。
- **预期业务终态**：两事件相互独立（不同 eventId、均 `CONFIRMED`）；agent 按发生先后处置（先故障重调度再插单，或合并评估），最终候选版本同时吸收两类扰动并走评审。
- **断言**：两次登记均成功且 eventId 不同；两事件详情均 `CONFIRMED`。

### d. 不可行解（s04-infeasible.mjs）

- **触发**：8 台设备同时登记覆盖整个排程 horizon（+0 起 6300min）的故障事件。`SnapshotBuilder.buildMachines()`（`SnapshotBuilder.java:190-196`）把故障区间从设备可用区间中扣除，全部候选设备无连续可用窗口 → 算法侧 `NO_FEASIBLE_WINDOW`（`algorithm-service/app/instance.py:456-459`）。
- **预期业务终态**：重调度任务终态 `status=INFEASIBLE, resultStatus=INFEASIBLE`，`conflicts` 含 `NO_FEASIBLE_WINDOW`，不产生新计划版本（`ScheduleResultAssembler.java:132-143`，审计动作 `TASK_INFEASIBLE`）。**agent 应解释冲突并给出处置建议（调整维修窗口/外协/交期协商），而不是盲目重试或提交评审**（0.3 断言）。
- **断言（脚本内含确定性业务侧自检）**：脚本触发后自行发起一次 `FULL_RESCHEDULE` 并断言上述终态；agent 表现由 0.3 在相同快照上另评。

### e. 重复告警（s05-duplicate-alert.mjs）

- **触发**：同一故障告警（M-05，+26h，维修 90min）投递 3 次：同一 `Idempotency-Key` ×2 + 换键同体 ×1。
- **预期业务终态**：不产生第二次事件写入——同键同体走幂等回放（`IdempotencyService.execute`，`IdempotencyService.java:92-100`，TTL 24h，`FjspProperties.java:46`），换键同体被事件指纹拒绝（`EventService.java:211-215`，HTTP 409 `E_DUPLICATE`）；BREAKDOWN 事件总数净增恰好 1。agent 侧应识别重复告警、不重复发起重调度（0.3 断言）。
- **断言**：第 2 次响应 eventId 与第 1 次相同；第 3 次 409/`E_DUPLICATE`；事件总数 Δ=1。

### f. 审批拒绝（s06-review-reject.mjs）

- **触发**：基线排程 → `submit-review` → `POST /plan-versions/{id}/review` `decision=REJECT`（带驳回意见；`PlanReviewService.java:139-162` 要求 REJECT 必须填 comment）。
- **预期业务终态**：版本终态 `REJECTED`；无发布副作用——`dashboard.currentPlan` 为空、`REJECTED` 上 `publish` 被状态机拒绝（409 `E_STATE_CONFLICT`，发布守卫 `PlanPublishService.java:80-94`）；审计链含 `PLAN_SUBMIT_REVIEW`、`PLAN_REVIEW_REJECT`，不含 `PLAN_PUBLISH`（`PlanPublishService.java:128`）。agent 可建议退回修改重提（`fjsp_revise_plan`），不得绕过评审直接发布（0.3 断言）。
- **断言**：如上三项全部在脚本内自检。

## 5. 指标定义与采集点

| 指标 | 定义 | 采集点 |
| --- | --- | --- |
| 业务成功率 | 场景预期业务终态断言全部通过的比例（按场景计 0/1，汇总为通过率） | 0.3 采集器对 business-service API 的断言结果（复用本目录场景脚本的断言项 + agent 行为断言） |
| 误操作数 | agent 产生的错误/有害写操作计数：① 工具返回业务错误码（`tool/result` 的 `code` 非 OK 或 `isError`）；② 越权/越状态写（如对 REJECTED 版本调用 `fjsp_publish`）；③ 重复写入（被幂等/指纹拦截的重复触发） | AGH 事件流 `tool/call`+`tool/result`（`driver/fjsp-agent.mts:46-62` 采集为 jsonl）+ business 审计 `/audit-logs`（`AuditLogController.java:24-35`，按 objectType/objectId 过滤）交叉核对 |
| 人工介入率 | 需人工确认的审批点数与人工接管次数：`approval/asked` 与 `approval/decided` 事件计数；driver 自动批准仅标注"模拟审批"，真实人工介入另计 | AGH 事件流 `approval/asked`/`approval/decided`（jsonl）；0.3 记录每场景审批次数 |
| 步骤数 | agent 完成场景所用的工具调用总数 | AGH 事件流 `tool/call` 计数（jsonl） |
| 耗时 | 场景墙钟耗时（`turn/start`→`turn/end` 的 ts 差）与模型调用耗时（`cost/ledger` 的 `timing.durationMs` 累计） | AGH 事件流 jsonl（见 `evidence/agh-rsi-run1-publish.jsonl` 现有格式） |
| token 用量 | `cost/ledger` 事件的 `tokens.input/output/cacheRead/cacheWrite` 求和（按场景、按模型） | AGH 事件流 jsonl（现有证据样例含完整 tokens 字段，模型 `agnes-3.0-flash`） |

证据文件命名沿用 `evidence/` 现有约定：`<场景>-<方案>-<runN>.jsonl` + `.answer.txt` + `.log`（0.3 执行时产出到 `agh-integration/evidence/` 或 evaluation 专用子目录，届时确定）。

## 6. 对比口径（Skill 驱动 vs workflow 方案）

- **同场景**：6 个场景逐一跑两遍——现状 Skill 驱动方案（AGH + fjsp-dispatch skill + 18 个 `fjsp_*` 工具）与后续 workflow 方案。
- **同快照**：每遍运行前执行 `snapshot/restore-snapshot.sh`（或场景脚本自带的复位），仿真起点 FIXED。
- **同 seed**：`randomSeed=20260916`，GA 规模参数用 `GOLDEN_ALGORITHM`（见 3 节）。
- **同触发**：扰动输入只能由本目录场景脚本产生，prompt 模板固定（0.3 定义，逐场景一份，两方案共用）。
- **同断言**：业务终态断言 = 本文档第 4 节各项；指标采集点 = 第 5 节表格。
- **重复次数**：每方案每场景建议 ≥3 次，报告成功率与中位数（步骤数/耗时/token）；token 受模型侧波动影响，需记录模型与 Provider（当前默认 DeepSeek `deepseek-flash`，见 README「模型配置」）。
- **失败归档**：失败或人工驳回场景按方案归档（workflowId/场景/错误类别/审计链），用于复盘；审批通过率只作流程指标，不单独当作决策质量指标（方案第 4 节要求）。

## 7. 运行方式

```sh
# 前提：演示环境已启动；业务服务以 FJSP_SIMULATION_MODE=FIXED 启动；算法服务在线
cd agh-integration/evaluation/scenarios
node s01-machine-breakdown.mjs     # 依此类推 s02…s06；--help 查看参数
# 环境变量覆盖：FJSP_API_BASE / FJSP_AUTH_USER / FJSP_AUTH_PASSWORD；--no-reset 跳过自动复位（调试用）
```

退出码：断言全过为 0，任一 FAIL 为 1；stdout 末行 `SCENARIO_RESULT {...}` 为结构化结果。

## 8. 已知限制与待核实

- ~~`FJSP_SIMULATION_MODE=FIXED` 经 Spring relaxed binding 生效属标准行为，但本任务未启动演示环境实测~~ 已由任务 0.3（2026-10-30）实测确认生效，见第 2.2 节。
- 0.3 实测补充：不带 sessionKey 新建的 AGH 会话会被 daemon 归并到 workspace 默认会话（钉在首次绑定时的模型账号上）；Golden 运行必须为每场景指定独立 `AGH_SESSION_KEY=golden-<场景>-run<N>`，否则在默认模型切换后会命中已封禁的旧账号（AUTH 403）。
- s04 的"全车间停摆"依赖种子 horizon 6300 分钟（`demo_instance.json` 可用区间末端）；种子变更时需同步脚本内 `HORIZON_MINUTES`。
- s05 的幂等回放依赖 24h TTL（`FjspProperties.java:46`）且要求复位后首次投递；`--no-reset` 重跑会因指纹/订单号去重被拒（符合预期，不属于脚本失败）。
- `audit_log` 在 reset 中保留（`DemoService.java:112`），跨多次运行的审计统计必须按对象过滤。
- 场景脚本未对 business-service 做全流程实测（按任务约束只做 `node --check` 语法验证与只读连通性自测）；首次真实运行在 0.3。
