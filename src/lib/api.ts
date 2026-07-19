import {
  encryptedShareUrl,
  encryptFile,
  encryptFileWithPassword,
  forgetEncryptedFile,
  getStoredEncryptedFile,
  originFromUrl,
  passwordEncryptedShareUrl,
  publicPathFromFileName,
  rawFileNameFromPublicPath,
  rememberEncryptedFile,
  type EncryptedMetadata,
} from './e2ee'
import { decodeLegacyOrModernFileToken, encodeFileTokenFromName, tokenNeedsFileResolution } from './fileTokens'
import { isAuthEnabled } from './features'

const DEFAULT_PASTE_API = normalizeApiBase(import.meta.env.VITE_PASTE_API ?? '/api')
const AUTH_API = (import.meta.env.VITE_AUTH_API ?? '/auth').replace(/\/$/, '')
const SHAREX_ENABLED = (import.meta.env.VITE_ENABLE_SHAREX ?? '1').trim() === '1'
const PUBLIC_SITE_ORIGIN = (import.meta.env.VITE_PUBLIC_SITE_ORIGIN ?? '').trim().replace(/\/$/, '')
const TOKEN_OWNER_PATH = (import.meta.env.VITE_TOKEN_OWNER_PATH ?? '/api/token-owner').trim()
const FILE_RESOLVE_BASE = (() => {
  const configured = import.meta.env.VITE_FILE_RESOLVE_BASE
  if (typeof configured !== 'string') return '/resolve'
  return configured.trim().replace(/\/$/, '')
})()
const API_BASE_KEY = 'rp_api_base'
const REMEMBER_ME_KEY = 'rp_remember_me'
const AUTH_KEYS = ['rp_jwt', 'rp_token', 'rp_username', 'rp_is_admin'] as const
const FILE_TOKEN_MAP_KEY = 'rp_file_token_map'
let runtimePublicSettings: PublicAdminSettings | null = null

export interface UploadProgress {
  phase: 'encrypting' | 'uploading' | 'complete'
  percent: number
}

export interface UploadResult {
  fileName: string
  url: string
}

function getToken(): string {
  return readAuthValue('rp_token')
}

function getJwt(): string {
  return readAuthValue('rp_jwt')
}

function requireAuthEnabled() {
  if (!isAuthEnabled()) throw new Error('Authentication is disabled for this deployment')
}

function tokenHeader(): Record<string, string> {
  const token = getToken().trim()
  return token ? { Authorization: token } : {}
}

function jwtBearerHeader(): Record<string, string> {
  const jwt = getJwt().trim()
  return jwt ? { Authorization: `Bearer ${jwt}` } : {}
}

function normalizeApiBase(value: string): string {
  const trimmed = value.trim()
  if (!trimmed || trimmed === '/') return '/api'
  return trimmed.replace(/\/$/, '')
}

function isSafeApiBase(value: string): boolean {
  if (!value.trim()) return true
  if (value.startsWith('/')) return true
  try {
    const parsed = new URL(value)
    if (!['http:', 'https:'].includes(parsed.protocol)) return false
    if (parsed.username || parsed.password) return false
    return !!parsed.host
  } catch {
    return false
  }
}

function sanitizePublicOrigin(origin: string): string | null {
  const trimmed = origin.trim()
  if (!trimmed) return null
  try {
    const parsed = new URL(trimmed)
    if (!['http:', 'https:'].includes(parsed.protocol)) return null
    if (parsed.username || parsed.password) return null
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return null
  }
}

function runtimeBaseApi(): string | null {
  const value = runtimePublicSettings?.base_api_url?.trim() ?? ''
  return value && isSafeApiBase(value) ? normalizeApiBase(value) : null
}

function publicOriginFromApiOrigin(origin: string): string {
  try {
    const url = new URL(origin)
    if (url.hostname.startsWith('papi.')) {
      return `${url.protocol}//paste.${url.hostname.slice(5)}${url.port ? `:${url.port}` : ''}`
    }
  } catch {
    // fallback to provided origin
  }
  return origin
}

export function applyRuntimePublicSettings(settings: PublicAdminSettings) {
  runtimePublicSettings = settings
}

export function getDefaultPasteApiBase(): string {
  return runtimeBaseApi() ?? DEFAULT_PASTE_API
}

export function getPasteApiBase(): string {
  const defaultBase = runtimeBaseApi() ?? DEFAULT_PASTE_API
  if (typeof localStorage === 'undefined') return defaultBase
  const configured = localStorage.getItem(API_BASE_KEY)
  if (configured?.trim()) {
    if (isSafeApiBase(configured)) return normalizeApiBase(configured)
    localStorage.removeItem(API_BASE_KEY)
  }
  return runtimeBaseApi() ?? DEFAULT_PASTE_API
}

export function setPasteApiBase(value: string) {
  if (typeof localStorage === 'undefined') return
  if (!isSafeApiBase(value)) throw new Error('Invalid API base URL. Use a relative path or http(s) URL.')
  if (!value.trim()) localStorage.removeItem(API_BASE_KEY)
  else localStorage.setItem(API_BASE_KEY, normalizeApiBase(value))
}

export function resetPasteApiBase() {
  if (typeof localStorage === 'undefined') return
  localStorage.removeItem(API_BASE_KEY)
}

interface AuthSessionResponse {
  access_token: string
  paste_token: string
  username: string
  is_admin?: boolean
}

async function responseDetail(response: Response, fallback: string): Promise<string> {
  const jsonProbe = response.clone()
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    try {
      const payload = await jsonProbe.json() as { detail?: unknown; message?: unknown }
      const detail = typeof payload.detail === 'string' ? payload.detail
        : typeof payload.message === 'string' ? payload.message
          : ''
      if (detail.trim()) return detail.trim()
    } catch {
      // fallback below
    }
  }
  const text = (await response.text()).trim()
  if (!text) return fallback
  try {
    const payload = JSON.parse(text) as { detail?: unknown; message?: unknown }
    const detail = typeof payload.detail === 'string' ? payload.detail
      : typeof payload.message === 'string' ? payload.message
        : ''
    if (detail.trim()) return detail.trim()
  } catch {
    // plain text fallback
  }
  return text.length > 180 ? `${text.slice(0, 177)}...` : text
}

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  try {
    return await response.json() as T
  } catch {
    throw new Error(fallback)
  }
}

