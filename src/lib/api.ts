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
const SHAREX_ENABLED = (import.meta.env.VITE_ENABLE_SHAREX ?? '0').trim() === '1'
const PUBLIC_SITE_ORIGIN = (import.meta.env.VITE_PUBLIC_SITE_ORIGIN ?? '').trim().replace(/\/$/, '')
const TOKEN_OWNER_PATH = (import.meta.env.VITE_TOKEN_OWNER_PATH ?? '/token-owner').trim()
const FILE_RESOLVE_BASE = (() => {
  const configured = import.meta.env.VITE_FILE_RESOLVE_BASE
  if (typeof configured !== 'string') return '/resolve'
  return configured.trim().replace(/\/$/, '')
})()
const API_BASE_KEY = 'rp_api_base'
const REMEMBER_ME_KEY = 'rp_remember_me'
const AUTH_KEYS = ['rp_jwt', 'rp_token', 'rp_username'] as const
const FILE_TOKEN_MAP_KEY = 'rp_file_token_map'

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

export function getDefaultPasteApiBase(): string {
  return DEFAULT_PASTE_API
}

export function getPasteApiBase(): string {
  if (typeof localStorage === 'undefined') return DEFAULT_PASTE_API
  const configured = localStorage.getItem(API_BASE_KEY)
  if (!configured) return DEFAULT_PASTE_API
  return isSafeApiBase(configured) ? normalizeApiBase(configured) : DEFAULT_PASTE_API
}

export function setPasteApiBase(value: string) {
  if (typeof localStorage === 'undefined') return
  if (!isSafeApiBase(value)) throw new Error('Invalid API base URL. Use a relative path or http(s) URL.')
  const normalized = normalizeApiBase(value)
  if (!value.trim() || normalized === DEFAULT_PASTE_API) localStorage.removeItem(API_BASE_KEY)
  else localStorage.setItem(API_BASE_KEY, normalized)
}

export function resetPasteApiBase() {
  if (typeof localStorage === 'undefined') return
  localStorage.removeItem(API_BASE_KEY)
}

interface AuthSessionResponse {
  access_token: string
  paste_token: string
  username: string
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
  return 'Unknown (token user)'
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
  // ShareX parser treats the first `|` as the regex capture delimiter, and strips
  // backslashes before passing to .NET — so use NO backslash sequences at all.
  // [.] = literal dot, [A-Za-z0-9]+ = extension chars, [^A-Za-z0-9]*$ = strip trailing junk.
  parsed.URL = `${publicSiteOrigin()}/file/{regex:([A-Za-z0-9_-]+)(?:[.][A-Za-z0-9]+)?[^A-Za-z0-9]*$|1}/preview`

  const uploaderLabel = `${await uploaderIdentity()} (ShareX)`
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

  const args = parsed.Arguments && typeof parsed.Arguments === 'object' && !Array.isArray(parsed.Arguments)
    ? { ...(parsed.Arguments as Record<string, unknown>) }
    : {}
  let metaPayload: Record<string, unknown> = {}
  if (typeof args.meta === 'string') {
    try {
      const decoded = JSON.parse(args.meta) as unknown
      if (decoded && typeof decoded === 'object' && !Array.isArray(decoded)) {
        metaPayload = decoded as Record<string, unknown>
      }
    } catch {}
  }
  metaPayload = sanitizeUploaderSyntax(metaPayload) as Record<string, unknown>
  metaPayload.uploader = uploaderLabel
  metaPayload.source = 'ShareX'
  args.meta = JSON.stringify(metaPayload)
  delete args.uploader
  for (const [key, value] of Object.entries(args)) {
    if (key.toLowerCase() === 'uploader') continue
    args[key] = sanitizeUploaderSyntax(value)
  }
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
  const r = await fetch(`${getPasteApiBase()}/list`, {
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
  const r = await fetch(`${getPasteApiBase()}/meta/${encodeURIComponent(fileName)}`, {
    headers: tokenHeader(),
  })
  if (!r.ok) throw new Error(r.status === 404 ? 'File not found or expired' : await responseDetail(r, 'Could not load file metadata'))
  rememberResolvedFileName(fileName)
  return readJson(r, 'Could not load file metadata')
}

export function publicSiteOrigin(origin = window.location.origin): string {
  if (PUBLIC_SITE_ORIGIN) {
    const configured = sanitizePublicOrigin(PUBLIC_SITE_ORIGIN)
    if (configured) return configured
  }
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

export function fileUrl(filename: string): string {
  return `${publicApiFileUrl(filename)}?raw=1`
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

function fileResolveUrl(token: string, origin = publicSiteOrigin()): string {
  if (!FILE_RESOLVE_BASE) throw new Error('Public file-token resolution is disabled for this deployment')
  const cleanToken = decodeFileToken(token)
  const cacheBuster = `cb=${Date.now().toString(36)}`
  if (/^https?:\/\//i.test(FILE_RESOLVE_BASE)) return `${FILE_RESOLVE_BASE}/${encodeURIComponent(cleanToken)}?${cacheBuster}`
  return `${publicSiteOrigin(origin)}${FILE_RESOLVE_BASE}/${encodeURIComponent(cleanToken)}?${cacheBuster}`
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

  let response: Response
  try {
    response = await fetch(fileResolveUrl(decoded, origin), { cache: 'no-store' })
  } catch {
    throw new Error('Could not resolve the file URL')
  }
  if (!response.ok) {
    throw new Error(response.status === 404 ? 'File not found or expired' : await responseDetail(response, 'Could not resolve the file URL'))
  }
  const payload = await readJson<{ file_name?: string; uploader?: unknown; owner?: unknown }>(response, 'Could not resolve the file URL')
  if (!payload.file_name || typeof payload.file_name !== 'string') throw new Error('Could not resolve the file URL')
  const uploader = normalizeResolvedUploader(payload.uploader) ?? normalizeResolvedUploader(payload.owner)
  return { fileName: payload.file_name, uploader }
}

export async function resolveFileName(tokenOrFileName: string, origin = publicSiteOrigin()): Promise<string> {
  const resolved = await resolveFileLookup(tokenOrFileName, origin)
  return resolved.fileName
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

export function isLoggedIn(): boolean {
  if (!isAuthEnabled()) return true
  return !!getToken()
}
