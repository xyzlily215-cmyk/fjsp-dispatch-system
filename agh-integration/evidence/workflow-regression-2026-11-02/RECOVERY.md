# P2 恢复回归 + 评估集复测汇总（任务 3.5，2026-11-02）

> 全部证据来自本次真实运行。环境：隔离回归环境（`scripts/run-regression.sh --keep`；业务 28081、算法 18101、DB 15432、`FJSP_SIMULATION_MODE=FIXED`），BFF 为驱动进程内独立实例（127.0.0.1:14184，真实 JWT 内检指向回归 business）。
> **端口偏差说明**：18081 被一个残留 2 天以上的 `python -m http.server`（PID 37027，非演示环境组件）占用，未擅杀他人进程，本次回归业务端口改用 `FJSP_REG_BUSINESS_PORT=28081`；隔离性不变。
> **降级披露**：agent 决策节点不注入（不接真实 LLM），策略/解释/评审材料全部走 `DEFAULT_STRATEGY` 与确定性兜底；token 指标记 N/A。`timeout` 模式的 `fjsp_task_status` 恒返 RUNNING 快照与 `stale` 模式的过期 version 为脚本化注入（写路径全真实）。

## 0. 前置：回归环境健康度

`run-regression.sh --keep` 全程通过：golden 场景 s01–s06 断言全过（`regression-scenarios.log`、`scenario-results.jsonl`），BFF 安全端到端 10 组与 MCP `_confirm` 回归全过。

## 1. 四故障模式（P2 验收关口）

| 故障模式 | 构造方式 | 结果 | 关键断言（全部 PASS） | 证据 |
| --- | --- | --- | --- | --- |
| 重启 | 子进程（detached 进程组）跑到 poll-task intent 被整组 `kill -9`（exit 信号 SIGKILL + ps 组列举零残留 + 3s 检查点静默期三重实证死亡） | recover() → resume（复用原幂等键 `wfId:poll-task:1`）→ 续跑至挂起 → 挂起态再 recover() 核对到 BFF pending 审批继续等 → 批准 → **COMPLETED** | taskId 恢复后不变；调度任务/事件净增恰 1（实测值）；12 节点各执行恰一次、seq 全 1；poll-task attempt=2；BFF 审批登记恰 1 条且无孤儿 pending；PLAN_SUBMIT_REVIEW 恰 1 次 | `restart.json/.log/-checkpoint-*` |
| 超时 | `fjsp_task_status` 脚本化恒返 RUNNING 快照（非终态），写路径全真实 | poll-task 重试 3 次（maxAttempts）→ **FAILED 转人工**，停在 poll-task | 任务恰创建 1 次（重试复用同键）；未产出候选版本；无重复副作用 | `timeout.json/.log/-checkpoint-*` |
| 重复告警 | 业务三层（同键×2 + 换键同体×1）+ 工作流同指纹触发两次 | 同键回放同 eventId；换键 409 `E_DUPLICATE`；第二次触发返回已有 workflowId（deduplicated=true）且不推进 | 事件登记写恰 1 次、重调度写恰 1 次；BREAKDOWN 净增符合预期 | `s05.json/.log/-checkpoint-*` |
| 乐观锁冲突 | submit-review 前注入过期 version（version-1，模拟并发修改） | 首次命中 `E_VERSION_STALE` → 节点重读最新 version → 第 2 次尝试成功 → 挂起 → 批准 → **COMPLETED** | submit-review attempt=2；PLAN_SUBMIT_REVIEW 恰 1 次；最终 REVIEW_PENDING | `stale.json/.log/-checkpoint-*` |

**P2 验收结论：重启、超时、重复告警、乐观锁冲突均到达预期终态且不重复写入 —— 通过。**

## 2. 评估集复测（workflow 驱动）与基线对照

