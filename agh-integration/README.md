# FJSP × Agnes Harness（AGH）集成

比赛合规底座：作品以 AGH 为智能体运行底座，所有模型调用只走 Agnes 模型（ Agnes AI 网关 `openai-completions` 协议）。

## 目录结构

```
agh-integration/
├── agnes-harness/            # 可选 AGH 源码（未随本仓库分发，构建后入口 packages/cli/dist/local/agnes.mjs）
├── fjsp-tools/               # 后端工具插件（agnes.plugins 入口）
│   ├── package.json
│   └── index.mjs             # 16 个 fjsp_* 工具，HTTP 调业务服务（含 RSI 经验库 query/record）
├── mhs-devices/              # MHS 虚拟设备（agnes_mhs Python 库）
│   └── machine-m03.py        # CNC 机床 M-01~M-08 + AGV-01（workshop 地图：分区 + grid 平面图 + 位姿）：温度/振动 + 面板画面（image）+ 故障注入（SIGUSR1/SIGUSR2）
├── skills/fjsp-dispatch/SKILL.md   # 调度处置方法论 Skill（工程副本，含 MHS 告警处置流程）
├── driver/fjsp-agent.mts     # 端到端验证驱动（SDK 直连 daemon，操作员角色程序化审批）
├── driver/fjsp-watch.mts     # MHS 值守驱动：附着已有会话，等 watch_device 唤醒并审批
└── evidence/                 # 端到端验证运行证据（事件流 + 会话导出 + 最终答复）
```

## 启动 AGH

AGH 为可选组件，默认本地部署不启动；本仓库未跟踪 `agnes-harness/`，从零克隆需自行准备对应 AGH 源码并构建 CLI（`agh-integration/agnes-harness/packages/cli/dist/local/agnes.mjs`），再用 `FJSP_START_AGH=1 ./scripts/start-demo.sh` 启用。启用后脚本会自动选择 Node ≥24（fnm 目录）、显式拉起 daemon（绕过 serve 自动拉起的稳定性问题）、带 `AGNES_HUB_ORIGIN` 启动 serve，并启动 MHS 设备 machine-m03；`scripts/stop-demo.sh` 会对应全部停止。

手动方式（排障时）：

```sh
export PATH="$HOME/.local/share/fnm/node-versions/v24.21.0/installation/bin:$PATH"  # Node ≥ 24.10
cd agh-integration                              # 必须以此目录为 cwd（file:./ 插件源相对它解析）
nohup node agnes-harness/packages/cli/dist/local/daemon.mjs --profile local-dev \
  --workspace "$PWD" --data-dir ~/.agh/data \
  --local-web-addr 127.0.0.1:0 --local-web-origin http://127.0.0.1:4177 > /tmp/agh-daemon.log 2>&1 &
AGNES_HUB_ORIGIN=http://127.0.0.1:4180 \
  nohup node agnes-harness/packages/cli/dist/local/agnes.mjs serve > /tmp/agh.log 2>&1 &
```

- Web 工作台：http://127.0.0.1:4177/ （默认端口，避开 8080/8081/8082/8100/8101）
- 共享 daemon，数据在 `~/.agh`（默认 home/profile=local-dev）
- 停止：`node agnes-harness/packages/cli/dist/local/agnes.mjs daemon stop`，再杀掉 serve 进程

## 模型配置（Agnes AI）

凭据在 `~/.config/fjsp/agnes.env`（不打印明文）。**本提交包已随附评审专用 Key**：`agh-integration/agnes.env`，评审方执行 `mkdir -p ~/.config/fjsp && cp agh-integration/agnes.env ~/.config/fjsp/agnes.env` 即可，无需自备 Key。实测该 Key 是**中国区网关**（`https://api.agnes-ai.cn/v1`，AGH 内置 Agnes AI Provider 的默认地址）的 Key，且只授权了 **agnes-3.0-flash**；`agnes.env` 里的国际站 base URL / agnes-2.0-flash 对该 Key 不可用（401/403）。

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
| 只读 READ | `never` / `safe` | fjsp_get_dashboard、fjsp_list_machines、fjsp_task_status、fjsp_get_plan、fjsp_compare_plans、fjsp_experience_query |
| 普通写 WRITE | `always` / `idempotent` | fjsp_create_baseline、fjsp_report_breakdown、fjsp_insert_order、fjsp_reschedule、fjsp_submit_review、fjsp_revise_plan、fjsp_experience_record |
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
| fjsp_experience_query(eventType?, limit?) | 查询处置经验库：同类事件历史模式/权重/KPI 结果 + 推荐策略（recommendation） |
| fjsp_experience_record(eventType, mode, ...) | 处置结束沉淀经验：模式/权重/resultStatus/kpiDiff/是否发布/备注 |
| fjsp_get_gantt_link(planVersionId?) | 计划版本的甘特图链接（前端 `?planVersion=` 直开；fjsp_task_status 成功与 fjsp_publish 发布时也会附带 ganttUrl）。前端地址取 `FJSP_WEB_BASE`（`scripts/demo-common.sh` 已按演示端口自动推导） |
| fjsp_get_workpiece_position(orderRef) | 工件实时位置：当前在哪台设备加工、已完成/剩余工序数、进度与下一道安排（orderRef 支持订单号或内部 id；数据来自 `GET /orders/{orderRef}/position`） |
| fjsp_reset_demo() | 演示重置（破坏性） |

