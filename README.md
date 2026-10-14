# 动态柔性车间生产调度与仿真决策系统

这是本科毕业设计项目「动态柔性车间生产调度与仿真决策系统」，包含：

- `algorithm-service/`：Python/FastAPI 调度算法服务；
- `business-service/`：Java/Spring Boot 业务服务，负责数据、事件、计划版本、审核发布和执行反馈；
- `web-vue/`：前端（Vue 3 + Vite + Element Plus + ECharts），构建产物为纯静态文件；
- `agh-integration/`：Agnes Harness（AGH）工具和技能集成；
- `deploy/`：PostgreSQL 基础设施配置（Redis 预留未启用，未来引入缓存/队列时再加回 compose）；
- `scripts/`：本地一键启动、重置、测试和证据采集脚本。

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

## 配置与安全

`POST /api/v1/demo/reset` 由配置项 `fjsp.demo.enabled` 控制（默认 `false`，`application-local.yml` 中显式开启供本地演示与脚本使用，关闭时返回 403）；重置只清空业务表并重新导入种子数据，`audit_log` 审计日志保留。

不要把 `.env`、数据库密码或 AGH API Key 提交到 Git。复制 `.env.example` 后填写本地值；`scripts/check-env.sh` 会拒绝使用示例密码，并且不会打印密码或 API Key。

AGH 的审核发布流程要求显式审批：计划必须先提交审核，审核通过后才能发布；工具不会自动提交审核或自动审批。相关实现和验证证据见 `agh-integration/README.md`。

## 业务服务单独开发

业务服务的接口、数据模型、状态机和测试说明见 [`business-service/README.md`](business-service/README.md)。

## 数据库 schema 管理（Flyway + ddl-auto 分环境）

- 迁移脚本位于 `business-service/src/main/resources/db/migration/`，基线为 `V1__baseline_schema.sql`（17 张业务表）；schema 变更一律新增 `V<n>__*.sql`，不要改动已应用的脚本（唯一例外：`V3__auth.sql` 在未上线前做过一次性修正——种子账号插入移至 `UserSeedRunner`，表结构不变；已应用旧版 V3 的存量库需 `flyway repair` 或重建，local profile 不跑 Flyway、不受影响）。
- **本地开发（local profile）**：`scripts/start-demo.sh` 默认以 `SPRING_PROFILES_ACTIVE=local` 启动业务服务，此时 Flyway 关闭、`ddl-auto=update`，由 Hibernate 自动同步表结构；启动时还会复用 V5/V6/V13 的迁移 SQL 创建 Hibernate 无法管理的部分唯一索引（重复运行安全）。如存量库已有多个生效计划或同一工序的重复未结束反馈，索引创建会拒绝启动；请先备份并核查冲突数据，不会自动删除业务记录。
- **默认 profile（生产姿态）**：Flyway 启用并执行迁移，`ddl-auto=validate` 仅校验实体与库表一致，不再自动改表。存量库首次启动会自动 baseline 到版本 1（`baseline-on-migrate`），全新空库则执行 V1 建表。
- 手动启动时通过环境变量选择：`SPRING_PROFILES_ACTIVE=local java -jar ...` 为本地开发模式；不设该变量即为生产姿态。`prod` profile 下所有连接与密钥强制来自环境变量（无默认值，缺失即启动失败）；`test` profile 预留给 Testcontainers 集成测试。
- 业务服务配置矩阵（配置项/类型/默认值/各 profile 差异/环境变量）见 [`business-service/README.md`](business-service/README.md) 的「配置项」一节。
