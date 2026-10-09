/* 跨页共享状态：当前发布计划缓存 + 页面间跳转预选参数（自旧版 app.js 的 Shared 移植） */
import { defineStore } from 'pinia';
import { Api } from '../api';

export const useSharedStore = defineStore('shared', {
  state: () => ({
    dashboard: null,          // 当前发布计划、看板缓存
    boardCache: null,         // 看板页最近一次成功响应 { dash, versions }（跨挂载保留，自 BoardView 模块级迁入）
    ganttVersionId: null,     // 甘特预选版本
    ganttView: null,          // 甘特视图：resource / order
    ganttFocusOp: null,       // 跨视图联动定位的目标工序
    calendarMachineId: null,  // 设备日历预选设备
    compareBaselineId: null,  // 方案对比预选
    compareCandidateId: null,
    selectedTaskId: null,     // 任务详情预选
    tasksPageNo: 0,           // 任务队列页码
    reviewPageNo: 0,          // 审核队列页码
    eventsPageNo: 0,          // 事件记录页码
    eventsType: '',           // 事件记录类型过滤
  }),
  actions: {
    async refreshDashboard() {
      try {
        this.dashboard = await Api.dashboard();
      } catch (e) {
        this.dashboard = null;
      }
    },
  },
});