### RSI 经验闭环（2026-10-13 上线）

对应官方案例分享的递归自我改进（RSI）：`fjsp_experience_query/record` 两个工具 + skill 第 3/9 步构成「处置 → 沉淀经验 → 改进后续处置」闭环。经验库是仅追加的 JSONL，默认在 `~/.agh/fjsp-experience.jsonl`（可用 `FJSP_EXPERIENCE_FILE` 覆盖）。**不要**把经验库放在插件目录下：插件从运行时快照执行，写文件会污染快照树导致下次启动 `E_PACKAGE_INTEGRITY: runtime snapshot store requires recovery`（恢复办法：删掉快照目录里多出的文件后重启 daemon）。

端到端证据（`evidence/agh-rsi-*.jsonl/html`）：run1 M-03 故障处置（经验库为空 → 默认 LOCAL 试错 INFEASIBLE → FULL 成功 → 发布 → 记录经验）；run2 M-05 同类故障（经验推荐 FULL → 直接命中，跳过 LOCAL 试错，并在答复中引用历史依据）。

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

内容：基线排程流程；扰动处置流程（看板确认 → 录事件 → **查处置经验** → 重调度 → 轮询 → FEASIBLE/conflicts 校验 → 对比扰动 → 提交评审 → 停下请人工确认 → 评审通过 → 发布 → **沉淀经验** → 中文处置报告）；MHS 告警扰动发布前须 `read_device` 复核设备真实状态；E_EVENT_IN_PROCESS 识别与换时间重试；INFEASIBLE 读冲突明细改 FULL 重试；只用 fjsp_* 工具（不用 shell/文件工具）。

## MHS 设备接入（2026-10-10 上线）

车间设备经 MHS（Model Hardware Standard）接入 AGH 内置的 AgnesHub，扰动由设备通道自动暴露，Agent 被唤醒后仍走 fjsp-dispatch 处置流程与 fjsp_* 审批链。

- **虚拟机床设备**：`mhs-devices/machine-m03.py`（Python，`agnes_mhs` 库）。默认只起 M-03；`machine-m03.py <hub-url> M-01 M-02 ... M-08 AGV-01` 一次拉起整个车间（与业务系统设备清单 M-01~M-08 对齐，`scripts/start-demo.sh` 用 `FJSP_MHS_MACHINES` 控制）。每台机床：状态（status/current_job/spindle_load）+ metrics 数据源（温度/振动/转速，2 Hz）+ panel 画面数据源（image，1 Hz JPEG，状态灯 + 温度曲线 + 负载条，由 Pillow 实时渲染，Hub 订阅才推流；工作台 Devices 面板直接显示，对应火星基地案例的相机画面）。车间地图（对应火星基地案例的世界地图）：机床声明 `placement` + `localization="fixed"`（**两者必须成对**，否则 Hub 不算位置、World 页 0 台设备），两排各 4 台面对面朝向中间通道（yaw 90/270）；地图 places 用多边形分区（上料区/加工区/检验区，Hub 自动标注设备所在 zone）；每台机床还带一份 grid 数据源（PNG 灰度平面图：外墙 + 分区隔墙 + 出入口，World 页取一台的作为地面底图）。追加 `AGV-01` 可起一台 AGV 搬运车（`localization="self"` + pose 源 5 Hz），沿中间通道在上料区/检验区之间往返。故障注入（仅 M-03）：`kill -USR1 <pid>` 或 `touch /tmp/m03-fault`；恢复：`kill -USR2 <pid>`。
- **运行**：`python3 -m venv mhs-devices/.venv && mhs-devices/.venv/bin/pip install jsonschema websockets pillow`，然后
  ```sh
  R=agh-integration 的绝对路径
  PYTHONPATH=$R/agnes-harness/packages/mhs/python/src nohup \
    $R/mhs-devices/.venv/bin/python $R/mhs-devices/machine-m03.py ws://127.0.0.1:4180 > /tmp/m03.log 2>&1 &
  ```