function readAuthValue(key: (typeof AUTH_KEYS)[number]): string {
  return localStorage.getItem(key) ?? sessionStorage.getItem(key) ?? ''
}

function clearAuthTokens() {
  for (const key of AUTH_KEYS) {
    localStorage.removeItem(key)
    sessionStorage.removeItem(key)
  }
}

function writeAuthUsername(username: string) {
  const normalized = username.trim()
  if (localStorage.getItem('rp_username') != null || localStorage.getItem('rp_token') != null || localStorage.getItem('rp_jwt') != null) {
    if (normalized) localStorage.setItem('rp_username', normalized)
    else localStorage.removeItem('rp_username')
  }
  if (sessionStorage.getItem('rp_username') != null || sessionStorage.getItem('rp_token') != null || sessionStorage.getItem('rp_jwt') != null) {
    if (normalized) sessionStorage.setItem('rp_username', normalized)
    else sessionStorage.removeItem('rp_username')
  }
}

function readResolvedFileNames(): Record<string, string> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const parsed = JSON.parse(localStorage.getItem(FILE_TOKEN_MAP_KEY) ?? '{}') as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const next: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && value.trim()) next[key] = value
    }
    return next
  } catch {
    return {}
  }
}

function writeResolvedFileNames(entries: Record<string, string>) {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(FILE_TOKEN_MAP_KEY, JSON.stringify(entries))
}

export function rememberResolvedFileName(fileName: string) {
  if (typeof localStorage === 'undefined') return
  const token = decodeFileToken(encodeFileToken(fileName))
  if (!token) return
  const entries = readResolvedFileNames()
  entries[token] = fileName
  const limitedEntries = Object.entries(entries).slice(-200)
  writeResolvedFileNames(Object.fromEntries(limitedEntries))
}

function forgetResolvedFileName(fileName: string) {
  if (typeof localStorage === 'undefined') return
  const token = decodeFileToken(encodeFileToken(fileName))
  if (!token) return
  const entries = readResolvedFileNames()
  delete entries[token]
  writeResolvedFileNames(entries)
}

function saveAuthSession(data: AuthSessionResponse, rememberMe = true) {
  clearAuthTokens()
  const storage = rememberMe ? localStorage : sessionStorage
  storage.setItem('rp_jwt', data.access_token)
  storage.setItem('rp_token', data.paste_token)
  storage.setItem('rp_username', data.username)
  storage.setItem('rp_is_admin', data.is_admin ? '1' : '0')
  localStorage.setItem(REMEMBER_ME_KEY, rememberMe ? '1' : '0')
}

function saveTokenSession(token: string, rememberMe = true) {
  clearAuthTokens()
  const storage = rememberMe ? localStorage : sessionStorage
  storage.setItem('rp_token', token)
  storage.setItem('rp_username', 'token-user')
  localStorage.setItem(REMEMBER_ME_KEY, rememberMe ? '1' : '0')
}

export function getRememberPreference(): boolean {
  return localStorage.getItem(REMEMBER_ME_KEY) !== '0'
}

export function setRememberPreference(rememberMe: boolean) {
  localStorage.setItem(REMEMBER_ME_KEY, rememberMe ? '1' : '0')
}

export function getAuthUsername(): string {
  return readAuthValue('rp_username')
}

export function getAuthJwt(): string {
  return getJwt()
}

export function isAuthAdmin(): boolean {
  return readAuthValue('rp_is_admin') === '1'
}

export function hasAccountAuth(): boolean {
  if (!isAuthEnabled()) return false
  return !!readAuthValue('rp_jwt')
}

// ── Auth service ────────────────────────────────────────────────────────────

export async function authRegister(username: string, password: string, token: string) {
  requireAuthEnabled()
  const r = await fetch(`${AUTH_API}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, token }),
  })
  if (!r.ok) throw new Error(await responseDetail(r, 'Registration failed'))
  return readJson(r, 'Registration failed')
}

export async function authLogin(
  username: string,
  password: string,
  options: { rememberMe?: boolean; turnstileToken?: string } = {},
) {
  requireAuthEnabled()
  const r = await fetch(`${AUTH_API}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username,
      password,
      turnstile_token: options.turnstileToken ?? '',
    }),
  })
  if (!r.ok) throw new Error(await responseDetail(r, 'Login failed'))
  const data = await readJson<AuthSessionResponse>(r, 'Login failed')
  saveAuthSession(data, options.rememberMe ?? getRememberPreference())
  return data
}

export async function authMe() {
  requireAuthEnabled()
  const r = await fetch(`${AUTH_API}/me`, {
    headers: jwtBearerHeader(),
  })
  if (!r.ok) throw new Error(await responseDetail(r, 'Unauthorized'))
  return readJson(r, 'Could not load account details')
}

/** Refresh the cached role so admin changes are reflected without a relogin. */
export async function refreshAuthAdmin(): Promise<boolean> {
  if (!hasAccountAuth()) return isAuthAdmin()
  try {
    const data = await authMe() as { is_admin?: unknown }
    const storage = sessionStorage.getItem('rp_jwt') ? sessionStorage : localStorage
    storage.setItem('rp_is_admin', data.is_admin === true ? '1' : '0')
    return data.is_admin === true
  } catch {
    return isAuthAdmin()
  }
}

function tokenOwnerUrl(origin = publicSiteOrigin()): string {
  const base = TOKEN_OWNER_PATH.trim()
  if (!base) throw new Error('Token owner lookup is disabled for this deployment')
  const cacheBuster = `cb=${Date.now().toString(36)}`
  if (/^https?:\/\//i.test(base)) {
    return `${base}${base.includes('?') ? '&' : '?'}${cacheBuster}`
  }
  const normalizedPath = base.startsWith('/') ? base : `/${base}`
  return `${publicSiteOrigin(origin)}${normalizedPath}?${cacheBuster}`
}

