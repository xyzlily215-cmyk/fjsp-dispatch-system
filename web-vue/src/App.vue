<template>
  <!-- el-config-provider 由 unplugin-vue-components 按需引入；zh-cn 语言包保持
       ElMessageBox 等命令式弹窗按钮文案为中文（原全量注册时的 locale 配置） -->
  <el-config-provider :locale="zhCn">
    <router-view />
  </el-config-provider>
</template>

<script setup>
import { onMounted } from 'vue';
import { useRouter } from 'vue-router';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
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