- **一致性检查**：`PYTHONPATH=.../src .venv/bin/python -m agnes_mhs.check --profile core,perception,streaming,maps --no-motion`，设备指向 `ws://127.0.0.1:8800`。本设备 37 pass / 17 skip / 0 fail / 0 warn（另有 1 manual：MAP-2 同名地图坐标系一致性需人工确认；证据 `evidence/mhs-check-machine-m03.json`）。注意 field 的 unit 必须取规范枚举（°C、% 等），自定义单位用 `x_` 前缀；image 数据源要同时声明 `fov_deg` 和 `mount`，否则 PER-2 报 warn；地图 places 必须带 `id` + `at`（landmark）或 `points`（zone），不能写 `{name,x,y}`（REG-1/MAP-1 fail）；pose/grid 数据源必须声明 `model`（`{name, version}`），否则注册被拒（`/sources/N: Expected union value`）。
- **AgnesHub 插件**：`pnpm --filter @agnes/mhs build:plugin` 后按 fjsp-tools 同流程 install/trust/enable（插件源写 `file:./agnes-harness/packages/mhs/plugin`，相对 daemon workspace 解析；trust 第三参 capabilityHash 用 `packages/package-manager/src/integrity.ts` 的 `capabilityHash()` 对锁文件 contributions 计算，integrity 参数要带 `sha256-` 前缀）。Hub 默认监听 `127.0.0.1:4180`；serve 需带 `AGNES_HUB_ORIGIN=http://127.0.0.1:4180` 启动，工作台右侧才有 Devices 面板。
- **端到端证据**（`evidence/agh-mhs-m03-*`）：值守会话 `watch_device`（until 为 metrics.temperature>85 与 status=down 两个条件）→ 注入故障 → 温度 85.16°C 触发唤醒 → read_device 确认 → report_breakdown（撞 EVT-000024 维修区间返回 E_DUPLICATE，Agent 按纪律停下给出 A/B/C 人工选项）→ 人工选 A → FULL_RESCHEDULE（审批）→ TSK-000035 FEASIBLE（PV-000034）→ compare_plans → submit_review（审批）→ 停在 REVIEW_PENDING 等人工。

### MHS 已知坑

- **`watch_device` 的 until 不要只写 `{"health":"bad"}`**：health 监视不在 Hub 侧促成数据源拉流（demand 只来自订阅、source/field 条件监视、read 和 pose），设备读数不上报时 health 恒为 ok，监视永不触发。要写成 `{"source":"metrics","field":"temperature","gte":85}`（会为该源建立拉流需求）或 `{"state":"status","eq":"down"}`（状态推送无此问题）。
- 设备库的 `source.send()` 受 `wants()` 门控，Hub 未拉流时数据发不出去，"设备主动推流"不成立。
- CLI 偶发 `daemon child exited before readiness` / `DAEMON_CONNECTION_CLOSED`（SDK 直连始终正常）：kill daemon+serve 后按手动方式重启即可恢复。

## 端到端验证（证据在 evidence/）

会话事件流（.jsonl）可用 `node scripts/render-trace.mjs <events.jsonl>` 渲染成单文件 HTML 时间线（工具调用 / 审批 / 结果按时间排列，用于演示与提交材料）。

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
- AGH 需要 Node ≥ 24.10（node:sqlite setAuthorizer），低版本 node 起 daemon 报 `E_SEAM_INIT`；`scripts/start-demo.sh` 的 `ensure_node24` 会自动从 fnm 目录挑 ≥24 的版本。
- 上游镜像 `mirror.ghproxy.com` 已失效（2026-10-10）；本仓库 origin 已改指 `https://ghfast.top/https://github.com/AgnesAI-Labs/agnes-harness.git`（仓库级配置，不受全局 insteadOf 影响）。
- CLI/serve 自动拉起 daemon 子进程可能失败（`daemon child exited before readiness (1)`，2026-10-08 在 macOS 上复现），CLI 还偶发 `DAEMON_CONNECTION_CLOSED`（SDK 直连始终正常）。`scripts/start-demo.sh` 已改为显式检查并按手动方式拉起 daemon、由 pid 文件纳管，`stop-demo.sh` 会一并停止；手动起的 daemon 仍需自行 `kill`。
- 工具返回的 `structured` 含 `undefined` 字段会被 Host 判为非法 ToolResult（表现为 E_ENVELOPE / TOOL_OUTCOME_UNKNOWN）；所有输出先过一遍 JSON 序列化清洗。
- 工具 execute 抛异常 = 「may_have_sent」→ 写工具显示 TOOL_OUTCOME_UNKNOWN 但副作用可能已发生（幂等键保护重试）。
- `toolCall` 里读 Skill/外部内容会 taint 当前 turn，之后的写工具必须审批；无人值守的 `-p` 模式自动拒绝审批。
- 业务服务计划状态机是 DRAFT → REVIEW_PENDING → REVIEWED → PUBLISHED（不是 IN_REVIEW/APPROVED）。
- `fjsp_task_status` 已内置等待，不要让 Agent 用 shell sleep（shell 审批会失败并 taint）。
