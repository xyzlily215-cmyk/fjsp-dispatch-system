<template>
  <div class="gantt-stream">
    <div class="gantt-stream__axis">
      <span v-for="tick in ticks" :key="tick.label" class="gantt-stream__tick" :style="{ left: tick.left + '%' }">{{ tick.label }}</span>
    </div>
    <div class="gantt-stream__lanes">
      <div v-for="lane in lanes" :key="lane.machine" class="gantt-lane">
        <span class="gantt-lane__name">{{ lane.machine }}</span>
        <div class="gantt-lane__track">
          <span
            v-for="(job, i) in lane.jobs"
            :key="i"
            class="gantt-job"
            :class="`is-${job.status}`"
            :style="jobStyle(job)"
            :title="`${job.order} ${job.product}`"
          >{{ jobWidth(job) > 8 ? job.order : '' }}</span>
          <span class="gantt-now" :style="{ left: nowLeft + '%' }" aria-hidden="true"></span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

const props = defineProps({ lanes: { type: Array, default: () => [] } });

/* 时间窗：当前时刻前 4h ~ 后 6h，与假数据层一致 */
const now = ref(Date.now());
let timer = null;
onMounted(() => { timer = setInterval(() => { now.value = Date.now(); }, 1000); });
onBeforeUnmount(() => clearInterval(timer));

const windowStart = computed(() => now.value - 4 * 3600000);
const windowSpan = 10 * 3600000;

const pct = (t) => Math.max(0, Math.min(100, (t - windowStart.value) / windowSpan * 100));

const nowLeft = computed(() => pct(now.value));

const ticks = computed(() => {
  const pad = n => String(n).padStart(2, '0');
  const out = [];
  for (let i = 0; i <= 10; i += 2) {
    const d = new Date(windowStart.value + i * 3600000);
    out.push({ label: `${pad(d.getHours())}:00`, left: i * 10 });
  }
  return out;
});

function jobStyle(job) {
  return { left: pct(job.start) + '%', width: Math.max(0.5, pct(job.end) - pct(job.start)) + '%' };
}

function jobWidth(job) {
  return pct(job.end) - pct(job.start);
}
</script>

<style scoped>
.gantt-stream {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding-top: 6px;
}

.gantt-stream__axis {
  position: relative;
  height: 18px;
  margin-left: 52px;
}

.gantt-stream__tick {
  position: absolute;
  transform: translateX(-50%);
  font-size: 11px;
  color: #5f7a99;
  font-variant-numeric: tabular-nums;
}

.gantt-stream__lanes {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  justify-content: space-around;
}

.gantt-lane {
  display: flex;
  align-items: center;
  gap: 10px;
}

.gantt-lane__name {
  width: 42px;
  font-size: 12px;
  color: #8fb8d8;
  font-variant-numeric: tabular-nums;
  text-align: right;
  flex-shrink: 0;
}

.gantt-lane__track {
  position: relative;
  flex: 1;
  height: 20px;
  background: rgba(10, 45, 90, 0.5);
  background-image: repeating-linear-gradient(
    90deg,
    transparent 0 calc(20% - 1px),
    rgba(60, 150, 230, 0.15) calc(20% - 1px) 20%
  );
  overflow: hidden;
}

.gantt-job {
  position: absolute;
  top: 3px;
  bottom: 3px;
  border-radius: 2px;
  font-size: 10px;
  line-height: 14px;
  padding: 0 6px;
  color: #e9f9ff;
  white-space: nowrap;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.14);
}

.gantt-job.is-done {
  background: linear-gradient(90deg, #16458f, #3b7fe0);
  color: #cfe2f7;
}

.gantt-job.is-running {
  background: linear-gradient(90deg, #0b5f9e, #1cbde6, #0b5f9e);
  background-size: 200% 100%;
  border-color: #2ce8ff;
  box-shadow: 0 0 10px rgba(44, 232, 255, 0.55);
  animation: flow 2.4s linear infinite;
  color: #eafcff;
}

.gantt-job.is-queued {
  background: rgba(95, 122, 153, 0.14);
  border-color: rgba(95, 122, 153, 0.45);
  border-style: dashed;
  color: #7fa6cc;
}

.gantt-job.is-exception {
  background: linear-gradient(90deg, #8e1e36, #f2516b);
  border-color: #ff5470;
  box-shadow: 0 0 12px rgba(255, 84, 112, 0.6);
  animation: alarm 1.2s ease-in-out infinite alternate;
  color: #ffd7db;
}

.gantt-now {
  position: absolute;
  top: -2px;
  bottom: -2px;
  width: 2px;
  background: #ffc74a;
  box-shadow: 0 0 8px rgba(255, 199, 74, 0.9);
}

@keyframes flow {
  from { background-position: 0 0; }
  to { background-position: -200% 0; }
}

@keyframes alarm {
  from { opacity: 1; }
  to { opacity: 0.45; }
}
</style>
