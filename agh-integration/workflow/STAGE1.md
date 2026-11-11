# 阶段 1：扰动策略输入与权重契约

## 范围

已实现只读数据接线与契约测试，不调用真实模型、不新增 Web Workflow 启动入口，不改变审批与发布机制。当前聊天仍走 AGH；独立 Workflow 由调用方注入 tools/agent。

## 数据链路

`receive-event → register-event → load-context → query-experience → suggest-strategy → validate-strategy → create-reschedule → ...`

新增 `fjsp_get_disturbance_context(eventId, planVersionId, freezeWindowMinutes?)`：

- GET `/events/{eventId}`：已登记事件与 impact 明细；
- GET `/events/{eventId}/reschedule-preview?planVersionId=...`：冻结窗口、硬/软锁计数、影响分类、受影响订单 ID、两种模式规模估算；
- GET `/dashboard?planVersionId=...`：固定原计划 KPI（不隐式换成最新发布计划）；
- GET `/orders`：按真实 orderId 关联受影响订单，不解析工序编号。

返回 `context.schemaVersion=1`，包含 event、baselinePlan、constraints、affectedOrders、deadlinePressure、provenance、readAt 和 limitations。数据缺失、版本不匹配或上游报错返回失败 envelope，不伪造零值。只有只读 GET；沿用插件身份与错误分类。工具总数由 20 变为 21（10 只读、8 普通写、2 高风险、1 破坏性）。

交期压力：`minutesToDueAtEvent=(dueAt-event.occurredAt)/60000`。负数表示事件发生时已过交期，不代表方案预计拖期。24 小时是摘要展示阈值，不是生产硬约束；priority=5 最高。历史 KPI 是该版本求解时指标，不是实时执行预测。

## 估算边界

- hard/soft 是原计划分类，impactedOperationCount 还可能包含硬锁工序与计划外工序，三者不能相加。
- 登记 impacts.lockType 是事件登记时快照，预览的锁定统计按查询时执行记录重新计算。
- 预览将全部 persisted impacts 视为 affected，SnapshotBuilder 排除登记为 HARD_LOCKED 的影响项；因此规模与分类不保证完全一致。
- 实际快照还纳入全部 WAITING 订单，而当前受影响订单仅来自本事件。
- 多次 GET 不是数据库事务快照；求解、落库与发布仍由业务服务重新校验。

## 按模式区分权重

| 模式 | 有效键与缺省值 |
| --- | --- |
| BASELINE | makespan=.4、weightedTardiness=.4、loadImbalance=.2 |
| LOCAL/FULL_RESCHEDULE | weightedTardiness=.4、makespan=.3、deltaPlan=.2、machineChange=.1 |

共享 `fjsp-tools/objective-weights.mjs` 定义 JS/TS 侧键与默认值，依据算法 `ga.resolve_objective_weights`。工具入参拒绝无效模式目标、负数、NaN/Infinity、未知键。合法策略建议会显式补齐四个重调度默认键，保留显式 0，不归一化。experience_record 同属重调度经验，使用四目标 schema。历史记录只读兼容，不自动修改 JSONL。

`load-context` 返回的 freezeWindowMinutes 透传至 LOCAL 任务及至多一次 FULL 重试（包括 0），避免预览/求解冻结窗口不一致。工具也支持显式覆盖冻结窗口（0..1440），不修改原有调用的默认行为。

## 测试（无需服务/模型/演示库）

```sh
node agh-integration/fjsp-tools/test-contract.mjs
node agh-integration/fjsp-tools/test-disturbance-context.mjs
# 使用本地已安装的 tsx，不需要再次下载依赖
npx --no-install tsx agh-integration/workflow/test-disturbance-flow.mts
npx --no-install tsx agh-integration/workflow/test-baseline-flow.mts
npx --no-install tsx agh-integration/workflow/test-bff-approval.mts
```

其余 workflow/test-*.mts 一并回归。上下文测试 mock 的是 HTTP 包络，执行的是真实插件代码；工作流测试 mock 工具与 agent，只证明输入/顺序/异常/幂等传参与审批边界未退化，不证明真实模型效果或真实业务端到端闭环。

本次结果：工具主契约与新增上下文测试通过；7 组 Workflow 脚本通过（扰动14、基线7、审批桥6、评审发布6、运行器6组场景，检查点与恢复各全量断言）；BFF/MCP 审批安全测试15组通过。新 agent-nodes/context-fixture 独立类型检查通过。扩展 tsc 检查仍有7处既有错误：baseline-flow 的 unknown reduce、disturbance-flow 登记节点两处 Record 强转、recovery 三处 unknown→string、runner 可选 awaitApproval 参数。tsx 执行不做完整静态类型检查，不能把运行回归通过描述成整个目录 tsc 通过。

## 兼容与后续

- 旧 loadImbalance 重调度调用现在明确报非法参数，而不是被算法静默忽略；BASELINE 仍允许它。
- 新节点会影响旧未完成 Workflow 的节点序列；上线恢复 worker 前需给旧实例做版本化迁移或终止后重新建立实例，不能盲目续跑。
- 插件新增了两个相对模块，部署/重装时必须整体复制 fjsp-tools 目录，不能仅复制 index.mjs。
- 不保证只读上下文在长期审批后仍新鲜；后续运行管理与授权阶段负责现态重核对及批准参数绑定。
- 下一阶段才实现真实模型适配器、模型输出来源标识与调用预算，不自动进入该阶段。
