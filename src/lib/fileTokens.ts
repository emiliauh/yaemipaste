function normalizeTokenValue(value: string): string {
  return value.replace(/^\/+/, '').trim()
}

export function fileIdFromFileName(fileName: string): string {
  const normalized = normalizeTokenValue(fileName)
  if (!normalized) return ''
  const dotIndex = normalized.indexOf('.')
  return dotIndex === -1 ? normalized : normalized.slice(0, dotIndex)
}

export function encodeFileTokenFromName(fileName: string): string {
  return encodeURIComponent(fileIdFromFileName(fileName))
}

export function decodeLegacyOrModernFileToken(token: string): string {
  const normalized = normalizeTokenValue(token)
  if (!normalized) return ''

  try {
    const direct = decodeURIComponent(normalized)
    if (direct.includes('.')) return direct
  } catch {
    // fall through to legacy decoding
  }

  try {
    const b64 = normalized.replace(/-/g, '+').replace(/_/g, '/')
    const decoded = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
    if (/^[\x20-\x7E]+$/.test(decoded)) return decoded
  } catch {
    // modern id-only tokens land here
  }

  try {
    return decodeURIComponent(normalized)
  } catch {
    return normalized
  }
}

export function tokenNeedsFileResolution(tokenOrFileName: string): boolean {
  return !!normalizeTokenValue(tokenOrFileName) && !decodeLegacyOrModernFileToken(tokenOrFileName).includes('.')
}
