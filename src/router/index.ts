import { createRouter, createWebHistory } from 'vue-router'
import { encodeFileToken, isLoggedIn, refreshAuthAdmin, rememberResolvedFileName } from '../lib/api'
import { rawFileNameFromPublicPath } from '../lib/e2ee'
import { isAuthEnabled } from '../lib/features'
import { usePublicSettings } from '../lib/publicSettings'

const { refreshPublicSettings } = usePublicSettings()

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
            if (k.startsWith('pw:')) return { path: `/file/${encodeFileToken(f)}+${k}/preview`, hash: '' }
            return { path: `/file/${encodeFileToken(f)}/preview`, hash: `#${encodeURIComponent(k)}` }
          }
          if (f) return { path: `/file/${encodeFileToken(f)}/preview`, hash: '' }
        }
        // backward compat: old hash-based public preview links (#/preview?p=...&f=...)
        if (hash.startsWith('#/preview?')) {
          const params = new URLSearchParams(hash.slice('#/preview?'.length))
          const p = params.get('p') ?? ''
          const f = params.get('f') ?? ''
          const filename = rawFileNameFromPublicPath(p || f)
          if (filename) {
            rememberResolvedFileName(filename)
            return { path: `/file/${encodeFileToken(filename)}/preview`, hash: '' }
          }
        }
        return '/files'
      },
    },
    { path: '/login', component: () => import('../views/LoginView.vue'), meta: { transition: 'login-fade' } },
    { path: '/register', component: () => import('../views/RegisterView.vue'), meta: { transition: 'login-fade' } },
    { path: '/admin/claim', component: () => import('../views/AdminClaimView.vue') },
    {
      path: '/admin',
      component: () => import('../views/AdminView.vue'),
      meta: { requiresAuth: isAuthEnabled(), requiresAdmin: true, workspace: true },
    },
    {
      path: '/admin/:section(overview|users|uploads|settings|webhooks|audit)',
      component: () => import('../views/AdminView.vue'),
      meta: { requiresAuth: isAuthEnabled(), requiresAdmin: true, workspace: true },
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
      meta: { requiresAuth: isAuthEnabled(), workspace: true },
    },
    {
      path: '/history',
      component: () => import('../views/DashboardView.vue'),
      meta: { workspace: true },
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
        return '/files'
      },
    },
  ],
})

// Workspace routes a signed-out visitor may still reach while uploads are
// public. History renders its own "needs an account" state instead of ejecting
// the visitor to the login page.
const PUBLIC_GUEST_PATHS = new Set(['/files', '/history'])

router.beforeEach(async (to) => {
  // Keep legacy tab links usable while making page state path-based.
  const normalizedPath = to.path.replace(/\/+$/, '') || '/'
  if (normalizedPath === '/files' && to.query.tab === 'history') return '/history'
  if (!isAuthEnabled() && to.path === '/history') return '/files'
  if (!isAuthEnabled() && (to.path === '/login' || to.path === '/register' || to.path.startsWith('/admin'))) return '/files'
  if (PUBLIC_GUEST_PATHS.has(to.path) && to.meta.requiresAuth && !isLoggedIn()) {
    const settings = await refreshPublicSettings()
    if (settings.upload_access_mode === 'public') return
  }
  if (to.meta.requiresAuth && !isLoggedIn()) return '/login'
  if (to.meta.requiresAdmin && !(await refreshAuthAdmin())) return '/files'
})

export default router
