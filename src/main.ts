import './lib/promiseWithResolvers'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import { hydrateSessionIdentity, verifyStoredSession } from './lib/api'
import { initTheme } from './lib/theme'
import './style.css'

initTheme()
// Confirm any stored session is still valid before the user can act on the
// assumption that they're logged in - most importantly, before an upload
// under an invalid token could silently succeed as anonymous instead.
void verifyStoredSession()
void hydrateSessionIdentity()
createApp(App).use(createPinia()).use(router).mount('#app')
