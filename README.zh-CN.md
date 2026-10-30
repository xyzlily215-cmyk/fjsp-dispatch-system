# 动态柔性车间生产调度与仿真决策系统

[English](README.md) | 简体中文

<div align="center">

**以智能体副驾驱动的动态柔性作业车间调度：基线排程、扰动处置、审核发布、执行反馈——全程可审计。**

<img src="https://img.shields.io/badge/license-MIT-2F4F4F" alt="License: MIT" />
<img src="https://img.shields.io/badge/Java-17%20%C2%B7%20Spring%20Boot%203.5-6DB33F" alt="Java 17 / Spring Boot 3.5" />
<img src="https://img.shields.io/badge/Python-3.12%20%C2%B7%20FastAPI-3776AB" alt="Python 3.12 / FastAPI" />
<img src="https://img.shields.io/badge/Vue-3%20%C2%B7%20Vite%20%C2%B7%20Element%20Plus-42B883" alt="Vue 3 / Vite / Element Plus" />
<img src="https://img.shields.io/badge/PostgreSQL-16-336791" alt="PostgreSQL 16" />

[演示视频](#演示视频) · [技术架构](#技术架构) · [集成标准](#集成标准) · [快速启动](#快速启动)

</div>

本科毕业设计项目：面向单车间的动态柔性车间生产调度与仿真决策系统，覆盖「基础数据维护 → 基线排程 → 事件录入（设备故障 / 紧急插单）→ 局部 / 完全重调度 → 方案对比 → 审核发布 → 执行反馈」的完整业务闭环。系统以 [Agnes Harness（AGH）](https://github.com/AgnesAI-Labs/agnes-harness) 为智能体运行底座提供 AI 调度副驾，并可经 MHS/AgnesHub 接入车间设备，形成数字孪生体验。

## 项目介绍

### 项目背景

柔性作业车间在实际生产中普遍依赖人工经验或静态排程。一旦发生紧急插单、设备故障等扰动，原定计划需要反复人工调整，容易出现资源冲突（同一设备时间重叠）、工艺顺序错误（工序先后约束被破坏）、交期失控（拖期无法量化评估与对比）等问题；同时调整过程缺乏可解释的方案对比与审批留痕，决策责任难以追溯。

本项目构建并验证了一套「动态调度决策 + 可解释展示 + 人机协同管控」的闭环系统。

### 核心功能

- **基线排程**：基于基础数据一键排程（演示规模 20 订单 / 8 设备 / 3 产品族，上限 50/12），产出带 KPI（总完工时间 C_max、加权拖期、负载不均衡度、计划扰动 Δ_plan）的计划版本。
- **扰动处置**：登记设备故障 / 插单事件，自动计算受影响工序集合（HARD_LOCKED / ADJUSTABLE 分级 + 冻结窗口规则），支持局部 / 完全重调度。
- **计划治理**：完整状态机 `DRAFT → REVIEW_PENDING → REVIEWED → PUBLISHED → EXECUTING`，含驳回修订、乐观锁、过期校验与发布时硬约束完整性守卫。
- **执行反馈**：登记工序 RUNNING/COMPLETED；首个 RUNNING 反馈使计划转入 EXECUTING；执行中工序经 `actualStartAt` 锚定协议在重调度中锁定。
- **AI 调度副驾**：基于 AGH 的智能体通过 18 个 `fjsp_*` 工具用中文指令操作全部业务闭环，写/高风险操作一律人工审批；具备 RSI 经验闭环——处置结果沉淀为经验，同类事件自动推荐历史最优策略；全链路审计留痕。
- **数字孪生车间**：8 台虚拟机床 + 1 台 AGV 经 MHS/AgnesHub 接入——状态/指标/panel 画面、车间地图、故障注入，设备告警自动唤醒 Agent 处置。
- **Web 控制台**：20 个 Vue 视图——看板、甘特图、方案对比、任务队列、审批队列、执行反馈、Agent 处置时间线、数字孪生等。

### 创新亮点

- **自研混合遗传算法**（`event-adaptive-hga-1.0.0`）：事件自适应的局部/完全重调度，支持冻结窗口与硬锁语义，业务侧二次 `/validate` 复核。
- **智能体原生操作**：业务能力同一份代码同时暴露为 AGH 工具插件与 MCP server；四级审批策略（只读/普通写/高风险/破坏性）保证评审与发布始终由人决策。
- **RSI 经验闭环**：每次扰动处置沉淀为经验记录（JSONL + 向量嵌入与 BM25 双路召回的 RAG 检索），同类事件再次发生时自动推荐历史最优模式与权重。
- **企业级可靠性**：幂等键、乐观锁、单一生效计划部分唯一索引、关键写操作审计日志、任务重试/超时/启动恢复、协作式取消。

## 演示视频

- **演示视频（3–5 分钟，百度网盘）**：<https://pan.baidu.com/s/1Sa8LUACkWuJmYwFUZr9mFw?pwd=pbh7>（提取码：`pbh7`）
- 视频内容：基线排程与发布 → 设备故障的 AI 副驾处置 → 方案对比与审核 → 数字孪生车间。
- *视频录制于 2026-10-20；此后新增了 Web 端 AI 副驾侧栏与数字孪生车间页，视频中 Agent 交互基于 AGH 工作台。*

## 技术架构

```text
┌──────────────────┐  HTTPS/JWT   ┌────────────────────┐  HTTP /solve /validate  ┌─────────────────────┐
│ web-vue          │ ───────────▶ │ business-service   │ ──────────────────────▶ │ algorithm-service   │
│ Vue 3 + Vite     │ ◀── SSE ──── │ Spring Boot 3.5    │ ◀──── 计划 + KPI ────── │ FastAPI + 混合 GA   │
│ Element Plus     │              │ Spring Data JPA    │                         │ event-adaptive-hga  │
│ ECharts（纯静态） │              │ PostgreSQL 16      │                         └─────────────────────┘
└────────┬─────────┘              └─────────▲──────────┘
         │ /agent-api (HTTP/SSE)            │ REST /api/v1（JWT、幂等、乐观锁）
┌────────▼─────────┐              ┌─────────┴──────────┐
│ agent-bff        │              │ fjsp-tools 插件     │ ── MCP server（stdio，协议 2025-06-18）
│ Node (tsx) :4178 │              │ 18 个 fjsp_* 工具   │
└────────┬─────────┘              └─────────▲──────────┘
         │ unix socket（AGH SDK）            │ agnes.plugins 入口
┌────────▼──────────────────────────────────┴───────────┐   MHS over WebSocket   ┌───────────────────┐
│ Agnes Harness（AGH）运行时——LLM + Skill + 审批          │ ◀──────────────────── │ MHS 设备           │
│ 工作台 :4177 · 设备中枢（AgnesHub）:4180                │    AgnesHub :4180     │ 8 台机床 + 1 台 AGV │
└────────────────────────────────────────────────────────┘                       └───────────────────┘
```

### 核心模块

| 模块 | 技术栈 | 职责 |
|---|---|---|
| `algorithm-service/` | Python 3.12、FastAPI | 调度内核：`/solve`、`/validate`、`/health`；混合遗传算法支持事件自适应重调度、冻结窗口与锁集合一致性校验；求解串行化避免 GIL 争用 |
| `business-service/` | Java 17、Spring Boot 3.5、JPA + Flyway、PostgreSQL 16 | 数据持久化、事件登记、影响集合计算、异步任务编排（重试/超时/启动恢复）、计划版本、审核发布、执行反馈、JWT 认证、审计 |
| `web-vue/` | Vue 3、Vite、Element Plus、Pinia、ECharts | 纯静态构建的 SPA 控制台（hash 路由），20 个视图，AI 副驾侧栏与页内洞察卡片 |
| `agh-integration/` | AGH 插件 / Node (tsx) / Python | `fjsp-tools` 插件（18 个工具）、`agent-bff`（AGH→HTTP/SSE 桥 + MCP server + RAG 经验检索）、MHS 虚拟设备、`fjsp-dispatch` Skill、端到端驱动脚本 |
| `deploy/` | Docker Compose | PostgreSQL 16（仅绑定 127.0.0.1） |
| `scripts/` | Bash / Node | 一键启动/停止/重置、冒烟测试、e2e 接口契约检查、性能基线、证据采集 |

默认端口：前端 **8082** · 业务 API **8081** · 算法服务 **8101** · AGH 工作台 **4177** · agent-bff **4178** · AgnesHub **4180**。

## 集成标准

### 业务 REST API（`/api/v1`）

- **统一响应包络**：所有响应为 `{requestId, timestamp, code, message, data}`；`requestId` 经 MDC 贯穿日志，401/403 响应同样携带。
- **分页契约**：列表端点统一返回 `data: {items, page, size, total, totalPages}`（page 从 0 起，size 默认 20、上限 200；工序端点放宽到 5000）。
- **认证授权**：无状态 JWT（`Authorization: Bearer <token>`，HS256，有效期 8h），四种角色 DISPATCHER / REVIEWER / PRODUCTION_MANAGER / ADMIN；JWT 携带 `tv`（tokenVersion）claim，每次请求比对数据库，停用/改角色/改密即时失效；登录防爆破（连续失败 5 次锁定 10 分钟，返回 429）；SSE 流使用一次性 60 秒 ticket 而非 Bearer。
- **幂等**：写接口要求 `Idempotency-Key`，同键同摘要 24h 内返回原结果，同键不同摘要返回 `E_DUPLICATE`；排程任务另有输入快照指纹（SHA-256）唯一约束。
- **乐观锁**：提交审核/审核/修订/发布均需携带当前 `version`，不匹配返回 `409 E_VERSION_STALE`；数据库层以部分唯一索引（`uq_plan_version_single_active`）保证全库单一生效计划。
- **时间与错误码**：数据库 timestamptz 存 UTC，接口 ISO 8601；业务错误码稳定（`E_VALIDATION`、`E_STATE_CONFLICT`、`E_PLAN_STALE`、`E_INTEGRITY_VIOLATION`、`E_EVENT_IN_PROCESS` 等）。完整端点清单与角色矩阵见 [`business-service/README.md`](business-service/README.md)。

### 算法服务契约

- `POST /solve`——入参：设备/日历、订单/工序、模式（`BASELINE` / `LOCAL_RESCHEDULE` / `FULL_RESCHEDULE`）、锁集合（含 `actualStartAtMinutes` 锚定）、冻结窗口、目标权重、随机种子；出参：排产工序 + KPI，或 `INFEASIBLE` + 结构化冲突明细。
- `POST /validate`——对候选计划按全部硬约束独立复核；业务侧在落库前与发布前各校验一次。
- `GET /health`——存活检查，返回服务与算法版本。

### 智能体集成（AGH 插件、MCP、MHS）

- **AGH 工具插件**（`agh-integration/fjsp-tools`）：无依赖单文件 ESM，经 `agnes.plugins` 声明；18 个 `fjsp_*` 工具均通过业务 REST API 操作，自动生成幂等键，业务错误码原样透传给 Agent；每个请求带审计头 `X-Source: agh` 与 `X-AGH-Session-Id`。
- **三级审批**：只读工具不审批；普通写工具每次审批（幂等重放）；高风险（`fjsp_approve_review`、`fjsp_publish`）与破坏性（`fjsp_reset_demo`）每次审批且禁止重放——评审与发布是两个独立人工决策点，Agent 不会自动审批。
- **MCP server**（`agh-integration/agent-bff/mcp-server.mts`）：同一套工具实现经 Model Context Protocol（stdio/NDJSON，协议 2025-06-18）暴露给任意 MCP 客户端；写/高风险工具必须在参数中显式携带 `"_confirm": true`，与 AGH 人工审批等价。
- **agent-bff**（`agh-integration/agent-bff/server.mts`）：把 AGH daemon 桥接为前端同源 HTTP/SSE（`/agent-api/chat`、`/stream`、`/permission`、`/twin/*`、`/rag/experience-query`）；仅绑定 127.0.0.1 并校验 loopback Origin。
- **MHS 设备**（`agh-integration/mhs-devices`）：虚拟机床与 AGV 经 WebSocket 向 AgnesHub 注册状态、指标、panel 画面与车间地图；设备告警自动唤醒 Agent，仍走标准 `fjsp_*` 审批链处置。集成细节见 [`agh-integration/README.md`](agh-integration/README.md)。

## 快速启动

### Windows：使用 WSL2 + Docker Desktop

本项目的启动脚本为 Bash，Windows 用户请在 **WSL2 的 Ubuntu 终端**运行，不要在 PowerShell 或 Git Bash 中直接运行。首次准备：

1. 在**管理员 PowerShell** 执行 `wsl --list --online` 确认发行版可用，再执行 `wsl --install -d Ubuntu-24.04`，按提示完成安装/重启；用 `wsl -l -v` 确认 Ubuntu 的 VERSION 为 `2`。
2. 在 Windows 安装并启动 Docker Desktop，使用 WSL 2 后端，在 **Settings → Resources → WSL Integration** 中启用 Ubuntu；切换到 Linux containers（不要使用 Windows containers）。
3. 打开 Ubuntu 终端，在 Ubuntu 中安装 Git、curl、Python 3.12（含 `venv`）、Node.js 22、JDK 17 和 Maven；运行 `docker compose version` 与 `docker info` 确认该终端可以连接 Docker。
4. 建议在 Ubuntu 的家目录（如 `~/projects`，而非较慢的 `/mnt/c`）执行下方克隆和启动命令。服务启动后用 Windows 浏览器访问下方的前端入口。

此路径复用 Linux 启动脚本；**尚未在 Windows 实机验证**。如果 WSL2 或 Docker Desktop 无法启用（例如公司电脑的虚拟化策略受限），目前不承诺原生 Windows 启动。

### 从 GitHub 全新克隆并启动（macOS / Linux / WSL2）

先安装并启动 Docker（含 Compose v2），准备 Python 3.12、Node.js 22、JDK 17、Maven、Bash 和 curl；首次安装依赖和拉取 PostgreSQL 镜像需要联网。脚本不会自动安装依赖、构建前端或清空数据库。

```bash
git clone https://github.com/xyzlily215-cmyk/fjsp-dispatch-system.git
cd fjsp-dispatch-system

# 使用虚拟环境；运行 start-demo.sh 时保持它处于激活状态
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install -r algorithm-service/requirements.txt

# 构建前端产物（web-vue/dist 不纳入 Git）
cd web-vue && npm ci && npm run build && cd ..

cp .env.example .env
# 编辑 .env：将 FJSP_DB_PASSWORD=change-this-password 换成自己的本地密码
# 新装数据库可设置新密码；若已有 fjsp 数据库，须使用原有密码，勿覆盖数据
./scripts/start-demo.sh
```

`start-demo.sh` 会启动或复用 PostgreSQL、算法服务、业务服务和前端；默认业务服务使用 `local` profile，不会自动重置业务数据。`.env`、Python 虚拟环境和前端构建产物均不提交到 Git。启动失败时先检查 Docker 是否已运行、端口 5432/8101/8081/8082 是否被占用，以及脚本输出的日志路径。该步骤针对**本机访问**，不是公网生产部署指南。

默认入口：

- 前端：<http://127.0.0.1:8082/index.html?api=http://localhost:8081/api/v1>
- 业务 API：<http://localhost:8081/api/v1>
- 算法健康检查：<http://localhost:8101/health>
- AGH 工作台（仅启用 AGH 时）：<http://localhost:4177/>

默认只启动 PostgreSQL、算法服务、业务服务和前端；AGH 是可选组件，启用前需按 [`agh-integration/README.md`](agh-integration/README.md) 构建其 CLI：

```bash
FJSP_START_AGH=1 ./scripts/start-demo.sh
```

不经脚本单独操作 PostgreSQL 的 Compose 配置时，需显式指定 env 文件（`deploy/docker-compose.yml` 中数据库名/用户/密码为 `:?` 必填变量，缺失会直接报错；端口仅绑定到 127.0.0.1）：

```bash
docker compose --env-file .env -f deploy/docker-compose.yml up -d
```

## 前端（web-vue/）

前端基于 Vue 3 + Vite + Element Plus + Pinia + ECharts，路由为 hash 模式（`/#/...`），任意静态服务器均可托管；API 地址支持同源或本机回环地址的 `?api=` 查询参数，也支持手工设置的 `localStorage fjsp.apiBase`（默认 `http://localhost:8081/api/v1`）。外部链接中的非本机跨域 `?api=` 会被忽略，以免向不可信服务发送 JWT；需要独立远程 API 时请在受信任环境下显式配置，而非通过外部链接传入。

```bash
# 开发联调（5174 端口，内置 /api → 8081 代理，自动处理 CORS Origin）
cd web-vue && npm install && npm run dev
# 打开 http://127.0.0.1:5174/?api=http://127.0.0.1:5174/api/v1

# 构建生产产物（纯静态，输出 web-vue/dist）
npm run build
```

`start-demo.sh` 默认以 `web-vue/dist` 为前端目录（需先构建）；可用 `FJSP_WEB_DIR=<相对仓库根的目录>` 覆盖。

## 验证与证据

```bash
# 清空并重新导入演示数据；会修改演示数据库中的业务数据
./scripts/reset-demo.sh

# 业务全流程冒烟测试
./scripts/run-smoke-test.sh

# ⚠️ 前端依赖的 API 字段契约检查；会先调用 POST /demo/reset 清空并重建演示数据，
#    请勿在含手工录入数据的环境运行
./scripts/run-e2e.sh

# 核心 SQL 性能基线：对关键查询跑 EXPLAIN ANALYZE，输出扫描方式与耗时，用于对比索引生效前后
./scripts/perf-baseline.sh

# 基础数据写接口冒烟（正例 + 负例校验）
bash scripts/crud-check.sh

# 前端（8082）跨域访问业务服务（8081）的 CORS 检查
bash scripts/ui-check.sh

# 采集健康检查、核心接口和服务头信息；默认输出到 /tmp
./scripts/collect-evidence.sh
```

停止本批次脚本启动的进程并停止 Compose 容器（保留数据卷）：

```bash
./scripts/stop-demo.sh
```

## 认证与账号

业务服务已启用 Spring Security + JWT 认证：前端打开后先登录（token 存 localStorage，401 自动退回登录页）；脚本（smoke/e2e/reset/collect-evidence）自动以 `FJSP_AUTH_USER`/`FJSP_AUTH_PASSWORD`（默认 admin）先调 `/api/v1/auth/login` 再访问业务接口。

演示种子账号（**仅本地演示**，密码均为 `Fj@123456`）：

| 用户名 | 角色 | 权限要点 |
|---|---|---|
| dispatcher | DISPATCHER 调度员 | 创建/重试/取消任务、登记事件、提交审核 |
| reviewer | REVIEWER 审核员 | 审核/驳回计划版本、回滚已替代（SUPERSEDED）历史版本 |
| manager | PRODUCTION_MANAGER 生产主管 | 发布计划版本、执行反馈 |
| admin | ADMIN 管理员 | 全部权限（含基础数据维护、demo/reset） |

JWT 密钥走 `FJSP_JWT_SECRET`（见 `.env.example`，不设置时使用仅开发用默认值，有效期默认 8h）。角色-端点完整矩阵见 [`business-service/README.md`](business-service/README.md)。

> ⚠️ 种子账号由业务服务 `UserSeedRunner` 在所有 profile 下创建（Flyway V3 只建表、不再插入账号）：`local`/默认 profile 用上述演示密码；`prod` profile 禁止使用内置演示密码，初始账号密码必须经环境变量 `FJSP_SEED_ADMIN_PASSWORD` 提供，缺失则启动失败（仅用于首次创建，已有账号不覆盖），生产部署后应立即改密。登录接口有防爆破保护：同一账号连续失败 5 次锁定 10 分钟，锁定期内返回 429。

## 设计文档

[系统设计说明书](docs/系统设计说明书.md) · [PRD](docs/动态柔性车间生产调度与仿真决策系统PRD.md) · [研发附录（算法/接口/数据模型）](docs/动态柔性车间生产调度与仿真决策系统研发附录.md) · [功能清单](docs/功能清单.md) · [资料收集整理](docs/资料收集整理.md)。模块级细节：[`business-service/README.md`](business-service/README.md) · [`agh-integration/README.md`](agh-integration/README.md)。

## 配置与安全

`POST /api/v1/demo/reset` 由配置项 `fjsp.demo.enabled` 控制（默认 `false`，`application-local.yml` 中显式开启供本地演示与脚本使用，关闭时返回 403）；重置只清空业务表并重新导入种子数据，`audit_log` 审计日志保留。

不要把 `.env`、数据库密码或模型 API Key 提交到 Git。复制 `.env.example` 后填写本地值；`scripts/check-env.sh` 会拒绝使用示例密码，并且不会打印密码或 API Key。AGH/Agnes 凭据放在仓库之外的 `~/.config/fjsp/agnes.env`。

AGH 的审核发布流程要求显式审批：计划必须先提交审核，审核通过后才能发布；工具不会自动提交审核或自动审批。相关实现和验证证据见 `agh-integration/README.md`。

## 业务服务单独开发

业务服务的接口、数据模型、状态机和测试说明见 [`business-service/README.md`](business-service/README.md)。

## 数据库 schema 管理（Flyway + ddl-auto 分环境）

- 迁移脚本位于 `business-service/src/main/resources/db/migration/`，基线为 `V1__baseline_schema.sql`（17 张业务表）；schema 变更一律新增 `V<n>__*.sql`，不要改动已应用的脚本（唯一例外：`V3__auth.sql` 在未上线前做过一次性修正——种子账号插入移至 `UserSeedRunner`，表结构不变；已应用旧版 V3 的存量库需 `flyway repair` 或重建，local profile 不跑 Flyway、不受影响）。
- **本地开发（local profile）**：`scripts/start-demo.sh` 默认以 `SPRING_PROFILES_ACTIVE=local` 启动业务服务，此时 Flyway 关闭、`ddl-auto=update`，由 Hibernate 自动同步表结构；启动时还会复用 V5/V6/V13 的迁移 SQL 创建 Hibernate 无法管理的部分唯一索引（重复运行安全）。如存量库已有多个生效计划或同一工序的重复未结束反馈，索引创建会拒绝启动；请先备份并核查冲突数据，不会自动删除业务记录。
- **默认 profile（生产姿态）**：Flyway 启用并执行迁移，`ddl-auto=validate` 仅校验实体与库表一致，不再自动改表。存量库首次启动会自动 baseline 到版本 1（`baseline-on-migrate`），全新空库则执行 V1 建表。
- 手动启动时通过环境变量选择：`SPRING_PROFILES_ACTIVE=local java -jar ...` 为本地开发模式；不设该变量即为生产姿态。`prod` profile 下所有连接与密钥强制来自环境变量（无默认值，缺失即启动失败）；`test` profile 预留给 Testcontainers 集成测试。
- 业务服务配置矩阵（配置项/类型/默认值/各 profile 差异/环境变量）见 [`business-service/README.md`](business-service/README.md) 的「配置项」一节。

## 第三方代码与素材说明

- [Agnes Harness（AGH）](https://github.com/AgnesAI-Labs/agnes-harness)：智能体运行底座（Apache-2.0），作为外部组件使用，未随本仓库分发。
- 框架与依赖：Spring Boot、FastAPI、Vue 3、Element Plus、ECharts、PostgreSQL 等，完整清单与各自许可证见 `business-service/pom.xml`、`algorithm-service/requirements.txt`、`web-vue/package.json`。
- 经验检索 RAG 使用的 `multilingual-e5-small` 嵌入模型经 Hugging Face 镜像单独下载，不随仓库分发。

本项目以 [MIT License](LICENSE) 开源。
