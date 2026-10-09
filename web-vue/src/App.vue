<template>
  <router-view />
</template>

<script setup>
import { onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { setUnauthorizedHandler } from './api';
import { useAuthStore } from './stores/auth';

const router = useRouter();
const auth = useAuthStore();

onMounted(() => {
  // 401：清理登录态并回登录页（替代旧版 Auth.handleUnauthorized 的整页刷新）
  setUnauthorizedHandler(() => {
    auth.handleUnauthorized();
    if (router.currentRoute.value.name !== 'login') {
      router.push({ name: 'login', query: { expired: '1' } });
    }
  });
});
</script>
