<template>
  <div class="empty-screen">
    <div class="empty-symbol">◻</div>
    <h3>{{ title }}</h3>
    <p v-if="text">{{ text }}</p>
    <slot />
  </div>
</template>

<script setup>
defineProps({
  title: { type: String, default: '暂无数据' },
  text: { type: String, default: '' },
});
</script>