驱动：`workflow/e2e-regression.mts`（真实 fjsp-tools HTTP + 真实 BFF 审批链路；每模式先复位快照 + 发布基线，GOLDEN_ALGORITHM seed=20260916）。
「步骤数」口径：workflow=流程节点完成数（12 节点流程）；基线=AGH 事件流工具调用数。「人工介入点数」：workflow=BFF 真实审批登记/裁决次数；基线=driver 模拟审批次数。基线含发布动作，workflow 方案发布不在流程内（见口径差异）。

| 场景 | workflow 终态 | 步骤数 | 人工介入点 | 墙钟 | tokens | 基线（2026-10-30，Skill 驱动） |
| --- | --- | --- | --- | --- | --- | --- |
| s01 设备故障 | COMPLETED，候选 REVIEW_PENDING；KPI cMax 3355 / 加权拖期 60199 / 负载 0.102175 / Δ0.128166 | 12 | 1 | 3.1s | N/A | ✅ 发布 PV-000053；19 步 / 8 审批 / 95s；**KPI 逐位一致**（cMax 3355 / 60199 / 0.102175 / Δ0.128166） |
| s05 重复告警 | COMPLETED；重复触发去重、无第二次写入 | 12 | 1 | 3.2s | N/A | ✅ 3 次推送只登记 1 条；3 步 / 1 审批 / 16s |
| s06 审批拒绝 | TERMINATED（真实 BFF 拒绝）；候选停留 REVIEW_PENDING；publish 被 409 E_STATE_CONFLICT 拒；审计无 PLAN_PUBLISH；发布计划未被替换 | 12 | 1 | 3.1s | N/A | ✅ revise→重提审；8 步 / 3 审批 / 30s；无 PLAN_PUBLISH |
| s03 混合扰动 | 两条独立单事件流程均 COMPLETED；流程 B 候选含插单工序；全程无 E_PLAN_STALE / E_VERSION_STALE | 24（2×12） | 2 | 23.5s | N/A | ✅ 但 1 次误操作（fjsp_publish 撞 E_PLAN_STALE）；39 步 / 15 审批 / 171s |

**s03 的 E_PLAN_STALE 候选链问题：在 workflow 方案下结构性不发生。** 口径差异：基线 Skill 方案由 agent 链式重排并直接发布中间版本（候选父链断裂 → E_PLAN_STALE）；workflow 方案是单事件流程，候选版本在人工评审前不发布，第二条流程的基准仍是已发布基线，不产生中间版本链。注意这不等于"合并评估两扰动"——两流程各自只处置单事件，合并评估属后续增强空间。

**s06 口径差异**：golden s06 的业务终态是候选版本被业务评审驳回为 REJECTED；workflow 方案的「审批拒绝」发生在 BFF 审批层（人工在审批卡片拒绝）→ 流程显式 TERMINATED、不执行发布，候选停留 REVIEW_PENDING 等待人工在业务侧处置。业务侧 REJECTED 状态机与发布守卫由回归脚本 s06 场景另行全覆盖（本次全过）。

## 3. 发现并修复（本次关口暴露的真实 bug）

- **`DEFAULT_STRATEGY` 权重键无法通过 fjsp-tools 客户端校验**（commit `6dbb205`）：`deltaPlan/machineChange` 被 fjsp-tools `WEIGHTS` schema 判为未定义字段（FJSP_INVALID_PARAMS，不发请求），扰动流程在真实工具面上必挂在 create-reschedule。修复：`WEIGHT_KEYS` 收窄为 fjsp-tools 可执行三键，`DEFAULT_STRATEGY` 改 `{weightedTardiness:0.4, makespan:0.3}`（deltaPlan/machineChange 由算法侧默认 0.2/0.1 补齐，等效 SeedService 重调度默认权重）；测试同步并新增「deltaPlan 建议落 fallback」用例。
- **遗留缺口（未修，建议在 fjsp-tools 侧跟进）**：fjsp-tools `WEIGHTS` schema 不透传 `deltaPlan/machineChange`，而 business+algorithm 均支持且 SeedService 默认权重含之——Agent 无法显式调节delta权重。属 fjsp-tools 契约面，按任务约束未动。
- 事件状态口径：事件被重调度消费后 `CONFIRMED → USED_FOR_SOLVE`（驱动断言已按此口径）。

