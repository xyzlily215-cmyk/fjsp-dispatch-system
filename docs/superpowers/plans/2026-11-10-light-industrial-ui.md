# 浅色专业工业控制台第一批 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 统一全局基础样式与应用外壳，并完成调度看板和设备管理两个浅色工业控制台样板页。

**Architecture:** 保留现有 Vue、Element Plus 与业务代码，以全局设计令牌和共享 class 收敛视觉；仅新增无依赖 SVG 图标组件。先验证样板，不在本批推广到其他页面。

**Tech Stack:** Vue 3、Vite、Element Plus、CSS、Node test runner。

**Spec:** `docs/superpowers/specs/2026-11-10-light-industrial-ui-design.md`

## Global Constraints
- 不改业务逻辑、API、路由、权限和三维车间。
- 不新增 UI 或图标依赖，不执行提交或推送。
- 保护现有数字孪生未提交修改及未跟踪提交材料。
- 文本使用中文，空值沿用现有显示，危险操作保留二次确认。

## Review Focus
- 管理员与调度员看到不同菜单和按钮：分别核对权限显隐，不调用写接口。
- 看板空计划与有计划两种状态：空态有明确下一步，有数据时 KPI 与事件区不溢出。
- 设备名、日历、备注为空：保持对齐并使用现有空值展示。
- 侧栏折叠组、返回、AI 面板：行为与改造前一致。
- 1280×720 与 1440×900：主内容无横向页面溢出，表格内部可滚动。

---

### Task 1: 全局设计令牌与共享组件样式

**Files:**
- Modify: `web-vue/src/styles/legacy.css`
- Verify: `web-vue/src/views/BoardView.vue`、`web-vue/src/views/MachinesView.vue`

**Interfaces:**
- Consumes: 现有 `--blue`、`--ink`、`--muted`、`--line`、`--bg` 等变量及 `card/btn/field/data-table/tag` class。
- Produces: 供两个样板页共用的字体、间距、圆角、边框、焦点和表格样式；不改变 class 名称。

- [x] 检查现有覆盖顺序，修改根令牌和共享规则，避免在文件末尾追加一套互相竞争的新主题。
- [x] 统一正文与辅助文字对比度、8px 卡片圆角、32px 常规控件、清晰焦点环及表格行高。
- [x] 在浏览器核对其他路由未出现全局布局破坏，记录需要后续批次处理的局部覆盖。

### Task 2: 应用外壳与统一 SVG 图标

**Files:**
- Create: `web-vue/src/components/AppIcon.vue`
- Create: `web-vue/src/utils/menuIcons.js`
- Modify: `web-vue/src/layout/AppLayout.vue`
- Test: `web-vue/tests/menu-icons.test.mjs`

**Interfaces:**
- Consumes: `AppIcon` 的 `name`、`size` props；`menuIcons` 中的固定名称集合。
- Produces: `iconPaths(name): string[]`，未知名称返回默认方块图标路径；侧栏菜单的 `icon` 字段改为图标名称。

- [x] 先写测试，要求覆盖看板、数字孪生、基础数据、计划调度、事件、结果、审核、执行、用户、字典、时间线和 AI 图标，并验证未知名称回退。
- [x] 运行 `node --test tests/menu-icons.test.mjs`，确认因模块或图标缺失而失败。
- [x] 实现 `iconPaths` 和仅渲染内联 SVG 的 `AppIcon`，替换字符图标，不改菜单数组中的路由和权限字段。
- [x] 调整侧栏分组、品牌区、选中态、顶栏与内容区间距，保留键盘操作与 AI 未读徽标。
- [x] 重跑图标测试，再验证导航、分组折叠、返回和 AI 面板。

### Task 3: 两个样板页

**Files:**
- Modify: `web-vue/src/views/BoardView.vue`
- Modify: `web-vue/src/views/MachinesView.vue`
- Modify: `web-vue/src/styles/legacy.css`

**Interfaces:**
- Consumes: Task 1 的共享样式与 Task 2 的 `AppIcon`。
- Produces: 后续页面可复用的页头、主操作、筛选区、指标区、空态和数据表格布局。

- [x] 看板：强化页头和唯一主操作，整理筛选、计划摘要、KPI 与事件区；保留全部筛选和跳转逻辑。
- [x] 设备管理：整理页头、表格密度、产品族标签、操作列与空值；仅替换刷新和新增按钮图标。
- [x] 检查加载、刷新失败、空计划、正常设备列表和空字段。
- [x] 打开并关闭设备编辑弹窗，不保存、不新增、不停用设备。

### Task 4: 整批验证与交接

**Files:**
- Verify: 本批全部文件。

**Interfaces:**
- Consumes: Tasks 1–3 的最终改动。

- [x] 在 1280×720 和 1440×900 下检查两个样板页与应用外壳，无页面级横向溢出。
- [x] 运行 `npm test` 和 `npm run build`。
- [x] 运行 `bash scripts/ui-check.sh`。
- [x] 运行 `git diff --check`、`git diff --stat` 和 `git status --short`，确认没有无关文件或密钥混入。
- [ ] 按项目七段式报告本批结果，等待确认后再推广到其他页面。