export async function hydrateSessionIdentity(): Promise<string> {
  if (!isAuthEnabled()) return ''
  const current = getAuthUsername().trim()
  if (current && current !== 'token-user') return current

  const jwt = getJwt().trim()
  if (jwt) {
    try {
      const me = await authMe() as { username?: unknown }
      const username = typeof me.username === 'string' ? me.username.trim() : ''
      if (username) {
        writeAuthUsername(username)
        return username
      }
    } catch {
      // fall through to token lookup when JWT bootstrap fails
    }
  }

  const token = getToken().trim()
  if (!token) return current

  try {
    const r = await fetch(tokenOwnerUrl(), {
      cache: 'no-store',
      headers: { Authorization: token },
    })
    if (!r.ok) return current
    const data = await readJson<{ username?: unknown }>(r, 'Could not resolve token owner')
    const username = typeof data.username === 'string' ? data.username.trim() : ''
    if (!username) return current
    writeAuthUsername(username)
    return username
  } catch {
    return current
  }
}

export function authLogout() {
  clearAuthTokens()
}

export async function authChangePassword(currentPassword: string, nextPassword: string) {
  requireAuthEnabled()
  const payload = {
    old_password: currentPassword,
    new_password: nextPassword,
  }
  const endpoints = [`${AUTH_API}/password/change`, `${AUTH_API}/change-password`]
  for (const endpoint of endpoints) {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: {
        ...jwtBearerHeader(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
    if (r.status === 404) continue
    if (!r.ok) throw new Error(await responseDetail(r, 'Could not change password'))
    return
  }
  throw new Error('Password change endpoint is not available on this server')
}

export async function authLogoutAllDevices() {
  requireAuthEnabled()
  const endpoints = [`${AUTH_API}/logout-all-devices`, `${AUTH_API}/sessions/logout-all`]
  for (const endpoint of endpoints) {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: jwtBearerHeader(),
    })
    if (r.status === 404) continue
    if (!r.ok) throw new Error(await responseDetail(r, 'Could not log out all devices'))
    clearAuthTokens()
    return
  }
  throw new Error('Global logout endpoint is not available on this server')
}

export interface PasskeySummary {
  id: number
  credential_id: string
  created_at: number
  last_used_at: number | null
  transports: string[]
}

export async function authPasskeysList(): Promise<PasskeySummary[]> {
  requireAuthEnabled()
  const r = await fetch(`${AUTH_API}/passkeys`, {
    cache: 'no-store',
    headers: jwtBearerHeader(),
  })
  if (!r.ok) throw new Error(await responseDetail(r, 'Could not load passkeys'))
  return readJson(r, 'Could not load passkeys')
}

export async function authPasskeyRegisterBegin() {
  requireAuthEnabled()
  const r = await fetch(`${AUTH_API}/passkeys/register/begin`, {
    method: 'POST',
    headers: jwtBearerHeader(),
  })
  if (!r.ok) throw new Error(await responseDetail(r, 'Could not start passkey registration'))
  return readJson(r, 'Could not start passkey registration')
}

export async function authPasskeyRegisterFinish(credential: unknown) {
  requireAuthEnabled()
  const r = await fetch(`${AUTH_API}/passkeys/register/finish`, {
    method: 'POST',
    headers: {
      ...jwtBearerHeader(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ credential }),
  })
  if (!r.ok) throw new Error(await responseDetail(r, 'Could not register passkey'))
  return readJson(r, 'Could not register passkey')
}

export async function authPasskeyDelete(id: number) {
  requireAuthEnabled()
  const r = await fetch(`${AUTH_API}/passkeys/${id}`, {
    method: 'DELETE',
    headers: jwtBearerHeader(),
  })
  if (!r.ok) throw new Error(await responseDetail(r, 'Could not delete passkey'))
}

export async function authPasskeyLoginBegin(username: string) {
  requireAuthEnabled()
  const r = await fetch(`${AUTH_API}/passkeys/auth/begin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username }),
  })
  if (!r.ok) throw new Error(await responseDetail(r, 'Could not start passkey login'))
  return readJson(r, 'Could not start passkey login')
}

export async function authPasskeyLoginFinish(username: string, credential: unknown, rememberMe = getRememberPreference()) {
  requireAuthEnabled()
  const r = await fetch(`${AUTH_API}/passkeys/auth/finish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, credential }),
  })
  if (!r.ok) throw new Error(await responseDetail(r, 'Passkey login failed'))
  const data = await readJson<AuthSessionResponse>(r, 'Passkey login failed')
  saveAuthSession(data, rememberMe)
  return data
}

async function uploaderIdentity(): Promise<string> {
  const username = (await hydrateSessionIdentity()).trim() || getAuthUsername().trim()
  if (username && username !== 'token-user') return username
  return getToken().trim() ? 'Unknown (token user)' : 'Anonymous'
}

export function loginWithToken(token: string, rememberMe = true) {
  requireAuthEnabled()
  saveTokenSession(token, rememberMe)
}