## 3.1 修复轮 1（评审 Not approved：1 Critical + 1 Important + 1 Minor，同日修复重跑全过）

- **Critical：restart 故障注入失效（首轮结论作废重跑）**。原实现 `spawn(tsx,…)` + `child.kill('SIGKILL')` 只杀了 tsx CLI 包装进程，node 孙进程存活并与父进程的恢复运行并发双跑（修复前证据：检查点 17 步、尾部 5 节点 seq :1/:2 各一次、BFF 审批两条含一条孤儿 pending；`PLAN_SUBMIT_REVIEW 恰 1 次` 实为业务侧 409 兜底而非恢复路径功劳）。修复：子进程 `detached:true` 独立进程组 + `process.kill(-pid,'SIGKILL')` 整组歼灭；死亡三重实证（包装进程 exit 携 SIGKILL；ps 按 pgid 列举零存活进程——macOS 上 `kill(-pgid,0)` 在组刚消亡时偶发 EPERM 而非 ESRCH，实测后弃用该探测；kill 后 3s 检查点静默期零变化，排除孤儿继续推进）。新增断言：12 节点各执行恰一次、seq 全 1、poll-task attempt=2、BFF 审批登记恰 1 条且无孤儿 pending（直读 BFF 持久化文件）。重跑结果：全部通过，`steps=12`、`bffApprovalsRegistered=1`、`orphanPending=0`、`killVerified=true`（`restart.json`）。
- **Important：证据自证**。断言逐条落入归档 `.log`（PASS/FAIL 全量）+ 末尾 `RESULT failures=N exitCode=X`；任何断言失败进程即非零退出（本轮每模式 EXIT=0 已逐一核对）；`restart.json`/`timeout.json` 的 `taskCountDelta`/`eventCountDelta` 改为实测计算值（与断言共用同一变量），不再硬编码。
- **Minor：残留进程核实**。PID 66103/66112（`tsx server.mts`，10:28:40 启动）经查证监听 **4178**（演示 BFF 端口）、stdout 指向 `$TMPDIR/fjsp-demo/agent-bff.log`（演示 runtime 目录）——为演示环境组件（同时段演示侧 8081/8101/4177/4180 均在线），非本任务拉起（本任务 BFF 一律进程内 14184、随驱动退出），按约束不动。本任务进程经 `ps` 全量核查无残留。
- child-run 不再驻留（移除 `setInterval` 保活），流程跑完自然退出，从结构上消除孤儿来源。

## 4. 文件清单

- `<mode>.json`：结构化指标（终态/步骤数/介入点/耗时/KPI/断言失败数/实测 delta）
- `<mode>.log`：流程日志 + 每条断言 PASS/FAIL + 末尾 RESULT 行（failures 与退出码）
- `<mode>-checkpoint-wf-*.json`：终态检查点（含 completedSteps 业务证据）
- `regression-scenarios.log` / `scenario-results.jsonl`：回归环境 golden 场景全量输出
- 驱动源码：`../../../workflow/e2e-regression.mts`（随任务 3.5 提交）

## 5. 复现

```sh
export PATH="$HOME/.local/share/fnm/node-versions/v24.21.0/installation/bin:$PATH"
scripts/run-regression.sh --keep            # 若 18081 被占：FJSP_REG_BUSINESS_PORT=28081 scripts/run-regression.sh --keep
export FJSP_REG_BUSINESS_PORT=28081 EVIDENCE_DIR=$PWD/agh-integration/evidence/workflow-regression-2026-11-02 \
  FJSP_TSX=$PWD/agh-integration/agnes-harness/node_modules/.bin/tsx
cd agh-integration/workflow
for m in s01 s05 s06 s03 restart timeout stale; do ../agnes-harness/node_modules/.bin/tsx e2e-regression.mts $m; done
scripts/run-regression.sh --cleanup-only    # 收尾清理回归环境
```
