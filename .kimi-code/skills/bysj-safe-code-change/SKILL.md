---
name: bysj-safe-code-change
description: 在 FJSP 调度系统项目（bysj，business-service Java/Spring Boot + algorithm-service Python/FastAPI + web-vue Vue3 + agh-integration AGH/Node）中安全地修改代码：保护已有未提交改动、最小化 diff、按模块套用各自工程规范、大改动分批确认、七段式交接报告。当用户要求在本仓库任何子工程（business-service、algorithm-service、web-vue、agh-integration、deploy、scripts）中修改、修复、新增、重构或删除代码时，必须使用本 skill；即使用户没有提到 skill 名字，只要改动落在这个项目里就适用。
---

# bysj Safe Code Change

在 FJSP 调度系统仓库（根目录含 `business-service/`、`algorithm-service/`、`web-vue/`、`agh-integration/`、`deploy/`、`scripts/`）中工作时自动套用本流程。用户的修改请求是第一依据，不要让用户重复本流程。

本 skill 是项目专属安全层 + 通用工程流程。下面的安全规则永远优先于速度或通用工作流偏好。

## 不可协商规则

- 保护所有已存在的未提交改动（本项目多为单人开发，但仍可能是用户进行中或其他会话的工作）。
- 编辑前必须运行 `git status --short`，并用 `git diff` 查看相关的已有改动。
- 已有未提交改动一律视为他人/他任务所有，除非用户明确说它属于本次任务。
- 请求涉及的文件与已有未提交 diff 重叠且权属不清时，停下来问用户，不要直接改。
- 永不覆盖、删除、还原、格式化、重命名或重构与本任务无关的代码。
- 一次只完成一个可独立验证的最小改动。
- 保留现有架构、API、命名、格式和依赖选择，除非请求明确要求变更。
- 不主动执行 commit、amend、push、reset、checkout、clean 等改写历史的操作，除非用户明确要求。
- **密钥与本地配置永不提交、永不在答复中外泄**：项目根 `.env`（含 `FJSP_DB_PASSWORD` 等）与任何 `application-local*.yml` 只在本地保留；口令、密钥不得写进仓库任何文件、SQL、脚本或文档。需要新增配置项时改 `.env.example` 的占位写法。
- **`git add` 只加明确列出的路径**，严禁 `git add -A` / `git add .`。
- **演示数据保护**：不擅自运行 `scripts/reset-demo.sh`、不清库、不改演示种子数据；测试数据用独立标识，可定向清理。

## 编辑前

1. 确认当前工作目录在 bysj 仓库内（仓库根以 `.git` 为准；注意存在 `本科生组-U019-暴躁的兔子-熊英孜 2/` 打包副本，**不要在副本目录里改代码**）。
2. 运行 `git status --short` 记录基线。
3. 只查看与请求相关的文件和符号，以及对应测试。
4. 按改动范围读对应资料：
   - 任何改动：`README.md`（架构与集成标准）、`docs/系统设计说明书.md`
   - Agent 相关：`agh-integration/README.md`；AGH 内部改动再读 `agh-integration/agnes-harness/CLAUDE.md`
   - 业务流程语义：`docs/动态柔性车间生产调度与仿真决策系统PRD.md`、`agh-integration/skills/fjsp-dispatch/SKILL.md`
5. 明确请求的行为、影响边界、验收标准和已知约束。请求已经清楚时，简要记下推断的验收标准即可，不要问冗余问题。
6. 判断请求是一批做完还是必须拆分。

## 各模块工程标准

### business-service/（Java 17 + Spring Boot 3.5 + Spring Data JPA + Flyway）

- 包结构 `com.fjsp.business`：`controller / service / repository / entity / dto / config / auth / client`，分层职责不混：Controller 做协议与校验，业务状态机与事务在 Service，持久化走 Repository。
- 计划版本状态机 `DRAFT → REVIEW_PENDING → REVIEWED → PUBLISHED → EXECUTING`、乐观锁、幂等键、审计日志是既有约定，改动不得绕过；发布前的硬约束完整性守卫与 `/validate` 复核必须保留。
- 库结构变更走 Flyway 迁移脚本；注意 local profile `ddl-auto=update`、默认 profile `validate` 的差异。
- 与算法服务通信用既有 RestClient（超时 620s），不引入新的 HTTP 客户端。
- 数据库口令只从环境变量读（`set -a; source ../.env; set +a`），不写进 `application*.yml` 的可提交部分。

### algorithm-service/（Python 3.12 + FastAPI）

- 求解器逻辑在 `app/`（`ga.py / decoder.py / solver.py / validator.py / kpi.py / conflicts.py` 等），算法行为变更必须对照 `tests/` 中既有测试（freeze window、reproducibility、validation、quality baseline）补回归。
- 算法 seed 与可复现性是验收硬指标：改动后 `test_reproducibility.py` 必须通过。
- 运行测试：`pytest`（仓库有 `pytest.ini`），不擅自安装新依赖；确需依赖时同步 `requirements.txt` 与 `requirements-dev.txt` 并说明理由。

### web-vue/（Vue 3 + Vite + Element Plus + Pinia）

