<template>
  <div ref="host" class="echart-panel"></div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as echarts from 'echarts';

const props = defineProps({
  option: { type: Object, required: true },
  /* 开启后每 2.4s 轮播高亮一个数据项并浮出 tooltip，大屏"自己在动" */
  carousel: { type: Boolean, default: false },
});
const host = ref(null);
let chart = null;
let observer = null;
let carouselTimer = null;
let cursor = 0;

function render() {
  if (chart && props.option) chart.setOption(props.option, { notMerge: true });
}

function tickCarousel() {
  if (!chart || document.hidden) return;
  const len = props.option?.series?.[0]?.data?.length || 0;
  if (!len) return;
  chart.dispatchAction({ type: 'downplay', seriesIndex: 0 });
  chart.dispatchAction({ type: 'hideTip' });
  const dataIndex = cursor % len;
  chart.dispatchAction({ type: 'highlight', seriesIndex: 0, dataIndex });
  chart.dispatchAction({ type: 'showTip', seriesIndex: 0, dataIndex });
  cursor += 1;
}

function syncCarousel() {
  clearInterval(carouselTimer);
  carouselTimer = null;
  if (props.carousel) carouselTimer = setInterval(tickCarousel, 2400);
}

onMounted(() => {
  chart = echarts.init(host.value);
  render();
  syncCarousel();
  observer = new ResizeObserver(() => chart && chart.resize());
  observer.observe(host.value);
});

watch(() => props.option, render, { deep: true });
watch(() => props.carousel, syncCarousel);

onBeforeUnmount(() => {
  clearInterval(carouselTimer);
  observer?.disconnect();
  chart?.dispose();
  chart = null;
});
</script>

<style scoped>
.echart-panel {
  flex: 1;
  min-height: 0;
  width: 100%;
}
</style>
