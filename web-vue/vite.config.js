import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import AutoImport from 'unplugin-auto-import/vite';
import Components from 'unplugin-vue-components/vite';
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers';

export default defineConfig({
  plugins: [
    vue(),
    /* Element Plus 按需化：<el-*> 模板组件由 Components 解析、ElMessage/ElMessageBox
       等命令式 API 由 AutoImport 解析，样式由 resolver 按组件注入（importStyle 默认 css） */
    AutoImport({ imports: [], resolvers: [ElementPlusResolver()], dts: false }),
    Components({ resolvers: [ElementPlusResolver()], dts: false }),
  ],
  build: {
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          /* vue 全家桶拆 vendor；element-plus/echarts 不指定——element-plus 按需引入后由
             rollup 归入主包/路由 chunk，echarts 随甘特路由懒加载 chunk 走。
             （若给 element-plus 强制成组会把整库拉进该 chunk，破坏按需 tree-shaking） */
          if (/[\\/]node_modules[\\/](vue|vue-router|pinia|@vue)([\\/]|$)/.test(id)) return 'vendor';
        },
      },
    },
  },
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
