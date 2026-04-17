import { createRouter, createWebHashHistory } from 'vue-router'
import { isLoggedIn } from '../lib/api'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/files' },
    { path: '/login', component: () => import('../views/LoginView.vue') },
    { path: '/register', component: () => import('../views/RegisterView.vue') },
    { path: '/file', component: () => import('../views/EncryptedFileView.vue') },
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
