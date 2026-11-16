<template><span class="count-up">{{ text }}</span></template>

<script setup>
/* 数字滚动：取值中的首个数字从旧值缓动到新值，前后缀（单位、%、h/m）原样保留。
 * 非数字值（如 "-"）直接显示；系统开启"减少动态效果"时不做动画。 */
import { onBeforeUnmount, ref, watch } from 'vue';

const props = defineProps({
  value: { type: [Number, String], default: '' },
  duration: { type: Number, default: 900 },
});
const NUM = /-?\d+(?:\.\d+)?/;
const text = ref('');
let raf = 0;
let last = 0;

function parse(v) {
  const s = String(v ?? '');
  const m = s.match(NUM);
  if (!m) return null;
  const decimals = (m[0].split('.')[1] || '').length;
  return { s, num: Number(m[0]), decimals, head: s.slice(0, m.index), tail: s.slice(m.index + m[0].length) };
}

function run(v) {
  cancelAnimationFrame(raf);
  const p = parse(v);
  const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!p || reduce) { text.value = String(v ?? ''); if (p) last = p.num; return; }
  const from = last;
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / props.duration);
    const e = 1 - Math.pow(1 - k, 3);
    const cur = from + (p.num - from) * e;
    text.value = p.head + cur.toFixed(p.decimals) + p.tail;
    if (k < 1) raf = requestAnimationFrame(step);
    else { text.value = p.s; last = p.num; }
  };
  raf = requestAnimationFrame(step);
}

watch(() => props.value, run, { immediate: true });
onBeforeUnmount(() => cancelAnimationFrame(raf));
</script>
