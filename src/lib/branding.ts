import { ref } from 'vue'

export type LogoType = 'preset' | 'upload'

export interface BrandingLogo {
  type: LogoType
  preset?: string
  dataUrl?: string
}

export const DEFAULT_ACCENT = '#fbbf24'
export const DEFAULT_LOGO_PRESET = 'trash'
const BRANDING_CACHE_KEY = 'yp_branding'

/** Stroke-based line icons matching the sidebar brand-mark style (viewBox 0 0 24 24). */
export const PRESET_ICONS: Record<string, string> = {
  trash:
    '<path d="M5 7.5h14" />'
    + '<path d="M7 7.5l.8-2.1A2 2 0 0 1 9.7 4h4.6a2 2 0 0 1 1.9 1.4l.8 2.1" />'
    + '<path d="M6.5 7.5 7.4 19a2 2 0 0 0 2 1.8h5.2a2 2 0 0 0 2-1.8l.9-11.5" />'
    + '<path d="M10 11.2v5.4" />'
    + '<path d="M14 11.2v5.4" />',
  zap:
    '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" />',
  flame:
    '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />',
  rocket:
    '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />'
    + '<path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />'
    + '<path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />'
    + '<path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />',
  clapperboard:
    '<path d="M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3Z" />'
    + '<path d="m6.2 5.3 3.1 3.9" />'
    + '<path d="m12.4 3.4 3.1 4" />'
    + '<path d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />',
  heart:
    '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />',
  feather:
    '<path d="M12.67 19a2 2 0 0 0 1.416-.588l6.154-6.172a6 6 0 0 0-8.49-8.49L5.586 9.914A2 2 0 0 0 5 11.328V18a1 1 0 0 0 1 1z" />'
    + '<path d="M16 8 2 22" />'
    + '<path d="M17.5 15H9" />',
}

export function presetInnerSvg(key: string): string {
  return PRESET_ICONS[key] ?? PRESET_ICONS[DEFAULT_LOGO_PRESET]
}

function setCssVar(name: string, value: string | null) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (value == null) root.style.removeProperty(name)
  else root.style.setProperty(name, value)
}

// ── Color utilities ────────────────────────────────────────────────────────
export function hexToRgb(hex: string): [number, number, number] {
  let value = hex.trim().replace(/^#/, '')
  if (value.length === 3) value = value.split('').map((c) => c + c).join('')
  if (!/^[0-9a-fA-F]{6}$/.test(value)) return [251, 191, 36]
  const int = parseInt(value, 16)
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255]
}

export function rgbToHex(rgb: [number, number, number]): string {
  return '#' + rgb.map((c) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, '0')).join('')
}

export function rgbToHsl(rgb: [number, number, number]): [number, number, number] {
  const r = rgb[0] / 255
  const g = rgb[1] / 255
  const b = rgb[2] / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  let h = 0
  let s = 0
  const l = (max + min) / 2
  const d = max - min
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1))
    switch (max) {
      case r: h = ((g - b) / d) % 6; break
      case g: h = (b - r) / d + 2; break
      default: h = (r - g) / d + 4
    }
    h *= 60
    if (h < 0) h += 360
  }
  return [h, s, l]
}

export function hexToHsl(hex: string): [number, number, number] {
  return rgbToHsl(hexToRgb(hex))
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const hp = h / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  let rgb: [number, number, number]
  if (hp < 1) rgb = [c, x, 0]
  else if (hp < 2) rgb = [x, c, 0]
  else if (hp < 3) rgb = [0, c, x]
  else if (hp < 4) rgb = [0, x, c]
  else if (hp < 5) rgb = [x, 0, c]
  else rgb = [c, 0, x]
  const m = l - c / 2
  return [Math.round((rgb[0] + m) * 255), Math.round((rgb[1] + m) * 255), Math.round((rgb[2] + m) * 255)]
}

export function hslToHex(h: number, s: number, l: number): string {
  return rgbToHex(hslToRgb(h, s, l))
}

/** Adjust lightness by a multiplier, returning a hex color. */
export function shadeHex(hex: string, lightnessFactor: number): string {
  const [h, s, l] = hexToHsl(hex)
  return hslToHex(h, s, Math.max(0, Math.min(1, l * lightnessFactor)))
}

