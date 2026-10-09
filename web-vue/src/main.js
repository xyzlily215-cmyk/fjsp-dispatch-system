import { createApp } from 'vue';
import ElementPlus from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import 'element-plus/dist/index.css';
import './styles/legacy.css';
import App from './App.vue';
import { pinia } from './stores';
import { router } from './router';
import { vRole } from './directives/role';

const app = createApp(App);
app.use(pinia);
app.use(router);
app.use(ElementPlus, { locale: zhCn });
app.directive('role', vRole);
app.mount('#app');
