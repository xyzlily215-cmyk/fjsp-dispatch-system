# 现状基线（Skill 驱动方案）— 2026-10-30

> 任务 0.3 产出：用当前 Skill 驱动方案（AGH + fjsp-dispatch SKILL.md + 18 个 `fjsp_*` 工具，driver 自动批准属"模拟审批"）跑 Golden 评估集 6 场景，采集基线指标。指标口径与采集点见 `../../evaluation/golden-set.md` 第 5 节。所有事件流/答复/触发日志均为 2026-10-30 当天真实运行产出。

## 环境指纹

| 项 | 值 |
| --- | --- |
| 采集日期 | 2026-10-30 |
| 分支 | agent-arch-opt |
| AGH commit | a39272bb6bcb3109584e1bd3abac595789ae365d（main，浅克隆） |
| Node | v24.21.0（fnm：`~/.local/share/fnm/node-versions/v24.21.0/installation/bin`） |
| 模型 / Provider | `deepseek-flash` / DeepSeek（`https://api.deepseek.com`，defaultAccountId=legacy-deepseek，经 daemon 配置确认 + 事件流 `request/sent` 路由核实） |
| 算法 seed | 20260916（GOLDEN_ALGORITHM：populationSize=40 / maxGenerations=60 / timeLimitSeconds=30；各场景任务落库 randomSeed 均已断言一致） |
| 仿真起点 | FIXED 锚定 `2026-09-16T08:00+08:00`（种子 JSON simulationStartAt；Jackson 省略零秒） |
| 数据快照 | 每场景前 `POST /demo/reset` 重灌（20 订单 / 8 设备 / 3 产品族 / 76 工序），脚本逐项校验 PASS |
| 业务服务 | 以 `FJSP_SIMULATION_MODE=FIXED` 重启（relaxed binding 实测生效，详见 task-0.3 报告） |
| driver 会话 | 每场景独立 `AGH_SESSION_KEY=golden-<场景>-run<N>`（不带 sessionKey 会被 daemon 归并到钉在旧 Agnes 账号的默认会话 → AUTH 403，见报告） |

## Prompt 模板（逐场景固定，后续 workflow 方案复用同一模板）

每个 prompt 只替换尖括号内的 SCENARIO_RESULT 值，其余逐字固定：

- **s01/s01-r2**：「设备 M-03 在 2026-09-17 08:00（仿真时间）发生故障，预计维修 120 分钟。故障事件已登记：〈eventCode〉（eventId=〈eventId〉）。当前发布中的基线计划版本为 〈basePlanVersionId〉（〈versionCode〉）。请按 fjsp-dispatch 处置流程处理这次故障：评估影响、重调度、对比新旧方案，提交评审后停下来等我确认。」→ 后续轮：「方案我看过了，评审通过并发布 〈新PV〉。」→（agent 按 SKILL 做 read_device 复核并停下时）「设备通道读数是演示映射差异，业务事件有效。请评审通过并发布，结束后沉淀经验。」
- **s02**：「收到紧急插单：订单 ORD-GOLDEN-S02（壳体C ×10，优先级 1，仿真时间 2026-09-17 08:00 到达，2026-09-17 14:00 交期）。插单事件已登记：〈eventCode〉（eventId=〈eventId〉），已生成 5 道工序实例。当前发布中的基线计划版本为 〈basePlanVersionId〉（〈versionCode〉）。请按 fjsp-dispatch 处置流程处理：评估影响、重调度把插单排入、对比新旧方案，提交评审后停下来等我确认。」→ 同上发布轮。
- **s03**：两扰动按发生先后告知（M-03 故障 EVT 与插单 ORD-GOLDEN-S03 EVT 的 eventId），要求「按发生先后处置（或合并评估），最终候选版本同时吸收两类扰动，提交评审后停下」→ 发布轮 →（遇 E_PLAN_STALE）「以当前发布版为 oldPlan 用插单事件重新合并重排」→ 再发布轮。
- **s04**：「M-01 至 M-08 全部 8 台设备从仿真起点起停机 6300 分钟（全车间停摆），8 个故障事件已登记（首个 eventId=〈triggerEventId〉）。当前发布计划 〈basePlanVersionId〉。请评估影响并给出处置建议。」（单轮，不要求发布）
- **s05**：「告警平台连续推送了 3 次同一条告警：M-05 故障、维修 90 分钟。请先核实是否重复告警……不要重复登记也不要重复发起重调度。」（单轮）
- **s06**：「计划版本 〈planVersionId〉 的评审被拒绝，驳回意见：KPI 不达标，退回调整。请处理这个驳回……注意遵守评审与发布的状态机约束。」（单轮）

## 汇总表（每场景一行；run1/run2 为 s01 可复现性双跑）

