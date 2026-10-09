import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    host: '127.0.0.1',
    port: 5174,
    /* 开发联调：前端跑 5174 时经同源代理访问业务服务，绕开 CORS 白名单（生产部署仍用 ?api= 直连）。
     * 注意：Spring CorsFilter 会校验 Origin 头（同源 POST 浏览器也带 Origin），
     * 代理需把 Origin 改写成白名单内的 8082 来源，否则一律 403。 */
    proxy: {
      '/api': {
        target: 'http://localhost:8081',
        changeOrigin: true,
        headers: { Origin: 'http://127.0.0.1:8082' },
      },
    },
  },
  preview: { host: '127.0.0.1', port: 5174 },
});
