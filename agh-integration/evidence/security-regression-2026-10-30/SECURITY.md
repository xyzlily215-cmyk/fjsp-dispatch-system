# P0 安全回归证据汇总 — 2026-10-30（任务 1.3）

> 验收关口：越权审批被拒 / 拒绝审批无副作用 / 基线指标可复现。全程在隔离回归环境
> （`scripts/run-regression.sh`，DB `fjsp-postgres-reg`@15432、algorithm 18101、business **28081**——
> 默认 18081 被本机一个无关的 `python -m http.server` 占用，按脚本支持的 `FJSP_REG_BUSINESS_PORT` 覆盖避让）
> 执行，未触碰演示环境（8081/8101/4178/AGH daemon）与演示容器。

## 环境指纹

| 项 | 值 |
| --- | --- |
| 采集日期 | 2026-10-30 |
| 分支 / 基线 commit | agent-arch-opt / d3b1391（1.1=63d7fea，1.2=99a5b05+d3b1391） |
| 回归业务服务 | `http://localhost:28081/api/v1`（local profile，`FJSP_SIMULATION_MODE=FIXED`，一次性随机 DB 口令） |
| BFF e2e 实例 | 127.0.0.1:14182（独立 store/session/audit/owner 文件于临时目录，真实监听 + 真实 HTTP） |
| 种子账号 | dispatcher=DISPATCHER / reviewer=REVIEWER / manager=PRODUCTION_MANAGER / admin=ADMIN（`UserSeedRunner.java`，local profile 演示密码） |
| AGH | 未拉起（降级说明见 §5）；BFF 审批请求经 `onPermissionRequest` 注入（同 test-approval.mts 的 mock 层手法） |

## 1. 越权审批被拒（端到端：真实内检 + 真实业务服务）

脚本：`agent-bff/test-security-e2e.mts`（新增）。证据：`bff-security-e2e.log`、`bff-approval-audit.jsonl`。

| # | 断言 | 结果 |
| --- | --- | --- |
| 1 | 无 token 调 `/chat`、`/stream-ticket` → 401 | PASS |
| 2 | 伪造 token → 401（真实内检打到回归 business `/auth/me` 被拒） | PASS |
| 3 | 真实登录 4 角色成功，内检 role=DISPATCHER 核实 | PASS |
| 4 | 真实 DISPATCHER 批准 HIGH_RISK `fjsp_publish`（需 PRODUCTION_MANAGER）→ 403 `approval_forbidden`，记录不消费 | PASS |
| 5 | 跨用户审批（真实 PRODUCTION_MANAGER 裁决 dispatcher 会话）→ 403 `conversation_forbidden` + 审计留痕（归属先于角色） | PASS |
| 6 | 真实 PRODUCTION_MANAGER 批准 `fjsp_publish` → 202 `allowed-once`（角色闸非一刀切的对照） | PASS |
| 7 | 重复裁决 → 409 `approval_already_decided` | PASS |
| 8 | 过期审批（TTL 2.5s 测试值）→ 410 `approval_expired`，承诺按 rejected 结算 | PASS |
| 9 | 真实 REVIEWER 批准 `fjsp_approve_review` → 202（评审/发布角色分离） | PASS |
| 10 | 审计 JSONL 7 条：forbidden×2（越权+归属不符）/approved/rejected/expired 齐全，by 为真实用户名，可按业务对象回溯（PV-E2E-1001 轨迹 forbidden→forbidden→rejected） | PASS |

mock 层回归（1.1/1.2 既有套件，确认无回退）：`test-auth.mjs` 11 组、`test-approval.mts` 14 组、`mcp-smoke.mjs` 全绿。证据：`mock-layer-regression.log`。

## 2. 拒绝审批无副作用（s06）

回归环境跑 `s06-review-reject.mjs`（run-regression.sh 第 4 阶段，证据 `run-regression.log`）：

- 版本终态 REJECTED，驳回意见落库；
- `dashboard.currentPlan` 为 null（无 PUBLISH）；
- REJECTED 版本上 publish 被状态机拒绝（409 `E_STATE_CONFLICT`），尝试后状态仍 REJECTED；
- 审计链含 `PLAN_SUBMIT_REVIEW` + `PLAN_REVIEW_REJECT`，**不含 `PLAN_PUBLISH`**。

与 golden-set.md s06 断言逐项一致，与基线 `audit-s06.json`（SUBMIT→REJECT，无 PLAN_PUBLISH）一致。

## 3. MCP `_confirm` 回归（真实业务服务无副作用）

脚本：`agent-bff/test-mcp-confirm.mjs`（新增），MCP server 的 `FJSP_API_BASE` 指向回归 business。证据：`mcp-confirm.log`。

