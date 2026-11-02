# P4 评估对照报告：Skill 驱动基线 vs workflow 方案 — 2026-11-02

> 任务 5.3 产出。对照双方：
> - **基线（现状 Skill 驱动）**：`baseline-2026-10-30/BASELINE.md`（AGH + fjsp-dispatch SKILL.md + fjsp_* 工具，driver 模拟审批，DeepSeek 真实 LLM，2026-10-30 采集）。
> - **workflow 方案**：`workflow-regression-2026-11-02/RECOVERY.md`（任务 3.5，workflow/runner + disturbance-flow 驱动，真实 fjsp-tools HTTP + 真实 BFF 审批，2026-11-02 采集；**agent 决策节点不接 LLM，走确定性兜底**）。
>
> 两侧均跑 golden 评估集子集：workflow 侧复测了 s01 / s03 / s05 / s06（s02、s04 未复测，不参与逐项对照）。算法 seed、仿真锚点、数据快照口径两侧一致（FIXED + seed 20260916 + 每场景前复位重灌）。

## 一、六指标逐项对照

| 场景 | 业务成功 | 误操作数 | 人工介入 | 步骤数 | 墙钟耗时 | tokens |
| --- | --- | --- | --- | --- | --- | --- |
| s01 设备故障 · 基线 | ✅ 发布 PV-000053 | 0 | 8 审批点（模拟）+ 2 人工决策轮 | 19 | 95s | 12153 in / 4406 out / 453120 cacheRead |
| s01 设备故障 · workflow | ✅ COMPLETED，候选 REVIEW_PENDING | 0 | 1（BFF 真实审批） | 12 | 3.1s | N/A |
| s03 混合扰动 · 基线 | ✅ 发布 PV-000061 | **1**（fjsp_publish 撞 E_PLAN_STALE） | 15 审批点（模拟）+ 3 人工决策轮 | 39 | 171s | 23334 in / 7230 out / 839040 cacheRead |
| s03 混合扰动 · workflow | ✅ 两条单事件流程均 COMPLETED | **0** | 2（BFF 真实审批） | 24（2×12） | 23.5s | N/A |
| s05 重复告警 · 基线 | ✅ 只登记 1 条，未重复重调度 | 0 | 1 审批点（模拟） | 3 | 16s | 4358 in / 1765 out / 125312 cacheRead |
| s05 重复告警 · workflow | ✅ COMPLETED，重复触发去重、无第二次写入 | 0 | 1（BFF 真实审批） | 12 | 3.2s | N/A |
| s06 审批拒绝 · 基线 | ✅ revise → 调权重重解 → 重提审 REVIEW_PENDING | 0 | 3 审批点（模拟） | 8 | 30s | 5233 in / 1414 out / 137856 cacheRead |
| s06 审批拒绝 · workflow | ✅ TERMINATED（BFF 审批拒绝），候选停留 REVIEW_PENDING，publish 被 409 拦截，审计无 PLAN_PUBLISH | 0 | 1（BFF 真实审批） | 12 | 3.1s | N/A |

汇总观察（仅限已对照的 4 个场景）：

- **业务成功率**：两侧 4/4 全部成功（按各自终态口径），无退化。
- **误操作数**：基线 s03 有 1 次（E_PLAN_STALE），workflow 侧 0 —— 该误操作被结构性消除（见第二节）。
- **人工介入率**：口径不同（基线=driver 模拟审批点数，workflow=BFF 真实审批登记次数），不可直接比大小；可比的结论是 workflow 把审批收敛为每个流程恰 1 个挂起决策点，而基线 s01/s03 的审批点数（8/15）含大量辅助工具调用的模拟审批噪声。
- **步骤数**：口径不同（基线=AGH 事件流工具调用数，workflow=12 节点流程完成数），仅作流程复杂度参考。
- **耗时**：workflow 快一个数量级（3.1–23.5s vs 16–171s），但主因是 workflow 侧无 LLM 推理（基线模型耗时占 15–61s），不能全部归功于架构。
- **tokens**：workflow 侧 N/A，见下。

## 二、关键发现

1. **s03 的 E_PLAN_STALE 在 workflow 方案下结构性消除。** 基线由 agent 链式重排并直接发布中间版本，候选父链断裂导致 fjsp_publish 返回 E_PLAN_STALE（1 次误操作 + 1 轮人工恢复决策）；workflow 方案候选版本在人工评审前不发布，第二条流程的基准仍是已发布基线，不产生中间版本链，全程无 E_PLAN_STALE / E_VERSION_STALE。**注意边界**：这不等于"合并评估两扰动"——workflow 两条流程各自只处置单事件，合并评估属后续增强空间。
2. **s01 KPI 逐位一致。** workflow 候选（cMax 3355 / 加权拖期 60199 / 负载 0.102175 / Δ_plan 0.128166）与基线两次运行完全一致，说明 workflow 编排未改变算法结果与业务语义（同 seed、同权重、同工具面）。
3. **s06 拒绝路径的落点不同但都安全。** 基线在业务评审层被拒后 revise→重提审；workflow 在 BFF 审批层被拒后显式 TERMINATED、候选停留 REVIEW_PENDING、发布守卫 409 拦截、审计无 PLAN_PUBLISH。两侧均未发生越权发布。
4. **workflow 侧 tokens 为 N/A（显式披露）。** 原因：任务 3.5 的 agent 决策节点不注入真实 LLM，策略/解释/评审材料全部走 DEFAULT_STRATEGY 与确定性兜底，无 token 消耗可计。**补齐路径**：driver 参数化（模型/提供方可配）后接真实 LLM 复测同一评估集，token 指标方能与基线同口径对照；在此之前，本报告不做任何成本优劣结论。

## 三、指标口径差异（如实说明，不夸大结论）

- **单事件流程 vs 混合扰动链**：workflow 的 s03 拆成两条独立单事件流程（24 步），基线是一条混合扰动处置链（39 步）；两者业务覆盖不完全等价（基线最终候选同时吸收两类扰动，workflow 是顺序各自吸收）。
- **业务终态不同**：基线含 approve+publish 走到 PUBLISHED；workflow 方案发布不在流程内，终态停在 REVIEW_PENDING（s06 为 TERMINATED）。「业务成功」按各自流程的目标终态判定。
- **审批口径不同**：基线审批点数是 driver 程序化批准的模拟审批计数，不代表真实人工确认；workflow 是 BFF 持久化的真实审批登记。基线的「人工决策轮」（必须有人回复才能继续的轮次）与 workflow 的挂起审批点在语义上最接近，可作粗对照：s01 2→1、s03 3→2、s05 0→1、s06 0→1（workflow 每流程恰 1 个固定挂起点，含原本零决策轮的场景，这是流程显式挂起设计的代价而非退化）。
- **耗时不可全归因于架构**：workflow 侧无 LLM 推理与网络往返（BFF 进程内 14184），基线含真实模型调用；耗时差异只能作为上限参考。
- **s02 / s04 未在 workflow 侧复测**，本报告不对这两场景下任何结论。

## 四、结论

在已对照的 4 个场景上，workflow 方案保持业务成功率 4/4、误操作 1→0（s03 的 E_PLAN_STALE 结构性消除）、算法结果逐位一致，人工审批收敛为每流程 1 个显式挂起点；token 成本因降级运行记 N/A，待 driver 参数化接真实 LLM 后复测补齐。口径差异已逐条列明，上述结论不外推到未复测场景与未测量的成本维度。
