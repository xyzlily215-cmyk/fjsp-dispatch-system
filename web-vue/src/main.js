import { createApp } from 'vue';
import './styles/legacy.css';
import App from './App.vue';
import { pinia } from './stores';
import { router } from './router';
import { vRole } from './directives/role';

const app = createApp(App);
app.use(pinia);
app.use(router);
app.directive('role', vRole);
app.mount('#app');