function relativeLuminance(r: number, g: number, b: number): number {
  const linear = (value: number) => {
    const s = value / 255
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

function contrastRatio(background: number, foreground: number): number {
  const lighter = Math.max(background, foreground)
  const darker = Math.min(background, foreground)
  return (lighter + 0.05) / (darker + 0.05)
}

/** Pick the text color (near-black or white) with the highest contrast on the accent. */
export function onAccentText(hex: string): string {
  const [r, g, b] = hexToRgb(hex)
  const bg = relativeLuminance(r, g, b)
  const dark = relativeLuminance(28, 25, 23) // #1c1917
  const white = relativeLuminance(255, 255, 255)
  return contrastRatio(bg, dark) >= contrastRatio(bg, white) ? '#1c1917' : '#ffffff'
}

// ── Live accent application ────────────────────────────────────────────────
let currentAccent: string | null = null

export function applyAccent(hex: string | null) {
  currentAccent = hex ? normalizeHex(hex) : null
  if (!currentAccent) {
    setCssVar('--accent', null)
    setCssVar('--accent-h', null)
    setCssVar('--accent-d', null)
    setCssVar('--on-accent', null)
    setCssVar('--primary-action', null)
    setCssVar('--primary-action-h', null)
    persistBranding()
    return
  }
  setCssVar('--accent', currentAccent)
  setCssVar('--accent-h', shadeHex(currentAccent, 1.12))
  setCssVar('--accent-d', shadeHex(currentAccent, 0.86))
  setCssVar('--on-accent', onAccentText(currentAccent))
  setCssVar('--primary-action', currentAccent)
  setCssVar('--primary-action-h', shadeHex(currentAccent, 1.12))
  persistBranding()
}

export function getCurrentAccent(): string | null {
  return currentAccent
}

export function normalizeHex(value: string): string | null {
  let v = value.trim().replace(/^#/, '')
  if (/^[0-9a-fA-F]{3}$/.test(v)) v = v.split('').map((c) => c + c).join('')
  if (!/^[0-9a-fA-F]{6}$/.test(v)) return null
  return '#' + v.toLowerCase()
}

// ── Favicon & logo ─────────────────────────────────────────────────────────
export function presetSvg(key: string, stroke = DEFAULT_ACCENT): string {
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="' + stroke + '" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + presetInnerSvg(key) + '</svg>'
}

export function presetDataUrl(key: string, stroke = DEFAULT_ACCENT): string {
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(presetSvg(key, stroke))
}

function setFavicon(href: string) {
  if (typeof document === 'undefined') return
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (!link) {
    link = document.createElement('link')
    link.rel = 'icon'
    document.head.appendChild(link)
  }
  link.href = href
}

/** Reactive override used for live preview; sidebar reads this before settings. */
const logoOverride = ref<BrandingLogo | null>(null)

export function useLogoOverride() {
  return { logoOverride }
}

export function effectiveLogo(settings: {
  logo_type?: string
  logo_preset?: string
  branding_logo?: string
}, override: BrandingLogo | null = logoOverride.value): BrandingLogo {
  if (override) return override
  if (settings.logo_type === 'upload' && settings.branding_logo) {
    return { type: 'upload', dataUrl: settings.branding_logo }
  }
  if (settings.logo_type === 'preset' && settings.logo_preset) {
    return { type: 'preset', preset: settings.logo_preset }
  }
  return { type: 'preset', preset: DEFAULT_LOGO_PRESET }
}

export function applyLogo(logo: BrandingLogo | null) {
  logoOverride.value = logo
  if (typeof document === 'undefined') return
  if (!logo) return
  const accent = getCurrentAccent() ?? DEFAULT_ACCENT
  if (logo.type === 'upload' && logo.dataUrl) {
    setFavicon(logo.dataUrl)
  } else {
    setFavicon(presetDataUrl(logo.preset ?? DEFAULT_LOGO_PRESET, accent))
  }
  persistBranding()
}

/** Write the currently-applied accent/favicon to localStorage so it can be
 *  restored synchronously before first paint on the next visit. */
function persistBranding() {
  if (typeof window === 'undefined' || !('localStorage' in window)) return
  try {
    if (!currentAccent) {
      window.localStorage.removeItem(BRANDING_CACHE_KEY)
      return
    }
    const vars: Record<string, string> = {
      '--accent': currentAccent,
      '--accent-h': shadeHex(currentAccent, 1.12),
      '--accent-d': shadeHex(currentAccent, 0.86),
      '--on-accent': onAccentText(currentAccent),
      '--primary-action': currentAccent,
      '--primary-action-h': shadeHex(currentAccent, 1.12),
    }
    const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.getAttribute('href')
    if (favicon) vars.favicon = favicon
    window.localStorage.setItem(BRANDING_CACHE_KEY, JSON.stringify(vars))
  } catch {
    // Storage may be unavailable (private mode, disabled cookies); branding
    // still applies after the public-settings fetch resolves.
  }
}

/** Synchronously restore a previously-cached accent/favicon before first paint.
 *  Runs before the app mounts so themed content never flashes the default color. */
export function applyCachedBranding() {
  if (typeof document === 'undefined' || !('localStorage' in window)) return
  let raw: string | null = null
  try { raw = window.localStorage.getItem(BRANDING_CACHE_KEY) } catch { return }
  if (!raw) return
  let vars: Record<string, unknown>
  try { vars = JSON.parse(raw) } catch { return }
  if (!vars || typeof vars !== 'object') return
  const root = document.documentElement
  for (const key of ['--accent', '--accent-h', '--accent-d', '--on-accent', '--primary-action', '--primary-action-h']) {
    const value = vars[key]
    if (typeof value === 'string' && value) root.style.setProperty(key, value)
  }
  if (typeof vars.favicon === 'string' && vars.favicon) {
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    if (!link) {
      link = document.createElement('link')
      link.rel = 'icon'
      document.head.appendChild(link)
    }
    link.href = vars.favicon
  }
}

export function applyBranding(settings: {
  accent_color?: string
  logo_type?: string
  logo_preset?: string
  branding_logo?: string
}) {
  applyAccent(settings.accent_color ?? null)
  if (settings.logo_type === 'upload' || settings.logo_type === 'preset') {
    applyLogo(effectiveLogo(settings, null))
  } else {
    logoOverride.value = null
  }
}