export async function authTokenStatus(token: string): Promise<'available' | 'used' | 'invalid'> {
  requireAuthEnabled()
  const r = await fetch(`${AUTH_API}/token/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  if (!r.ok) throw new Error(await responseDetail(r, 'Could not verify token'))
  const data = await readJson<{ status?: 'available' | 'used' | 'invalid' }>(r, 'Could not verify token')
  if (!data.status) throw new Error('Could not verify token')
  return data.status
}

export async function getShareXConfig(): Promise<Blob> {
  requireAuthEnabled()
  if (!SHAREX_ENABLED) throw new Error('ShareX integration is disabled for this deployment')
  const r = await fetch(`${AUTH_API}/sharex`, {
    headers: jwtBearerHeader(),
  })
  if (!r.ok) throw new Error(await responseDetail(r, 'Failed to get ShareX config'))
  const raw = await r.text()
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    throw new Error('ShareX config payload is invalid')
  }

  const headers = (!parsed.Headers || typeof parsed.Headers !== 'object' || Array.isArray(parsed.Headers))
    ? {}
    : { ...(parsed.Headers as Record<string, unknown>) }
  headers['X-Upload-Client'] = 'ShareX'
  parsed.Headers = headers

  // Override URL to return the frontend preview link instead of the raw API URL.
  // ShareX reserves `|` as the syntax parameter delimiter, so regex templates must
  // avoid unescaped pipes entirely unless they are the final capture-group selector.
  // We only need the first file token from supported response shapes like:
  // - `hash.ext`
  // - `hash/file.ext`
  // - `file/hash/preview`
  parsed.URL = `${publicSiteOrigin()}/file/{regex:^(?:https?://[^/]+/)?(?:file/)?([A-Za-z0-9_-]+)|1}/preview`

  // Ownership and provenance are separate fields.  Keeping the account name
  // canonical here prevents the Admin library from rendering both a
  // "name (ShareX)" label and a ShareX badge for the same upload.
  const uploaderLabel = await uploaderIdentity()
  const replaceUploaderSyntax = (value: string): string => value
    .replace(/\$uploader[^$]*\$/gi, uploaderLabel)
    .replace(/%uploader%/gi, uploaderLabel)
    .replace(/\{uploader[^}]*\}/gi, uploaderLabel)
  const sanitizeUploaderSyntax = (value: unknown): unknown => {
    if (typeof value === 'string') return replaceUploaderSyntax(value)
    if (Array.isArray(value)) return value.map((item) => sanitizeUploaderSyntax(item))
    if (value && typeof value === 'object') {
      const next: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        next[key] = sanitizeUploaderSyntax(item)
      }
      return next
    }
    return value
  }

  const rawArgs = parsed.Arguments && typeof parsed.Arguments === 'object' && !Array.isArray(parsed.Arguments)
    ? { ...(parsed.Arguments as Record<string, unknown>) }
    : {}
  const args: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(rawArgs)) {
    const normalizedKey = key.toLowerCase()
    if (normalizedKey === 'uploader' || normalizedKey === 'meta' || normalizedKey === 'source') continue
    args[key] = sanitizeUploaderSyntax(value)
  }
  // ShareX parses argument values through its own placeholder engine before upload.
  // Keep uploader/source as flat multipart fields instead of embedding JSON in `meta`.
  args.uploader = uploaderLabel
  args.source = 'ShareX'
  parsed.Arguments = args

  return new Blob([JSON.stringify(parsed, null, 2)], { type: 'application/json' })
}

export function isShareXEnabled(): boolean {
  return SHAREX_ENABLED
}

// ── Rustypaste API ──────────────────────────────────────────────────────────

export interface PasteFile {
  file_name: string
  file_size: number
  expires_at: string | null
  created_at: string | null
}

interface RawPasteFile {
  file_name: string
  file_size: number
  expires_at_utc?: string | null
  creation_date_utc?: string | null
}

export async function listFiles(): Promise<PasteFile[]> {
  // Authenticated list responses must never be reused after an admin purge.
  // The request cache mode protects the browser; the nonce also prevents an
  // intermediary from replaying an older authenticated response.
  const r = await fetch(`${getPasteApiBase()}/list?cb=${Date.now().toString(36)}`, {
    cache: 'no-store',
    headers: tokenHeader(),
  })
  if (!r.ok) throw new Error(await responseDetail(r, 'Failed to list files'))
  const data = await readJson<RawPasteFile[]>(r, 'Failed to list files')
  return data.map((f) => {
    rememberResolvedFileName(f.file_name)
    return {
    file_name: f.file_name,
    file_size: f.file_size,
    expires_at: f.expires_at_utc ?? null,
    created_at: f.creation_date_utc ?? null,
    }
  })
}

function pasteUploadUrl(): string {
  return `${getPasteApiBase()}/`
}

export interface UploadOptions {
  expiry?: string
  encrypt?: boolean
  password?: string
  keepFileName?: boolean
  onProgress?: (progress: UploadProgress) => void
}

interface UploadMeta {
  keepFileName: boolean
  originalName: string
  uploader: string
  source: string
  passwordSalt?: string
}

function extractUploadTargetFromJson(value: unknown): string | null {
  if (typeof value === 'string') {
    const normalized = value.trim()
    return normalized || null
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = extractUploadTargetFromJson(item)
      if (nested) return nested
    }
    return null
  }
  if (!value || typeof value !== 'object') return null

  const payload = value as Record<string, unknown>
  const status = typeof payload.status === 'string' ? payload.status.toLowerCase() : ''
  const message = typeof payload.message === 'string' ? payload.message.toLowerCase() : ''
  if (status === 'ok' && message.includes('api root')) {
    throw new Error('Upload endpoint returned unexpected JSON. Check your VITE_PASTE_API routing.')
  }

  const preferredKeys = [
    'url',
    'file_url',
    'link',
    'href',
    'location',
    'path',
    'target',
    'file',
    'file_name',
    'filename',
    'name',
  ] as const
  for (const key of preferredKeys) {
    const nested = extractUploadTargetFromJson(payload[key])
    if (nested) return nested
  }
  for (const containerKey of ['data', 'result', 'payload']) {
    const nested = extractUploadTargetFromJson(payload[containerKey])
    if (nested) return nested
  }
  return null
}

function extractUploadTarget(responseText: string): string {
  const normalized = responseText.trim()
  if (!normalized) throw new Error('Upload endpoint returned an empty response')
  try {
    const payload = JSON.parse(normalized) as unknown
    const target = extractUploadTargetFromJson(payload)
    if (!target) {
      throw new Error('Upload endpoint returned unexpected JSON. Check your VITE_PASTE_API routing.')
    }
    return target
  } catch (error) {
    if (error instanceof Error && error.message.includes('unexpected JSON')) throw error
  }
  const firstLine = normalized.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? ''
  if (!firstLine) throw new Error('Upload endpoint returned an empty response')
  if (firstLine.startsWith('{') || firstLine.startsWith('[')) {
    throw new Error('Upload endpoint returned unexpected JSON. Check your VITE_PASTE_API routing.')
  }
  return firstLine
}

