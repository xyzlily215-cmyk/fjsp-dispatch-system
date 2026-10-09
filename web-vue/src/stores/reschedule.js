/* 重调度向导状态：跨页面访问保留步骤/模式/参数（自 RescheduleView 模块级 reactive 单例迁入，应用级生命周期不变） */
import { defineStore } from 'pinia';

export const useRescheduleStore = defineStore('reschedule', {
  state: () => ({
    wizard: {
      step: 0,
      planVersionId: null,
      eventId: null,
      preview: null,
      previewDetail: null,
      previewKey: '',
      mode: 'BOTH',
      freezeWindowMinutes: '',
      timeLimitSeconds: 30,
      weights: { weightedTardiness: 0.4, makespan: 0.3, deltaPlan: 0.2, machineChange: 0.1 },
    },
  }),
});
