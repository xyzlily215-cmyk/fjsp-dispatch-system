<template>
  <span class="tag" :class="color">{{ text }}</span>
</template>

<script setup>
import { computed } from 'vue';
import { statusTagInfo } from '../utils/format';

const props = defineProps({ status: { type: String, default: '' } });
const info = computed(() => statusTagInfo(props.status));
const color = computed(() => info.value[0]);
const text = computed(() => info.value[1]);
</script>
