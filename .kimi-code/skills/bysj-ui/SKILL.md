---
name: bysj-ui
description: 在 FJSP 调度系统 web-vue 前端新建或修改页面、组件、样式时套用本仓库既有 UI 约定。当用户提到改页面、加视图、调样式、前端规范、UI 改版，或改动落在 web-vue/src/views、web-vue/src/components、web-vue/src/styles、web-vue/src/layout 下时使用。
---

# bysj 前端 UI 约定（web-vue/）

改本仓库前端页面前先看现成样板，不要凭空设计：

- 页面样板：`src/views/BoardView.vue`（看板）、`src/views/GanttView.vue`（甘特）、`src/views/ReviewView.vue`（评审队列）。
- 设计令牌与全局样式：`src/styles/legacy.css`（`--blue:#409eff`、`--ink`、`--muted`、`--line`、`--bg`、`--nav:#172237` 等 CSS 变量，颜色一律取变量，不写死新色值）。
- 整体外壳：`src/layout/` 的侧栏 + 顶栏结构，新增页面只写内容区，不改外壳。

## 做法

- 全部视图用 Vue 3 Composition API `<script setup>`（现有 20 个视图一致），不要引入 Options API。
- API 一律走 `src/api/`（`index.js` / `agent.ts` / `twin.ts`）的封装，不在视图里直接 `fetch`；新端点先加 api 函数再在视图用。
- 组件用 Element Plus + 仓库自有 class 体系：`page-header`（h1 + 说明行）、`card` / `section-pad`、`btn primary`（主操作才实心）、`field`、`buttons`；加载态用 `loading-block` + `.spin`，错误态用 `ErrorBox` 组件 + 重试按钮，状态展示用 `StatusTag`。
- 页面三态齐全：加载中 / 致命错误（可重试）/ 正常内容，参照 `BoardView.vue` 开头结构。
- 图表用 ECharts（已是依赖），序列色对齐 `--blue` 系；不引入新的图表库。
- 文案一律中文；空值显示 `—`；破坏性操作（删除、取消）用危险色 + 二次确认。
- 布局最小宽度 1180px（`legacy.css` body 约定），不要为移动端重做布局，但窄屏不要出现横向溢出。
- 用户文本渲染（agent 消息等）必须经过 `marked` + `dompurify` 的既有管线，不直接 `v-html` 原始内容。
- 不引入新 UI 框架、不改 Element Plus 主题色、不把页面写回 jQuery/旧式风格。

## 做完一页

- 跑 `npm test`（`node --test tests/*.test.mjs`）确认未破坏 API 层测试；页面行为改动可跑 `scripts/ui-check.sh`，跑不了要在交接中注明。
- 新增视图要登记路由（`src/router/`）和侧栏菜单入口，并在交接报告中说明。