- `fjsp_report_breakdown`（WRITE）带 `_confirm:true` → isError + `APPROVAL_CHANNEL_REQUIRED`；
- `fjsp_reset_demo`（DESTRUCTIVE）带 `_confirm:true` → `APPROVAL_CHANNEL_REQUIRED`；
- 调用前后 BREAKDOWN 事件总数不变（0 → 0），**无业务副作用**；
- 对照：READ `fjsp_get_dashboard` 真实打通回归业务（证明 MCP 确实指向回归服务而非死端口）。

## 4. 基线可复现对照（对照 `evidence/baseline-2026-10-30/BASELINE.md`）

| 场景 | 指标 | 基线 | 本次回归 | 一致性 |
| --- | --- | --- | --- | --- |
| s01 | 影响集合 | total=12（SAME_MACHINE_CONFLICT 2 / MACHINE_BREAKDOWN 4 / SUCCESSOR 6） | total=12，byType 逐位一致 | ✅ |
| s01 | 重调度终态 | SUCCESS + FEASIBLE，conflicts 空 | SUCCESS + FEASIBLE，conflicts 空 | ✅ |
| s01 | 候选 KPI | cMax 3355 / 加权拖期 60199 / 负载 0.102175 / Δ_plan 0.128166 | 逐位一致（`s01-kpi-replay.log`，dashboard 复核 cMax=3355 一致） | ✅ |
| s01 | 审计链 | SUBMIT→APPROVE→PUBLISH | SUBMIT→APPROVE→PUBLISH | ✅ |
| s01 | 业务终态 | 新 PV PUBLISHED（版本号随序列递增属预期） | PV-000010 PUBLISHED | ✅ |
| s01 | 步骤数/token | 19/18 步，tokens 见 BASELINE.md | N/A（API 层降级，无 agent 轮次，见 §5） | —（降级） |
| s05 | 重复告警 | 3 次投递净增 1 条（同键回放 + 换键 409 E_DUPLICATE） | 净增 1（回放 + 409 E_DUPLICATE），EVT 序列连续 | ✅ |
| s06 | 审批拒绝 | REJECTED，无 PUBLISH，审计无 PLAN_PUBLISH | 逐项一致（见 §2） | ✅ |

s01 KPI 复现方式：`s01-kpi-replay.mjs`（本目录）按基线事件流中 agent 的 `fjsp_reschedule` 调用逐字段重放
（`{mode: LOCAL_RESCHEDULE, eventId, oldPlanVersionId}`，不带 weights/algorithm），同 seed 同快照下 KPI 逐位一致，
与 `algorithm-service/tests/test_reproducibility.py` 的同 seed 保证互证。

## 5. 降级项说明（s01 agent 处置未跑 AGH）

简报允许「若不可行则记录原因并降级为 API 层 s01」。降级原因（已核实）：

1. `driver/fjsp-agent.mts:19` 硬编码读 `~/.agh/data/daemon/owner.json`——即**正在运行的演示 daemon**；
   其 extension host 的环境变量（fjsp-tools 的 `FJSP_API_BASE` 等）在 daemon 启动时注入，指向演示 8081。
   直接用 driver 会把 agent 写操作打进演示库，触碰红线。
2. 起第二个 daemon 需独立 AGH_HOME/data-dir/profile/socket/端口 + 模型凭据（`~/.config/fjsp/agnes.env`）
   + skill 安装（`~/.agh/skills/fjsp-dispatch`），且 driver 的 owner.json 路径需改码——超出本任务
   「不改代码、小修为限」的边界，且每一步都有污染演示 AGH 状态的风险。
3. agent 行为指标（步骤数/token）属 LLM 轮次指标，本任务关口关注的是**业务终态可复现**，
   已由 API 层逐位复现覆盖（§4）。

## 6. CI 接入

- `regression-test` job 本就跑 s01–s06 → §2（s06）本就在 CI；
- 本次将 §1（test-security-e2e）与 §3（test-mcp-confirm）接入 `run-regression.sh` 第 5 阶段，
  CI job 经 `FJSP_TSX` 注入独立安装的 tsx@4.23.13 后在 CI 同样执行；本机无 tsx 时跳过并打印手动命令；
- 依赖 AGH 的 agent 行为回归不进 CI（与简报一致）。

## 文件清单

| 文件 | 内容 |
| --- | --- |
| `run-regression.log` | 首次回归运行（s01–s06 全过，业务端口 28081） |
| `run-regression-full.log` | 改动后 run-regression.sh 全量复跑（含第 5 阶段安全回归） |
| `bff-security-e2e.log` | test-security-e2e 10 组断言 stdout |
| `bff-approval-audit.jsonl` | BFF 审批审计原始 JSONL（真实用户名） |
| `mcp-confirm.log` | MCP `_confirm` 回归 stdout |
| `mock-layer-regression.log` | test-auth 11 组 + test-approval 14 组 + mcp-smoke |
| `s01-kpi-replay.mjs` / `s01-kpi-replay.log` | s01 KPI 逐位复现脚本与输出 |
| `scenario-results.jsonl` | 场景 SCENARIO_RESULT 汇总 |