export async function uploadFile(file: File, options: UploadOptions = {}): Promise<UploadResult> {
  const shouldEncrypt = options.encrypt ?? false
  const password = options.password?.trim() ?? ''
  const shouldEncryptWithPassword = !!password
  const isAnyEncrypt = shouldEncrypt || shouldEncryptWithPassword
  const shouldKeepFileName = options.keepFileName ?? true
  const expiry = options.expiry
  const onProgress = options.onProgress
  let uploadFileValue = file
  let encryptedKey: string | null = null
  let encryptedSalt: string | null = null
  let encryptedMetadata: EncryptedMetadata | null = null
  const resolvedUploader = await uploaderIdentity()
  onProgress?.({ phase: isAnyEncrypt ? 'encrypting' : 'uploading', percent: isAnyEncrypt ? 0 : 1 })
  if (shouldEncryptWithPassword) {
    const encrypted = await encryptFileWithPassword(file, password, resolvedUploader)
    uploadFileValue = new File([encrypted.blob], `${file.name}.rpenc`, { type: 'application/octet-stream' })
    encryptedSalt = encrypted.salt
    encryptedMetadata = encrypted.metadata
  } else if (shouldEncrypt) {
    const encrypted = await encryptFile(file, resolvedUploader)
    uploadFileValue = new File([encrypted.blob], `${file.name}.rpenc`, { type: 'application/octet-stream' })
    encryptedKey = encrypted.key
    encryptedMetadata = encrypted.metadata
  }
  const form = new FormData()
  const uploadMeta: UploadMeta = {
    keepFileName: shouldKeepFileName,
    originalName: file.name,
    uploader: resolvedUploader,
    source: 'WebUI',
    ...(encryptedSalt ? { passwordSalt: encryptedSalt } : {}),
  }
  form.append('meta', JSON.stringify(uploadMeta))
  form.append('file', uploadFileValue)
  const headers: Record<string, string> = tokenHeader()
  if (expiry) headers.expire = expiry
  const uploadTarget = extractUploadTarget(await uploadForm(form, headers, onProgress))
  const fileName = fileNameFromUrl(uploadTarget)
  if (!fileName || fileName.includes('{') || fileName.includes('}') || fileName.includes('"')) {
    throw new Error('Upload endpoint returned an invalid file URL')
  }
  const origin = publicSiteOrigin(originFromUrl(uploadTarget))
  rememberResolvedFileName(fileName)
  if (encryptedSalt && encryptedMetadata) {
    rememberEncryptedFile(fileName, `pw:${encryptedSalt}`, encryptedMetadata, origin)
  } else if (encryptedKey && encryptedMetadata) {
    rememberEncryptedFile(fileName, encryptedKey, encryptedMetadata, origin)
  } else {
    forgetEncryptedFile(fileName)
  }
  onProgress?.({ phase: 'complete', percent: 100 })
  if (encryptedSalt) return { fileName, url: passwordEncryptedShareUrl(fileName, encryptedSalt, origin) }
  if (encryptedKey) return { fileName, url: encryptedShareUrl(fileName, encryptedKey, origin) }
  return { fileName, url: publicPreviewUrl(fileName, origin) }
}

export async function uploadText(text: string, options: UploadOptions = {}): Promise<UploadResult> {
  return uploadFile(new File([text], 'paste.txt', { type: 'text/plain' }), options)
}

function uploadForm(
  form: FormData,
  headers: Record<string, string>,
  onProgress?: (progress: UploadProgress) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', pasteUploadUrl())
    for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value)
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) {
        onProgress?.({ phase: 'uploading', percent: 10 })
        return
      }
      onProgress?.({ phase: 'uploading', percent: Math.max(1, Math.min(99, Math.round((event.loaded / event.total) * 100))) })
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.responseText)
      else reject(new Error(xhr.responseText || 'Upload failed'))
    }
    xhr.onerror = () => reject(new Error('Upload failed'))
    xhr.onabort = () => reject(new Error('Upload cancelled'))
    xhr.send(form)
  })
}

export async function deleteFile(filename: string): Promise<void> {
  const r = await fetch(`${getPasteApiBase()}/${filename}`, {
    method: 'DELETE',
    headers: tokenHeader(),
  })
  if (!r.ok) throw new Error('Delete failed')
  forgetEncryptedFile(filename)
  forgetResolvedFileName(filename)
}

export interface PublicFileMeta {
  file_name: string
  display_name: string
  uploader: string
  source?: string | null
  upload_date_utc: string | null
  download_name: string
  file_size: number
  mime_type: string
}

export function displayUploaderName(value: string | null | undefined): string {
  const normalized = value?.trim() ?? ''
  if (!normalized || ['unknown', 'unknown (token user)', 'unattributed'].includes(normalized.toLowerCase())) return 'Anonymous'
  return normalized
}

const GENERIC_PUBLIC_MIME_TYPES = new Set([
  '',
  'application/octet-stream',
  'binary/octet-stream',
  'application/force-download',
])

function isNumericExtensionSegment(value: string): boolean {
  return /^\d{6,}$/.test(value)
}

function knownMimeFromExtension(value: string): string {
  const ext = value.toLowerCase()
  if (['jpg', 'jpeg'].includes(ext)) return 'image/jpeg'
  if (ext === 'png') return 'image/png'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'avif') return 'image/avif'
  if (ext === 'svg') return 'image/svg+xml'
  if (ext === 'bmp') return 'image/bmp'
  if (['tif', 'tiff'].includes(ext)) return 'image/tiff'
  if (ext === 'ico') return 'image/x-icon'
  if (ext === 'mp4') return 'video/mp4'
  if (ext === 'webm') return 'video/webm'
  if (ext === 'mov') return 'video/quicktime'
  if (ext === 'avi') return 'video/x-msvideo'
  if (ext === 'mkv') return 'video/x-matroska'
  if (ext === 'ogv') return 'video/ogg'
  if (ext === 'm4v') return 'video/x-m4v'
  if (ext === '3gp') return 'video/3gpp'
  if (ext === 'pdf') return 'application/pdf'
  if (['txt', 'log', 'md', 'markdown', 'csv', 'json', 'xml', 'yml', 'yaml', 'toml', 'ini', 'conf', 'cfg'].includes(ext)) return 'text/plain'
  if (['js', 'ts', 'tsx', 'jsx', 'py', 'rs', 'go', 'java', 'c', 'cc', 'cpp', 'h', 'hpp', 'css', 'htm', 'html'].includes(ext)) return 'text/plain'
  return ''
}

function cleanFileNameCandidate(value: string): string {
  return value.replace(/^\/+/, '').trim()
}

