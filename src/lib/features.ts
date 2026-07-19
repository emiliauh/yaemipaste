function parseEnabled(value: unknown, fallback: boolean): boolean {
  if (typeof value !== 'string') return fallback
  const normalized = value.trim().toLowerCase()
  if (!normalized) return fallback
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return fallback
}

export const AUTH_ENABLED = parseEnabled(import.meta.env.VITE_ENABLE_AUTH, true)

export function isAuthEnabled(): boolean {
  return AUTH_ENABLED
}
