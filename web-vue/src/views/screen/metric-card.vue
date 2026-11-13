<template>
  <div class="metric-card" :style="{ '--kc': accent }">
    <div class="metric-card__top">
      <span class="metric-card__label">{{ label }}</span>
      <span v-if="tag" class="metric-card__tag">{{ tag }}</span>
    </div>
    <div class="metric-card__mid">
      <div class="metric-card__value">
        {{ display }}<em>{{ unit }}</em>
      </div>
      <svg class="metric-card__spark" viewBox="0 0 96 30" preserveAspectRatio="none" aria-hidden="true">
        <polyline points="0,24 14,20 28,22 42,13 56,16 70,8 84,11 96,4" fill="none" stroke="currentColor" stroke-width="2" />
        <circle cx="96" cy="4" r="2.5" fill="currentColor" />
      </svg>
    </div>
    <div class="metric-card__foot">
      <span>环比</span>
      <b :class="deltaClass">{{ delta > 0 ? '▲' : delta < 0 ? '▼' : '•' }} {{ delta > 0 ? '+' : '' }}{{ delta }}%</b>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';

const props = defineProps({
  label: { type: String, required: true },
  value: { type: Number, default: 0 },
  unit: { type: String, default: '' },
  delta: { type: Number, default: 0 },
  decimals: { type: Number, default: 0 },
  accent: { type: String, default: '#2CE8FF' },
  /* 右上角迷你标签，如 PLAN / WIP / OEE / OTD */
  tag: { type: String, default: '' },
});

const shown = ref(0);
let raf = 0;

/* count-up：值变化时用 600ms 滚动到位 */
watch(() => props.value, (next, prev) => {
  cancelAnimationFrame(raf);
  const from = Number.isFinite(prev) ? prev : 0;
  const start = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - start) / 600);
    shown.value = from + (next - from) * (1 - (1 - k) ** 3);
    if (k < 1) raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
}, { immediate: true });

const display = computed(() => shown.value.toLocaleString('zh-CN', {
  minimumFractionDigits: props.decimals,
  maximumFractionDigits: props.decimals,
}));
const deltaClass = computed(() => (props.delta > 0 ? 'is-up' : props.delta < 0 ? 'is-down' : ''));

onBeforeUnmount(() => cancelAnimationFrame(raf));
</script>

<style scoped>
.metric-card {
  position: relative;
  display: flex;
  flex-direction: column;
  padding: 9px 14px 10px;
  background: linear-gradient(180deg, rgba(20, 72, 140, 0.62), rgba(4, 20, 50, 0.82));
  border: 1px solid rgba(70, 170, 255, 0.35);
  overflow: hidden;
  min-width: 0;
}

/* 顶部辉光线，颜色随 accent */
.metric-card::before {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  height: 2px;
  background: linear-gradient(90deg, transparent, var(--kc), transparent);
  box-shadow: 0 0 12px var(--kc);
}

/* 右上装饰斜框 */
.metric-card::after {
  content: "";
  position: absolute;
  right: -30px;
  top: -40px;
  width: 120px;
  height: 120px;
  border: 1px solid rgba(80, 180, 255, 0.1);
  transform: rotate(45deg);
  pointer-events: none;
}

.metric-card__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.metric-card__label {
  font-size: 12px;
  color: #a8cbe9;
  letter-spacing: 1px;
  white-space: nowrap;
}

.metric-card__tag {
  font-size: 9px;
  color: var(--kc);
  border: 1px solid currentColor;
  padding: 1px 6px;
  opacity: 0.85;
  font-family: "Bahnschrift", "DIN Alternate", Consolas, monospace;
}

.metric-card__mid {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  margin-top: 2px;
}

.metric-card__value {
  font-family: "Bahnschrift", "DIN Alternate", Consolas, monospace;
  font-size: 36px;
  font-weight: 700;
  line-height: 1;
  color: var(--kc);
  text-shadow: 0 0 20px currentColor;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.metric-card__value em {
  font-size: 12px;
  font-style: normal;
  font-weight: 400;
  color: #8fb8dd;
  margin-left: 3px;
}

.metric-card__spark {
  width: 84px;
  height: 28px;
  flex: 0 0 84px;
  color: var(--kc);
}

.metric-card__foot {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  color: #7fa6cc;
  margin-top: 2px;
}

.metric-card__foot b {
  color: #00e2a8;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

.metric-card__foot b.is-down { color: #ff5470; }
</style>