function inferMimeTypeFromFileName(fileName: string): string {
  const normalized = cleanFileNameCandidate(fileName)
  if (!normalized) return ''
  const lastSegment = normalized.split('/').pop() ?? normalized
  const parts = lastSegment.split('.').filter(Boolean)
  if (parts.length < 2) return ''
  for (let index = parts.length - 1; index >= 1; index -= 1) {
    const segment = parts[index].toLowerCase()
    if (isNumericExtensionSegment(segment)) continue
    const mime = knownMimeFromExtension(segment)
    if (mime) return mime
  }
  return ''
}

function stripGeneratedPreviewSuffix(fileName: string): string {
  const normalized = cleanFileNameCandidate(fileName)
  const lastSegment = normalized.split('/').pop() ?? normalized
  const parts = lastSegment.split('.')
  if (parts.length < 3) return normalized
  const tail = parts[parts.length - 1]
  const ext = parts[parts.length - 2]
  if (!isNumericExtensionSegment(tail) || !knownMimeFromExtension(ext)) return normalized
  return parts.slice(0, -1).join('.')
}

export function preferredPublicFileName(meta: PublicFileMeta | null | undefined, fallback = ''): string {
  const candidates = [
    meta?.download_name,
    meta?.display_name,
    fallback,
    meta?.file_name,
  ]
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    const normalized = cleanFileNameCandidate(candidate)
    if (!normalized) continue
    return stripGeneratedPreviewSuffix(normalized)
  }
  return ''
}

export function effectivePublicMimeType(meta: PublicFileMeta | null | undefined, fallback = ''): string {
  const reported = (meta?.mime_type ?? '').trim().toLowerCase()
  if (!GENERIC_PUBLIC_MIME_TYPES.has(reported)) return reported
  const candidates = [
    meta?.download_name,
    meta?.display_name,
    fallback,
    meta?.file_name,
  ]
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    const inferred = inferMimeTypeFromFileName(candidate)
    if (inferred) return inferred
  }
  return reported || 'application/octet-stream'
}

export async function getPublicFileMeta(fileName: string): Promise<PublicFileMeta> {
  const encodedName = encodeURIComponent(fileName)
  const urls = [
    `${getPasteApiBase()}/meta/${encodedName}`,
    `${publicSiteOrigin()}/api/meta/${encodedName}`,
  ].filter((url, index, all) => all.indexOf(url) === index)
  let notFound = false
  let lastError = 'Could not load file metadata'
  for (const url of urls) {
    try {
      const response = await fetch(url)
      if (response.ok) {
        rememberResolvedFileName(fileName)
        return readJson(response, 'Could not load file metadata')
      }
      if (response.status === 404) notFound = true
      else lastError = await responseDetail(response, lastError)
    } catch {
      // A public preview remains usable when a separately configured API host is unavailable.
    }
  }
  throw new Error(notFound ? 'File not found or expired' : lastError)
}

export function publicSiteOrigin(origin = window.location.origin): string {
  if (PUBLIC_SITE_ORIGIN) {
    const configured = sanitizePublicOrigin(PUBLIC_SITE_ORIGIN)
    if (configured) return configured
  }
  const runtimeApi = runtimeBaseApi()
  if (runtimeApi) return publicOriginFromApiOrigin(sanitizePublicOrigin(runtimeApi) ?? origin)
  return publicOriginFromApiOrigin(origin)
}

export function publicShortFileUrl(fileName: string, origin = publicSiteOrigin()): string {
  return `${origin}/${encodeURIComponent(fileName)}`
}

export function publicFileUrl(fileName: string, origin = publicSiteOrigin()): string {
  return `${origin}/${publicPathFromFileName(fileName)}`
}

export function encodeFileToken(filename: string): string {
  return encodeFileTokenFromName(filename)
}

export function decodeFileToken(token: string): string {
  return decodeLegacyOrModernFileToken(token)
}

export function publicPreviewUrl(fileName: string, origin = publicSiteOrigin()): string {
  return `${origin}/file/${encodeFileToken(fileName)}/preview`
}

export function publicDownloadUrl(fileName: string, origin = publicSiteOrigin()): string {
  return `${origin}/file/${encodeFileToken(fileName)}/download`
}

export function publicApiFileUrl(fileName: string): string {
  return `${getPasteApiBase()}/${encodeURIComponent(fileName)}`
}

export function publicRawFileUrl(fileName: string): string {
  return `${publicSiteOrigin()}/api/${encodeURIComponent(fileName)}?raw=1`
}

export function browserFileUrl(fileName: string, query = ''): string {
  const base = getPasteApiBase()
  return `${base}/${encodeURIComponent(fileName)}${query ? `?${query}` : ''}`
}

export function fileUrl(filename: string): string {
  return browserFileUrl(filename, 'raw=1')
}

export function adminUploadContentUrl(path: string): string {
  return `${AUTH_API}/admin/uploads/content?path=${encodeURIComponent(path)}`
}

export function downloadFileUrl(filename: string): string {
  return browserFileUrl(filename, 'download=true')
}

export function shareUrl(filename: string): string {
  const encrypted = getStoredEncryptedFile(filename)
  if (encrypted) return encryptedShareUrl(filename, encrypted.key, publicSiteOrigin(encrypted.origin))
  return publicPreviewUrl(filename, publicSiteOrigin())
}

