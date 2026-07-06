import './lib/promiseWithResolvers'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import { hydrateSessionIdentity } from './lib/api'
import { initTheme } from './lib/theme'
import './style.css'

initTheme()
void hydrateSessionIdentity()
createApp(App).use(createPinia()).use(router).mount('#app')
