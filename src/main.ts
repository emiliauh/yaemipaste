import './lib/promiseWithResolvers'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import { hydrateSessionIdentity, verifyStoredSession } from './lib/api'
import { initTheme } from './lib/theme'
import { applyCachedBranding } from './lib/branding'
import { usePublicSettings } from './lib/publicSettings'
import './style.css'

initTheme()
// Fast path: restore the last-applied accent/favicon synchronously.
applyCachedBranding()

// The accent/logo are global server settings served to every visitor. Block
// the first mount until the global public settings have been fetched and
// applied, so themed content never paints with the default color before the
// real accent arrives - for all users, not just cached ones. A short bound
// keeps the app booting even if the API is slow or unreachable.
async function boot() {
  const { refreshPublicSettings } = usePublicSettings()
  await Promise.race([
    refreshPublicSettings(),
    new Promise((resolve) => setTimeout(resolve, 1500)),
  ])
  // Confirm any stored session is still valid before the user can act on the
  // assumption that they're logged in - most importantly, before an upload
  // under an invalid token could silently succeed as anonymous instead.
  void verifyStoredSession()
  void hydrateSessionIdentity()
  createApp(App).use(createPinia()).use(router).mount('#app')
}
void boot()