export function fileNameFromUrl(value: string): string {
  try {
    const path = decodeURIComponent(new URL(value, window.location.origin).pathname.replace(/^\/+/, ''))
    const [first = '', second = ''] = path.split('/')
    if (first === 'file' && second) {
      const decoded = decodeFileToken(second.split('+')[0])
      if (decoded) return decoded
    }
    return path.includes('/') ? rawFileNameFromPublicPath(path) : path
  } catch {
    const path = value.replace(/^https?:\/\/[^/]+\//, '').replace(/^\/+/, '')
    const [first = '', second = ''] = path.split('/')
    if (first === 'file' && second) {
      const decoded = decodeFileToken(second.split('+')[0])
      if (decoded) return decoded
    }
    return path.includes('/') ? rawFileNameFromPublicPath(path) : path
  }
}

export interface ResolvedFileLookup {
  fileName: string
  uploader: string | null
}

function fileResolveUrls(token: string, origin = publicSiteOrigin()): string[] {
  const bases = [
    FILE_RESOLVE_BASE,
    '/resolve',
    '/api/resolve',
  ].filter((base, index, all): base is string => !!base && all.indexOf(base) === index)
  if (bases.length === 0) throw new Error('Public file-token resolution is disabled for this deployment')
  const cleanToken = decodeFileToken(token)
  const cacheBuster = `cb=${Date.now().toString(36)}`
  return bases.map((base) => {
    if (/^https?:\/\//i.test(base)) return `${base}/${encodeURIComponent(cleanToken)}?${cacheBuster}`
    return `${publicSiteOrigin(origin)}${base}/${encodeURIComponent(cleanToken)}?${cacheBuster}`
  })
}

function normalizeResolvedUploader(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.toLowerCase() === 'unknown (token user)' || trimmed.toLowerCase() === 'unknown') return null
  return trimmed
}

export async function resolveFileLookup(tokenOrFileName: string, origin = publicSiteOrigin()): Promise<ResolvedFileLookup> {
  const decoded = decodeFileToken(tokenOrFileName)
  if (!decoded) throw new Error('Missing file name')
  if (!tokenNeedsFileResolution(decoded)) return { fileName: decoded, uploader: null }
  const localMatch = readResolvedFileNames()[decoded]
  if (localMatch) return { fileName: localMatch, uploader: null }
  if (!FILE_RESOLVE_BASE) {
    throw new Error('This file link needs resolver support, but resolver fallback is disabled on this deployment')
  }

  let lastError = 'Could not resolve the file URL'
  let sawNotFound = false
  for (const url of fileResolveUrls(decoded, origin)) {
    let response: Response
    try {
      response = await fetch(url, { cache: 'no-store' })
    } catch {
      continue
    }
    if (!response.ok) {
      if (response.status === 404) {
        sawNotFound = true
        continue
      }
      if (response.status === 401 || response.status === 403) {
        throw new Error(await responseDetail(response, 'Could not resolve the file URL'))
      }
      lastError = await responseDetail(response, 'Could not resolve the file URL')
      continue
    }
    const payload = await readJson<{ file_name?: string; uploader?: unknown; owner?: unknown }>(response, 'Could not resolve the file URL')
    if (!payload.file_name || typeof payload.file_name !== 'string') throw new Error('Could not resolve the file URL')
    const uploader = normalizeResolvedUploader(payload.uploader) ?? normalizeResolvedUploader(payload.owner)
    return { fileName: payload.file_name, uploader }
  }
  throw new Error(sawNotFound ? 'File not found or expired' : lastError)
}

export async function resolveFileName(tokenOrFileName: string, origin = publicSiteOrigin()): Promise<string> {
  const resolved = await resolveFileLookup(tokenOrFileName, origin)
  return resolved.fileName
}


export interface AdminUpload {
  path: string
  owner: string | null
  file_name: string | null
  display_name: string | null
  uploader: string | null
  source: string | null
  size_bytes: number
  created_at: number | null
  expires_at: number | null
  expired: boolean
  content_type: string | null
  password_salt?: string | null
}

export interface AdminUser {
  username: string
  created_at: number
  is_admin: boolean
  suspended_at: number | null
  suspended_reason: string | null
  upload_token_preview: string
  upload_count: number
  disk_usage_bytes: number
}

export interface AdminDashboard {
  total_disk_usage_bytes: number
  upload_count: number
  user_count: number
  suspended_user_count: number
  admin_count: number
  users: AdminUser[]
  recent_uploads: AdminUpload[]
  recent_audit: AdminAuditEntry[]
  failed_webhook_deliveries: WebhookDelivery[]
  config_status: Record<string, unknown>
  warnings: string[]
}

export interface AdminSettings {
  app_name?: string
  public_title?: string
  registration_enabled?: string
  file_size_limit_bytes?: string
  file_size_limit_unlimited?: string
  upload_access_mode?: string
  base_api_url?: string
  turnstile_enabled?: string
  turnstile_site_key?: string
  turnstile_secret_key?: string
}

export interface PublicAdminSettings {
  app_name: string
  public_title: string
  registration_enabled: boolean
  base_api_url?: string
  file_size_limit_bytes: number
  file_size_limit_unlimited: boolean
  upload_access_mode: 'private' | 'public'
  turnstile_site_key?: string
  turnstile_required?: boolean
}

export interface AdminWebhook {
  id: number
  url: string
  events: string[]
  enabled: boolean
  secret_configured: boolean
  secret_preview: string | null
  created_at: number
  updated_at: number
  updated_by: string | null
}

export interface WebhookDelivery {
  id: number
  webhook_id: number | null
  event: string
  status: string
  status_code: number | null
  error: string | null
  created_at: number
  delivered_at: number | null
}

export interface AdminAuditEntry {
  id: number
  created_at: number
  actor: string | null
  action: string
  target: string | null
  status: string
  reason: string | null
}

export interface AdminClaimStatus {
  admin_exists: boolean
  pending_claim: boolean
  claim_available: boolean
}

export interface AdminClaimInitResponse {
  token: string | null
  expires_at: number | null
  detail: string
}

async function adminRequest<T>(path: string, options: RequestInit = {}, fallback = 'Admin request failed'): Promise<T> {
  requireAuthEnabled()
  const headers = new Headers(options.headers)
  if (!headers.has('Content-Type') && options.body) headers.set('Content-Type', 'application/json')
  for (const [key, value] of Object.entries(jwtBearerHeader())) headers.set(key, value)
  const method = (options.method ?? 'GET').toString().toUpperCase()
  const requestPath = method === 'GET'
    ? `${path}${path.includes('?') ? '&' : '?'}cb=${Date.now().toString(36)}`
    : path
  const response = await fetch(`${AUTH_API}/admin${requestPath}`, { cache: 'no-store', ...options, headers })
  if (!response.ok) throw new Error(await responseDetail(response, fallback))
  return readJson<T>(response, fallback)
}

export async function adminPublicSettings(): Promise<PublicAdminSettings> {
  const response = await fetch(`${AUTH_API}/admin/public-settings`, { cache: 'no-store' })
  if (!response.ok) throw new Error(await responseDetail(response, 'Could not load public settings'))
  return readJson<PublicAdminSettings>(response, 'Could not load public settings')
}

export async function adminClaimStatus(): Promise<AdminClaimStatus> {
  requireAuthEnabled()
  const response = await fetch(`${AUTH_API}/admin/claim/status`)
  if (!response.ok) throw new Error(await responseDetail(response, 'Could not load admin claim status'))
  return readJson<AdminClaimStatus>(response, 'Could not load admin claim status')
}

export async function adminClaim(claimToken: string, username: string, password: string, uploadToken = '') {
  requireAuthEnabled()
  const response = await fetch(`${AUTH_API}/admin/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ claim_token: claimToken, username, password, upload_token: uploadToken || undefined }),
  })
  if (!response.ok) throw new Error(await responseDetail(response, 'Admin claim failed'))
  const data = await readJson<AuthSessionResponse>(response, 'Admin claim failed')
  saveAuthSession(data, true)
  return data
}

export function adminDashboard() {
  return adminRequest<AdminDashboard>('/dashboard', {}, 'Could not load admin dashboard')
}

export function adminUsers() {
  return adminRequest<AdminUser[]>('/users', {}, 'Could not load users')
}

export function adminCreateUser(payload: { username: string; password: string; upload_token?: string; is_admin?: boolean }) {
  return adminRequest<{ detail: string; username: string; upload_token: string }>('/users', {
    method: 'POST',
    body: JSON.stringify(payload),
  }, 'Could not create user')
}

export function adminUpdateUser(username: string, payload: { suspended?: boolean; suspension_reason?: string; is_admin?: boolean }) {
  return adminRequest<{ detail: string }>(`/users/${encodeURIComponent(username)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  }, 'Could not update user')
}

export function adminRotateUserToken(username: string, token = '') {
  return adminRequest<{ detail: string; upload_token: string }>(`/users/${encodeURIComponent(username)}/token`, {
    method: 'POST',
    body: JSON.stringify({ token: token || undefined }),
  }, 'Could not rotate user token')
}

export function adminDeleteUser(username: string, confirmation: string) {
  return adminRequest<{ detail: string }>(`/users/${encodeURIComponent(username)}`, {
    method: 'DELETE',
    body: JSON.stringify({ confirmation }),
  }, 'Could not delete user')
}

export function adminPurgeUserUploads(username: string, confirmation: string) {
  return adminRequest<{ detail: string; bytes_removed: number }>(`/users/${encodeURIComponent(username)}/purge`, {
    method: 'POST',
    body: JSON.stringify({ confirmation }),
  }, 'Could not purge user uploads')
}

export function adminUserUploads(username: string) {
  return adminRequest<AdminUpload[]>(`/users/${encodeURIComponent(username)}/uploads`, {}, 'Could not load user uploads')
}

export function adminUploads() {
  return adminRequest<AdminUpload[]>('/uploads', {}, 'Could not load uploads')
}

export function adminDeleteUpload(path: string) {
  return adminRequest<{ detail: string; bytes_removed: number }>(`/uploads?path=${encodeURIComponent(path)}`, {
    method: 'DELETE',
  }, 'Could not delete upload')
}

export function adminBulkDeleteUploads(paths: string[], confirmation: string) {
  return adminRequest<{ deleted: number; bytes_removed: number; errors: unknown[] }>('/uploads/bulk-delete', {
    method: 'POST',
    body: JSON.stringify({ paths, confirmation }),
  }, 'Could not bulk delete uploads')
}

export function adminPurgeExpired(confirmation: string) {
  return adminRequest<{ deleted: number; bytes_removed: number }>('/uploads/purge-expired', {
    method: 'POST',
    body: JSON.stringify({ confirmation }),
  }, 'Could not purge expired uploads')
}

export function adminSettings() {
  return adminRequest<AdminSettings>('/settings', {}, 'Could not load settings')
}

export function adminUpdateSettings(payload: { app_name?: string; public_title?: string; base_api_url?: string; registration_enabled?: boolean; file_size_limit_bytes?: number; file_size_limit_unlimited?: boolean; upload_access_mode?: 'private' | 'public'; turnstile_enabled?: boolean; turnstile_site_key?: string; turnstile_secret_key?: string }) {
  return adminRequest<AdminSettings>('/settings', {
    method: 'PUT',
    body: JSON.stringify(payload),
  }, 'Could not update settings')
}

export function adminTestTurnstile(secretKey: string, token = '') {
  return adminRequest<{ success: boolean; stage: 'secret' | 'challenge' }>('/settings/turnstile/test', { method: 'POST', body: JSON.stringify({ secret_key: secretKey, token }) }, 'Turnstile verification failed')
}

export function adminWebhooks() {
  return adminRequest<AdminWebhook[]>('/webhooks', {}, 'Could not load webhooks')
}

export function adminCreateWebhook(payload: { url: string; events: string[]; secret?: string; enabled?: boolean }) {
  return adminRequest<{ detail: string; id: number }>('/webhooks', {
    method: 'POST',
    body: JSON.stringify(payload),
  }, 'Could not create webhook')
}

export function adminUpdateWebhook(id: number, payload: { url?: string; events?: string[]; secret?: string; enabled?: boolean }) {
  return adminRequest<{ detail: string }>(`/webhooks/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  }, 'Could not update webhook')
}

export function adminDeleteWebhook(id: number) {
  return adminRequest<{ detail: string }>(`/webhooks/${id}`, {
    method: 'DELETE',
  }, 'Could not delete webhook')
}

export function adminTestWebhook(id: number) {
  return adminRequest<{ detail: string }>(`/webhooks/${id}/test`, {
    method: 'POST',
  }, 'Could not test webhook')
}

export function adminWebhookDeliveries() {
  return adminRequest<WebhookDelivery[]>('/webhooks/deliveries', {}, 'Could not load webhook deliveries')
}

export function adminAuditLog() {
  return adminRequest<AdminAuditEntry[]>('/audit', {}, 'Could not load audit log')
}
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

export function formatGigabytes(bytes: number): string {
  const gigabytes = bytes / (1024 ** 3)
  return `${Number.isInteger(gigabytes) ? gigabytes : gigabytes.toFixed(1)} GB`
}

export function formatTimestamp(value: number | null | undefined): string {
  if (!value) return 'N/A'
  return new Date(value * 1000).toLocaleString()
}

export function isLoggedIn(): boolean {
  if (!isAuthEnabled()) return true
  return !!getToken()
}
