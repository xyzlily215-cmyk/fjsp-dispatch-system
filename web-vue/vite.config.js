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
          /* vue 全家桶拆 vendor；element-plus 不指定——按需引入后由 rollup 归入主包/路由 chunk
             （若给 element-plus 强制成组会把整库拉进该 chunk，破坏按需 tree-shaking）。
             echarts/zrender 单独成 chunk：只有甘特路由引用它，rollup 只打包已被按需
             tree-shaking 选中的模块，该 chunk 仍随甘特路由懒加载；独立出来是为避免
             甘特业务代码 + echarts 合成一个超 600kB 预警线的巨型 chunk。 */
          if (/[\\/]node_modules[\\/](echarts|zrender)[\\/]/.test(id)) return 'echarts';
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
      /* AI 调度副驾 BFF（agh-integration/agent-bff，默认 4178）：SSE 长连接经同源代理，
       * BFF 自身也校验 Origin 仅放行 loopback，双保险。 */
      '/agent-api': {
        target: 'http://127.0.0.1:4178',
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 5174,
    /* preview 与 dev 一样经同源代理访问业务服务（CORS 白名单只放行 8082，见 application-local.yml） */
    proxy: {
      '/api': {
        target: 'http://localhost:8081',
        changeOrigin: true,
        headers: { Origin: 'http://127.0.0.1:8082' },
      },
      '/agent-api': {
        target: 'http://127.0.0.1:4178',
        changeOrigin: true,
      },
    },
  },
});
