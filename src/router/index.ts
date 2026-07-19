import { createRouter, createWebHistory } from 'vue-router'
import { encodeFileToken, isLoggedIn, refreshAuthAdmin, rememberResolvedFileName } from '../lib/api'
import { rawFileNameFromPublicPath } from '../lib/e2ee'
import { isAuthEnabled } from '../lib/features'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      redirect: () => {
        // backward compat: old hash-based encrypted links (#/file?f=...&k=...)
        const hash = window.location.hash
        if (hash.startsWith('#/file?')) {
          const params = new URLSearchParams(hash.slice('#/file?'.length))
          const f = params.get('f')
          const k = params.get('k')
          if (f) rememberResolvedFileName(f)
          if (f && k) {
            if (k.startsWith('pw:')) return `/file/${encodeFileToken(f)}+${k}/preview`
            return `/file/${encodeFileToken(f)}/preview#${encodeURIComponent(k)}`
          }
          if (f) return `/file/${encodeFileToken(f)}/preview`
        }
        // backward compat: old hash-based public preview links (#/preview?p=...&f=...)
        if (hash.startsWith('#/preview?')) {
          const params = new URLSearchParams(hash.slice('#/preview?'.length))
          const p = params.get('p') ?? ''
          const f = params.get('f') ?? ''
          const filename = rawFileNameFromPublicPath(p || f)
          if (filename) {
            rememberResolvedFileName(filename)
            return `/file/${encodeFileToken(filename)}/preview`
          }
        }
        if (!isAuthEnabled()) return '/files'
        return isLoggedIn() ? '/files' : '/login'
      },
    },
    { path: '/login', component: () => import('../views/LoginView.vue') },
    { path: '/register', component: () => import('../views/RegisterView.vue') },
    { path: '/admin/claim', component: () => import('../views/AdminClaimView.vue') },
    {
      path: '/admin',
      component: () => import('../views/AdminView.vue'),
      meta: { requiresAuth: isAuthEnabled(), requiresAdmin: true },
    },
    { path: '/file/:filekey/preview', component: () => import('../views/FileView.vue') },
    { path: '/file/:filekey/raw', component: () => import('../views/RawRedirectView.vue') },
    { path: '/file/:filekey/download', component: () => import('../views/DownloadRedirectView.vue') },
    {
      path: '/view/:filename',
      redirect: (to) => {
        const filename = String(to.params.filename)
        rememberResolvedFileName(filename)
        return `/file/${encodeFileToken(filename)}/preview`
      },
    },
    {
      path: '/files',
      component: () => import('../views/DashboardView.vue'),
      meta: { requiresAuth: isAuthEnabled() },
    },
    // backward compat: old /{id}/file.ext style direct URLs
    {
      path: '/:id/:tail',
      redirect: (to) => {
        const id = String(to.params.id)
        const tail = String(to.params.tail)
        const filename = rawFileNameFromPublicPath(`${id}/${tail}`)
        if (filename) {
          rememberResolvedFileName(filename)
          return `/file/${encodeFileToken(filename)}/preview`
        }
        return '/files'
      },
    },
    // backward compat: single-segment filenames like /name.ext
    {
      path: '/:pathMatch(.*)*',
      redirect: (to) => {
        const seg = (to.params.pathMatch as string[]).join('/')
        if (seg && seg.includes('.') && !seg.includes('/')) {
          rememberResolvedFileName(seg)
          return `/file/${encodeFileToken(seg)}/preview`
        }
        if (!isAuthEnabled()) return '/files'
        return isLoggedIn() ? '/files' : '/login'
      },
    },
  ],
})

router.beforeEach(async (to) => {
  if (!isAuthEnabled() && (to.path === '/login' || to.path === '/register' || to.path.startsWith('/admin'))) return '/files'
  if (to.meta.requiresAuth && !isLoggedIn()) return '/login'
  if (to.meta.requiresAdmin && !(await refreshAuthAdmin())) return '/files'
})

export default router
