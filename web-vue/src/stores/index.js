import { createPinia } from 'pinia';

/* 单例 pinia：router 守卫等组件外场景需要显式传入 useAuthStore(pinia) */
export const pinia = createPinia();
