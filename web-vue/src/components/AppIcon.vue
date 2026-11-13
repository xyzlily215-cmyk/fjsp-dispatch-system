<template>
  <svg class="app-icon" :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path v-for="path in paths" :key="path" :d="path" />
  </svg>
</template>

<script setup>
import { computed } from 'vue';
import { iconPaths } from '../utils/menuIcons';

const props = defineProps({ name: { type: String, required: true }, size: { type: Number, default: 16 } });
const paths = computed(() => iconPaths(props.name));
</script>