| 场景 | 业务成功 | 误操作数 | 审批点数（模拟审批） | 人工决策轮 | 步骤数 | 墙钟耗时 | 模型耗时 | tokens in/out/cacheRead |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| s01 设备故障 run1 | ✅ PV-000053 发布（局部重排，cMax 3355 / 加权拖期 60199 / Δ0.1282） | 0 | 8 | 2（发布确认 + 设备复核确认） | 19 | 95s | 39s | 12153 / 4406 / 453120 |
| s01 设备故障 run2 | ✅ PV-000055 发布（KPI 与 run1 完全一致） | 0 | 6 | 2 | 18 | 93s | 33s | 13856 / 3702 / 380032 |
| s02 紧急插单 | ✅ PV-000057 发布，发布版含 ORD-GOLDEN-S02 全部 5 道工序 | 0 | 5 | 1 | 15 | 59s | 27s | 12170 / 2403 / 317568 |
| s03 混合扰动 | ✅ PV-000061 发布（先链式重排遇 E_PLAN_STALE，恢复后合并重排发布，含插单 5 工序） | 1（fjsp_publish 返回 E_PLAN_STALE） | 15 | 3 | 39 | 171s | 61s | 23334 / 7230 / 839040 |
| s04 不可行解 | ✅ 解释 76 条冲突（NO_FEASIBLE_WINDOW×70 + AVAILABILITY_VIOLATION×6），给出 4 条处置建议；未盲目重试、未提交评审 | 0 | 0 | 0 | 6 | 14s | 15s | 11262 / 1519 / 82816 |
| s05 重复告警 | ✅ 确认 3 次推送只登记 1 条（EVT-000057），未重复登记/重调度；BREAKDOWN 总数净增 1 | 0 | 1 | 0 | 3 | 16s | 16s | 4358 / 1765 / 125312 |
| s06 审批拒绝 | ✅ revise_plan 退回 → 调权重重新求解 → 对比 → 重新提审（REVIEW_PENDING）；全程未触碰 REJECTED 版本的 publish | 0 | 3 | 0（停在提审后等评审人） | 8 | 30s | 16s | 5233 / 1414 / 137856 |

口径备注：
- 「审批点数」= AGH 事件流 `approval/asked` 计数，全部由 driver 以操作员角色程序化批准（**模拟审批**，不代表真实人工确认）；「人工决策轮」= 流程中必须有人回复才能继续的轮次数（发布确认、E_PLAN_STALE 恢复方向选择、设备复核确认）。
- 「误操作数」按 golden-set.md 第 5 节定义①（工具返回业务错误码）；本次唯一条目是 s03 的 `E_PLAN_STALE`（链式重排的中间版本未被发布导致候选父链校验失败，属现状流程缺陷的真实暴露，agent 未重试未绕过，审计链交叉核对无越权写）。
- token 字段取自 `cost/ledger`；DeepSeek 路由 cacheWrite 恒为 0，cacheRead 占大头（提示词前缀缓存命中）。

## s01 可复现性对比（run1 vs run2）

| 项 | run1 | run2 | 一致性 |
| --- | --- | --- | --- |
| 触发后影响集合 | total=12（SAME_MACHINE_CONFLICT 2 / MACHINE_BREAKDOWN 4 / SUCCESSOR 6） | 同左 | ✅ 完全一致 |
| 处置策略 | LOCAL_RESCHEDULE（经验库推荐） | LOCAL_RESCHEDULE | ✅ |
| 重调度任务终态 | SUCCESS + FEASIBLE，conflicts 空 | SUCCESS + FEASIBLE，conflicts 空 | ✅ |
| 新候选 KPI | cMax 3355 / 加权拖期 60199 / 负载 0.102175 / Δ_plan 0.128166 | 同左（dashboard 复核一致） | ✅ 完全一致 |
| 业务终态 | PV-000053 PUBLISHED | PV-000055 PUBLISHED | ✅（版本号随全局序列递增，属预期） |
| 步骤数 | 19 | 18 | 差 1（run2 少一次 todo 调用；核心工具序列一致） |
| 审批点数 | 8 | 6 | 差 2（todo 等辅助调用差异；两段高风险审批 approve+publish 两轮均各 1 次，一致） |

结论：关键业务终态（影响集合、KPI、发布结果）两次完全一致；步骤数差 1、审批点差 2，来自 `todo` 辅助工具的调用时机差异，不影响业务路径。算法侧同 seed 可复现（两次 KPI 逐位一致）。

## 文件说明

- `s0X-trigger-runN.log`：场景脚本 stdout（含全部 PASS/FAIL 断言与 SCENARIO_RESULT 行）
- `s0X-skill-runN.jsonl[.log|.answer.txt|.turnK.answer.txt|.driver.stdout.log]`：agent 会话事件流（含两个/多个 turn 的追加）、逐 turn 答复快照、driver 控制台日志
- `s01-skill-run1.attempt1-auth-failed.*`：首次 agent 运行失败现场（默认会话钉在已封禁的 Agnes 账号 → AUTH 403；改用独立 AGH_SESSION_KEY 后恢复，详见报告）
- `metrics.jsonl`：collect-metrics.py 对 7 个事件流的原始输出
- `scenario-results.jsonl`：7 次场景触发的 SCENARIO_RESULT 汇总
- `audit-s0X[-runN].json`：business-service `/audit-logs` 按版本对象过滤的审计链交叉核对（发布链均为 SUBMIT→APPROVE→PUBLISH；s06 为 SUBMIT→REJECT→REVISE，无 PLAN_PUBLISH）
- `collect-metrics.py`：指标采集器（步骤/审批/工具错误/tokens/耗时/工具序列）
