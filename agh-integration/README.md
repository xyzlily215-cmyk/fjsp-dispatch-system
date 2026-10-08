# FJSP × Agnes Harness（AGH）集成

比赛合规底座：作品以 AGH 为智能体运行底座，所有模型调用只走 Agnes 模型（ Agnes AI 网关 `openai-completions` 协议）。

## 目录结构

```
agh-integration/
├── agnes-harness/            # AGH 源码（已构建，入口 packages/cli/dist/local/agnes.mjs）
├── fjsp-tools/               # 后端工具插件（agnes.plugins 入口）
│   ├── package.json
│   └── index.mjs             # 14 个 fjsp_* 工具，HTTP 调业务服务
├── skills/fjsp-dispatch/SKILL.md   # 调度处置方法论 Skill（工程副本）
├── driver/fjsp-agent.mts     # 端到端验证驱动（SDK 直连 daemon，操作员角色程序化审批）
└── evidence/                 # 端到端验证运行证据（事件流 + 会话导出 + 最终答复）
```

## 启动 AGH

```sh
export PATH="$HOME/.local/share/fnm/node-versions/v24.21.0/installation/bin:$PATH"  # Node 24
cd agh-integration                              # 必须以此目录为 cwd（file:./ 插件源相对它解析）
nohup node agnes-harness/packages/cli/dist/local/agnes.mjs serve > /tmp/agh.log 2>&1 &
```

- Web 工作台：http://127.0.0.1:4177/ （默认端口，避开 8080/8081/8082/8100/8101）
- 共享 daemon，数据在 `~/.agh`（默认 home/profile=local-dev）
- 停止：`node agnes-harness/packages/cli/dist/local/agnes.mjs daemon stop`，再杀掉 serve 进程

## 模型配置（Agnes AI）

凭据在 `~/.config/fjsp/agnes.env`（不进仓库、不打印明文）。实测该 Key 是**中国区网关**（`https://api.agnes-ai.cn/v1`，AGH 内置 Agnes AI Provider 的默认地址）的 Key，且只授权了 **agnes-3.0-flash**；`agnes.env` 里的国际站 base URL / agnes-2.0-flash 对该 Key 不可用（401/403）。

配置方式（交互向导支持管道输入；Agnes AI 是列表第 12 项）：

```sh
set -a; source ~/.config/fjsp/agnes.env; set +a
printf 'Agnes\n12\n\n%s\n1\n' "$AGNES_API_KEY" | node agnes-harness/packages/cli/dist/local/agnes.mjs config
```

（依次为：账号名 / Provider=Agnes AI / Base URL 留空用默认 / API Key / 模型选 1 = agnes-3.0-flash。）
也可在 Web 工作台「Provider 设置」里完成同样配置。验证：`node .../agnes.mjs -p "你好，一句话介绍你自己"`。

## fjsp-tools 插件

无依赖单文件 ESM（`fjsp-tools/index.mjs`），`package.json` 的 `agnes.plugins` 声明 `export: fjspTools`、`inject: ['extension']`。所有写操作自动生成 `Idempotency-Key`；返回裁剪后的结构化 JSON（`{ok, ...}` / `{ok:false, error:{code,message}}`，业务错误码如 `E_EVENT_IN_PROCESS` 原样透传给 Agent）。

**认证**：业务服务自 P0 改造后所有接口需要 JWT。插件按优先级取凭据——`FJSP_AUTH_TOKEN` 直连；否则用 `FJSP_AUTH_USER`/`FJSP_AUTH_PASSWORD` 调 `/auth/login`（默认演示账号 admin/Fj@123456，与 `scripts/demo-common.sh` 一致），token 进程内缓存，401 时自动重登并重试一次。审计身份取登录用户（`X-Operator-Id` 头已不再被服务端信任，插件不再发送）。

每个请求自动带审计头 `X-Source: agh` 与 `X-AGH-Session-Id`（优先取 daemon 环境变量 `AGH_SESSION_ID`；插件运行在 daemon 进程内看不到驱动进程的 env，因此驱动 `driver/fjsp-agent.mts` 建会话后会把会话 ID 写入 `agh-integration/.agh-session-id` 作为兜底，已被 gitignore）。

### 审批策略（三级）

