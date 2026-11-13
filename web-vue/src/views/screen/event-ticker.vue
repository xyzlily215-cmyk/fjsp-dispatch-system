<template>
  <div ref="box" class="event-ticker" @mouseenter="paused = true" @mouseleave="paused = false">
    <ul ref="list" class="event-ticker__list" :style="{ transform: `translateY(${-offset}px)` }">
      <li v-for="item in doubled" :key="item.key" class="event-ticker__item" :class="`is-${item.level}`">
        <span class="event-ticker__badge" :class="`is-${item.level}`">{{ badgeText(item.level) }}</span>
        <span class="event-ticker__text" :title="item.text">{{ item.text }}</span>
        <span class="event-ticker__time">{{ item.time }}</span>
      </li>
    </ul>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

const props = defineProps({ events: { type: Array, default: () => [] } });

const LEVEL_LABEL = { danger: '紧急', warning: '预警', info: '提示', success: '恢复' };
const badgeText = level => LEVEL_LABEL[level] || '提示';

/* 像素级连续上滚：列表复制一份接尾部，滚过一半瞬间归零，视觉无缝 */
const paused = ref(false);
const offset = ref(0);
const box = ref(null);
const list = ref(null);
let timer = null;

const doubled = computed(() => {
  const rows = props.events.map((e, i) => ({ ...e, key: `a-${i}` }));
  return rows.concat(props.events.map((e, i) => ({ ...e, key: `b-${i}` })));
});

watch(() => props.events, async () => {
  offset.value = 0;
  await nextTick();
});

onMounted(() => {
  timer = setInterval(() => {
    if (paused.value || document.hidden || !list.value) return;
    const half = list.value.scrollHeight / 2;
    if (!half) return;
    offset.value = offset.value + 0.6 >= half ? 0 : offset.value + 0.6;
  }, 40);
});

onBeforeUnmount(() => clearInterval(timer));
</script>

<style scoped>
.event-ticker {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.event-ticker__list {
  list-style: none;
  margin: 0;
  padding: 0;
  will-change: transform;
}

.event-ticker__item {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 34px;
  box-sizing: border-box;
  margin-bottom: 8px;
  padding: 0 10px;
  background: linear-gradient(90deg, rgba(20, 70, 135, 0.4), rgba(6, 26, 60, 0.2));
  border-left: 2px solid #3b8bff;
  font-size: 11px;
  color: #b9d6ef;
}

.event-ticker__item.is-warning { border-left-color: #ff9340; }
.event-ticker__item.is-danger { border-left-color: #ff5470; }
.event-ticker__item.is-success { border-left-color: #0aa877; }

.event-ticker__badge {
  flex: 0 0 34px;
  padding: 2px 0;
  font-size: 9px;
  text-align: center;
  color: #fff;
  background: #3b8bff;
}

.event-ticker__badge.is-danger { background: #ff5470; }
.event-ticker__badge.is-warning { background: #ff9340; }
.event-ticker__badge.is-success { background: #0aa877; }

.event-ticker__text {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.event-ticker__time {
  color: #6f96bb;
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
</style>
