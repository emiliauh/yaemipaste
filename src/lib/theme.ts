import { ref } from 'vue'

export type ThemeMode = 'system' | 'light' | 'dark'
export type AppliedTheme = 'light' | 'dark'

const THEME_KEY = 'rp_theme_mode'
const DARK_QUERY = '(prefers-color-scheme: dark)'

const themeMode = ref<ThemeMode>('system')
const appliedTheme = ref<AppliedTheme>('dark')

let mediaQuery: MediaQueryList | null = null
let initialized = false

function resolveTheme(mode: ThemeMode): AppliedTheme {
  if (mode === 'system') return mediaQuery?.matches ? 'dark' : 'light'
  return mode
}

function applyTheme(theme: AppliedTheme) {
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
  appliedTheme.value = theme
}

function handleSystemChange() {
  if (themeMode.value !== 'system') return
  applyTheme(resolveTheme('system'))
}

function readStoredMode(): ThemeMode {
  const value = localStorage.getItem(THEME_KEY)
  if (value === 'light' || value === 'dark' || value === 'system') return value
  return 'system'
}

export function setThemeMode(mode: ThemeMode) {
  themeMode.value = mode
  localStorage.setItem(THEME_KEY, mode)
  applyTheme(resolveTheme(mode))
}

export function toggleTheme() {
  setThemeMode(appliedTheme.value === 'dark' ? 'light' : 'dark')
}

export function initTheme() {
  if (initialized || typeof window === 'undefined') return
  initialized = true
  mediaQuery = window.matchMedia(DARK_QUERY)
  if (typeof mediaQuery.addEventListener === 'function') {
    mediaQuery.addEventListener('change', handleSystemChange)
  } else if (typeof mediaQuery.addListener === 'function') {
    mediaQuery.addListener(handleSystemChange)
  }
  const mode = readStoredMode()
  themeMode.value = mode
  applyTheme(resolveTheme(mode))
}

export function useTheme() {
  return {
    themeMode,
    appliedTheme,
    setThemeMode,
    toggleTheme,
  }
}
