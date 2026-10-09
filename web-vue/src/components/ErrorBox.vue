<template>
  <div class="error-box">
    <b>{{ title }}<span v-if="error && error.code" class="pill"> {{ error.code }}</span></b>{{ message }}
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { errMsg } from '../utils/format';

const props = defineProps({
  error: { type: [Object, Error, String], default: null },
  title: { type: String, default: '请求失败' },
});
const message = computed(() => errMsg(props.error));
</script>