- 全部 20 个视图用 Composition API `<script setup>`，保持一致，不改写成 Options API。
- API 调用统一走 `src/api/`（`index.js` / `agent.ts` / `twin.ts`），不在视图里直接 fetch。
- UI 约定见项目 skill `bysj-ui`。
- 测试：`npm test`（`node --test tests/*.test.mjs`）；UI 冒烟用 `scripts/ui-check.sh`。

### agh-integration/（AGH 底座 + Node 单文件服务）

- `fjsp-tools/index.mjs` 是 18 个 `fjsp_*` 工具的唯一实现源，MCP Server 与 AGH 插件共用；改工具契约要同时考虑两个入口。
- 工具风险分级（READ/WRITE/HIGH_RISK/DESTRUCTIVE）、审批、幂等键、业务错误码透传是既有契约，不得弱化。
- `agent-bff/server.mts` 目前无鉴权是已知缺口（见 `docs/Agent化架构优化方案.md` P0），新增端点时按方案的身份/审批边界设计，不要把现状当设计依据。
- `agnes-harness/` 未随仓库分发；改动 AGH 相关代码时固定版本、保存复现步骤。
- 验证驱动 `driver/fjsp-agent.mts` 会自动批准写操作，只作标注"模拟审批"的验证入口，不能用来证明人工审批链路正确。

### deploy/ 与 scripts/

- `deploy/docker-compose.yml` 的端口绑定 `127.0.0.1`、凭据走 `${FJSP_*}` 环境变量，保持该模式。
- `scripts/` 下 shell 脚本遵循 `demo-common.sh` 的公共函数与既有命名；新增脚本给可执行权限并在 README 或交接中说明。

## 任务模式

选能控制风险的最轻模式：

- **小修复**：单一孤立行为或几行改动。查看相关路径，说明改动意图，实现，做聚焦检查。
- **功能或行为变更**：写简短实现计划（可配合 `writing-plans` skill），确定受影响模块和测试，按可独立验证的顺序实现。
- **大型或高风险改动**：多批确认。每批先定边界、预期行为和验证方式，再动手。

Bug 报告先复现或追踪失败路径并说明可能原因（可配合 `systematic-debugging` skill）；项目测试设施允许时，先补回归测试再修复。无法复现时，记录证据和残余不确定性，不要宣称原因已确认。

满足以下任一条件即视为大改动，必须分批并等用户确认后再做第一批：跨子工程、改公共 API 或数据库结构（Flyway 迁移）、涉及鉴权/审批/幂等、涉及算法求解核心（ga/decoder/validator）、超过 5 个文件、净增约 200 行以上、无法独立验证。

小的孤立请求说明范围后可直接做，不要因为附近有可清理的代码就扩大范围。

## 编辑中

- 用满足请求的最小补丁；优先清晰直接的设计，不引入新抽象；不做顺手清理。
- 每批尽量保持可独立编译或验证。
- 为变更行为补充聚焦测试，含相关失败路径；测试要确定性、观测行为而非复述实现。
- 不静默改变请求范围外的行为。
- 假设、歧义或新发现的依赖导致范围变化时，停下来报告再继续。

实现后把 diff 当作独立一遍来复查：请求的行为、错误路径、兼容性、安全影响，以及测试是否真的能拦住原 bug。发现问题先修正再交接。

## 每批之后

先跑最窄的相关验证，再视情况跑更广的检查：

- business-service 改动：`mvn -q compile -DskipTests`（在 `business-service/` 下）必过；相关功能再跑定向测试或 `scripts/crud-check.sh`。
- algorithm-service 改动：相关 `pytest tests/test_xxx.py` 必过。
- web-vue 改动：`npm test`；页面行为改动跑 `scripts/ui-check.sh` 或说明未跑原因。
- 端到端行为改动：`scripts/run-smoke-test.sh` 或 `scripts/run-e2e.sh`（需演示环境，跑不了要明说）。
- 文档、注释、纯配置改动不需要编译。
- 检查 `git diff --stat` 和 `git diff --check`，确认没有无关文件改动、没有 `.env` 混入。

交接前按以下七段报告：

1. **修改目的**：本批次解决什么问题。
2. **涉及文件**：每个文件及其作用。
3. **逐项 diff 说明**：按文件说明新增、修改或删除的逻辑。
4. **测试结果**：实际运行的命令及结果；未运行的命令要说明原因。
5. **风险点**：可能影响的行为、兼容性、数据或部署风险。
6. **不确定项**：没有被代码或项目资料确认的假设。
7. **回滚方法**：如何仅撤销本批次，不影响已有修改。

检查没跑成时，明确区分"未运行"和"未通过"，永远不要把推断结果说成已执行的测试结果。

还有更多批次时，报告后停下来等用户确认，不要自动继续。

## 最终交接与提交

最终交付前重复基线对比：

- 确认所有改动文件都属于本任务，已有改动完好无损。
- 运行 `git diff --check` 和所有相关模块检查。
- 确认无 `.env` / `node_modules` / `dist` / `target` / `__pycache__` 混入。
- 确认未触碰 `本科生组-U019-... 2/` 打包副本。

使用同样的七段报告。用户明确要求提交时，先展示拟提交的范围和提交信息，只提交被批准的批次。提交信息用中文、说明动机；不主动 push。

## 安全回滚

优先只回退本批次创建的补丁或提交。永不使用 `git reset --hard`、`git checkout -- .`、`git clean` 这类宽泛命令。当回滚无法避开已有改动时，停下来请用户指定目标文件或提交。