| 级别 | requiresApproval / replay | 工具 |
| --- | --- | --- |
| 只读 READ | `never` / `safe` | fjsp_get_dashboard、fjsp_list_machines、fjsp_task_status、fjsp_get_plan、fjsp_compare_plans |
| 普通写 WRITE | `always` / `idempotent` | fjsp_create_baseline、fjsp_report_breakdown、fjsp_insert_order、fjsp_reschedule、fjsp_submit_review、fjsp_revise_plan |
| 高风险 HIGH_RISK | `always` / `never` | fjsp_approve_review（评审决策）、fjsp_publish（发布上线） |
| 破坏性 DESTRUCTIVE | `always` / `never` | fjsp_reset_demo |

写操作和高风险操作每次都弹审批（`allowed-once`，不沉淀会话级放行）；评审与发布是两个独立的人工决策点。

### 发布流程（三段式人工确认）

`fjsp_submit_review`（DRAFT→REVIEW_PENDING）→ **Agent 停下，输出方案对比与 KPI，请人工查看** → `fjsp_approve_review`（REVIEW_PENDING→REVIEWED/REJECTED，REJECT 必填 comment）→ `fjsp_publish`（仅 REVIEWED→PUBLISHED 一步，状态不对返回 FJSP_INVALID_STATE 并提示正确流程）。

| 工具 | 说明 |
| --- | --- |
| fjsp_get_dashboard | 当前发布计划+KPI+订单统计+设备+最近事件/任务 |
| fjsp_list_machines | 设备列表 |
| fjsp_create_baseline(orderIds?, weights?, seed?) | 基线排程任务 |
| fjsp_report_breakdown(machineId, occurredAt, repairDurationMinutes, note?) | 设备故障事件 |
| fjsp_insert_order(orderCode, productFamily, quantity, arrivalAt, dueAt, priority, occurredAt, subType?) | 插单事件 |
| fjsp_reschedule(mode, eventId, oldPlanVersionId, weights?) | 局部/完全重调度 |
| fjsp_task_status(taskId, waitSeconds?) | 查任务；内置轮询等待（默认 60s），直接返回终态 |
| fjsp_get_plan(planVersionId?) | 版本详情（默认当前发布版），含乐观锁 version 与工序汇总 |
| fjsp_compare_plans(planVersionId, baselineVersionId) | 方案差异：变更统计+KPI 差值+变化工序明细 |
| fjsp_submit_review(planVersionId, version) | DRAFT→REVIEW_PENDING；必传乐观锁 version（先 fjsp_get_plan 获取） |
| fjsp_approve_review(planVersionId, decision?, comment?) | REVIEW_PENDING→REVIEWED/REJECTED；REJECT 必须填 comment；高风险人工决策点 |
| fjsp_revise_plan(planVersionId, version) | REJECTED→DRAFT 退回修改，之后可重新 submit-review |
| fjsp_publish(planVersionId) | 仅 REVIEWED→PUBLISHED 一步，不自动提交/审批；高风险 |
| fjsp_reset_demo() | 演示重置（破坏性） |

安装/更新（插件源必须是 `./` 开头、不含 `..` 的相对路径，相对 daemon 启动目录解析；install 的确认必须是真 TTY，用 `script` 伪终端 + 延时输入绕过）：

```sh
cd agh-integration
A="node agnes-harness/packages/cli/dist/local/agnes.mjs"
$A package inspect file:./fjsp-tools               # 拿到 integrity
(sleep 3; echo y; sleep 2) | script -q /dev/null $A install file:./fjsp-tools
$A package trust @fjsp/fjsp-tools <integrity> e3de4e5f2da4b8aa2650af5c4f822d397c2dadd7a6695e5071c0444d26a22b01
$A package enable @fjsp/fjsp-tools
$A package status                                  # 期望 desired=enabled actual=running trusted=true
```

注意：`package.json` 必须带白名单 license（MIT 等），否则 trust 被拒（E_PACKAGE_TRUST / 静默隔离）。改动插件代码后需 disable→remove→install→trust→enable 重走一遍（已安装快照不可变）。

## Skill：fjsp-dispatch

- 工程副本：`skills/fjsp-dispatch/SKILL.md`
- 安装位置：`~/.agh/skills/fjsp-dispatch/SKILL.md`（AGH_HOME/skills，root-key `user-agnes`，对所有工作区生效）

