import { createRouter, createWebHashHistory } from 'vue-router'
import { isLoggedIn } from '../lib/api'
import { rawFileNameFromPublicPath } from '../lib/e2ee'

function initialRootRedirect() {
  if (typeof window === 'undefined') return '/files'
  const pathname = decodeURIComponent(window.location.pathname.replace(/^\/+/, ''))
  if (!pathname || pathname === 'index.html') return '/files'
  if (rawFileNameFromPublicPath(pathname)) {
    return { path: '/preview', query: { p: pathname } }
  }
  return '/files'
}

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: initialRootRedirect },
    { path: '/login', component: () => import('../views/LoginView.vue') },
    { path: '/register', component: () => import('../views/RegisterView.vue') },
    { path: '/file', component: () => import('../views/EncryptedFileView.vue') },
    { path: '/preview', component: () => import('../views/PublicFilePreviewView.vue') },
    {
      path: '/files',
      component: () => import('../views/DashboardView.vue'),
      meta: { requiresAuth: true },
    },
  ],
})

router.beforeEach((to) => {
  if (to.meta.requiresAuth && !isLoggedIn()) return '/login'
})

export default router
