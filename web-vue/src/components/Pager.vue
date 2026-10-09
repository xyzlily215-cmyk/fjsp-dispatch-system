<template>
  <div class="pager">
    <button class="btn small" :disabled="page.page <= 0" @click="$emit('change', -1)">上一页</button>
    <span class="muted">第 {{ totalPages === 0 ? 0 : page.page + 1 }} / {{ totalPages }} 页 · 共 {{ page.total }} 条</span>
    <button class="btn small" :disabled="page.page >= totalPages - 1" @click="$emit('change', 1)">下一页</button>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  /* Page 包络 {items,page,size,total,totalPages} */
  page: { type: Object, required: true },
});
defineEmits(['change']);
const totalPages = computed(() => props.page.totalPages || 0);
</script>
