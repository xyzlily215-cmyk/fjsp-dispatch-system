<template>
  <div v-if="loading" class="loading-block"><div class="spin"></div><div>{{ loadingText }}</div></div>
  <ErrorBox v-else-if="error" :error="error" :title="errorTitle" />
  <div v-else-if="empty"><slot name="empty" /></div>
  <div v-else><slot /></div>
</template>

<script setup>
/* 统一的 加载中 / 加载失败 / 空态 / 内容 容器：loading-block 与 ErrorBox 结构与各页原样板一致（样式在 legacy.css） */
import ErrorBox from './ErrorBox.vue';

defineProps({
  loading: { type: Boolean, default: false },
  error: { type: [Object, Error, String], default: null },
  errorTitle: { type: String, default: '加载失败' },
  loadingText: { type: String, default: '正在加载…' },
  empty: { type: Boolean, default: false },
});
</script>