```sh
cp skills/fjsp-dispatch/SKILL.md ~/.agh/skills/fjsp-dispatch/SKILL.md
node agnes-harness/packages/cli/dist/local/agnes.mjs skills refresh --root-key user-agnes
node agnes-harness/packages/cli/dist/local/agnes.mjs resources list --kind skill   # 期望 trust=trusted desired=enabled actual=ready winner
```

内容：基线排程流程；扰动处置流程（看板确认 → 录事件 → LOCAL 重调度 → 轮询 → FEASIBLE/conflicts 校验 → 对比扰动 → 提交评审 → 停下请人工确认 → 评审通过 → 发布 → 中文处置报告）；E_EVENT_IN_PROCESS 识别与换时间重试；INFEASIBLE 读冲突明细改 FULL 重试；只用 fjsp_* 工具（不用 shell/文件工具）。

## 端到端验证（证据在 evidence/）

驱动脚本 `driver/fjsp-agent.mts` 通过 AGH Node SDK 直连本地 daemon：创建会话、发中文指令、以操作员身份程序化批准写工具审批（AGH 安全设计：读取 Skill/外部内容后当前 turn 被标记 taint，写操作必须经审批；CLI `-p` 无人值守模式会自动拒绝，所以用 SDK 驱动或 Web 界面人工点批准），并把全部账本事件落盘。

```sh
cd agh-integration/driver
../agnes-harness/node_modules/.bin/tsx fjsp-agent.mts "<指令>" <cwd> <事件输出.jsonl>
# 继续已有会话（多轮验证）：AGH_SESSION_ID=<sessionId> tsx fjsp-agent.mts ...
```

已验证（2026-10-02，会话证据见 evidence/）：

1. 「帮我为当前订单做一次基线排程并发布」→ dashboard → create_baseline → task_status（FEASIBLE）→ publish（审批通过）→ **PV-001 PUBLISHED**，输出 KPI 中文报告。
2. 「M-03 设备 2026-09-17 14:00 故障，预计维修 2 小时，帮我处理」→ skill_read(fjsp-dispatch) → dashboard → report_breakdown(EVT-001) → reschedule(LOCAL) → FEASIBLE → compare_plans → 报告「故障落在空闲窗口、零扰动、无需发布」。
3. 「对比最新的重调度方案和原计划…」（新会话）→ dashboard → get_plan×2 → compare_plans → 输出扰动率/拖期对比表，并主动指出 EVT-002 未消费、PV-002 未发布。

P0 审批语义验证（2026-10-03，证据 `evidence/agh-verify-p0*` 与 `session-verify-p0-approval.jsonl`）：

4. 「帮我做一次基线排程并提交评审」（新会话）→ fjsp_create_baseline 触发 `approval/asked risk=always`（批准后执行成功，TSK-003 FEASIBLE）；只读工具（skill_read/dashboard/task_status）无任何审批事件；fjsp_submit_review 再次触发审批；提交后 Agent **停下输出对比并请人工确认**（未自动连发 approve/publish）。
5. 续「方案我看过了，评审通过并发布」→ fjsp_approve_review 与 fjsp_publish **各自独立触发一次审批**，批准后 PV-003 REVIEW_PENDING→REVIEWED→PUBLISHED，PV-001 转 SUPERSEDED。

## 已知坑

- AGH 内置 Agnes AI Provider 只注册中国区网关；国际站 Key 与之不通用。
- 工具返回的 `structured` 含 `undefined` 字段会被 Host 判为非法 ToolResult（表现为 E_ENVELOPE / TOOL_OUTCOME_UNKNOWN）；所有输出先过一遍 JSON 序列化清洗。
- 工具 execute 抛异常 = 「may_have_sent」→ 写工具显示 TOOL_OUTCOME_UNKNOWN 但副作用可能已发生（幂等键保护重试）。
- `toolCall` 里读 Skill/外部内容会 taint 当前 turn，之后的写工具必须审批；无人值守的 `-p` 模式自动拒绝审批。
- 业务服务计划状态机是 DRAFT → REVIEW_PENDING → REVIEWED → PUBLISHED（不是 IN_REVIEW/APPROVED）。
- `fjsp_task_status` 已内置等待，不要让 Agent 用 shell sleep（shell 审批会失败并 taint）。
