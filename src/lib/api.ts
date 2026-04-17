import {
  encryptedShareUrl,
  encryptFile,
  forgetEncryptedFile,
  getStoredEncryptedFile,
  originFromUrl,
  publicPathFromFileName,
  rawFileNameFromPublicPath,
  rememberEncryptedFile,
} from './e2ee'

const PASTE_API = (import.meta.env.VITE_PASTE_API ?? '/api').replace(/\/$/, '')
const AUTH_API = (import.meta.env.VITE_AUTH_API ?? '/auth').replace(/\/$/, '')
const REMEMBER_ME_KEY = 'rp_remember_me'
const AUTH_KEYS = ['rp_jwt', 'rp_token', 'rp_username'] as const

export interface UploadProgress {
  phase: 'encrypting' | 'uploading' | 'complete'
  percent: number
}

function getToken(): string {
  return readAuthValue('rp_token')
}

function getJwt(): string {
  return readAuthValue('rp_jwt')
}

interface AuthSessionResponse {
  access_token: string
  paste_token: string
  username: string
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
  return !!readAuthValue('rp_jwt')
}

// ── Auth service ────────────────────────────────────────────────────────────

export async function authRegister(username: string, password: string, token: string) {
  const r = await fetch(`${AUTH_API}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, token }),
  })
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Registration failed')
  return r.json()
}

export async function authLogin(
  username: string,
  password: string,
  options: { rememberMe?: boolean; turnstileToken?: string } = {},
) {
  const r = await fetch(`${AUTH_API}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username,
      password,
      turnstile_token: options.turnstileToken ?? '',
    }),
  })
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Login failed')
  const data: AuthSessionResponse = await r.json()
  saveAuthSession(data, options.rememberMe ?? getRememberPreference())
  return data
}

export async function authMe() {
  const r = await fetch(`${AUTH_API}/me`, {
    headers: { Authorization: `Bearer ${getJwt()}` },
  })
  if (!r.ok) throw new Error('Unauthorized')
  return r.json()
}

export function authLogout() {
  clearAuthTokens()
}

export interface PasskeySummary {
  id: number
  credential_id: string
  created_at: number
  last_used_at: number | null
  transports: string[]
}

export async function authPasskeysList(): Promise<PasskeySummary[]> {
  const r = await fetch(`${AUTH_API}/passkeys`, {
    headers: { Authorization: `Bearer ${getJwt()}` },
  })
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Could not load passkeys')
  return r.json()
}

export async function authPasskeyRegisterBegin() {
  const r = await fetch(`${AUTH_API}/passkeys/register/begin`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getJwt()}` },
  })
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Could not start passkey registration')
  return r.json()
}

export async function authPasskeyRegisterFinish(credential: unknown) {
  const r = await fetch(`${AUTH_API}/passkeys/register/finish`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getJwt()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ credential }),
  })
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Could not register passkey')
  return r.json()
}

export async function authPasskeyDelete(id: number) {
  const r = await fetch(`${AUTH_API}/passkeys/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${getJwt()}` },
  })
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Could not delete passkey')
}

export async function authPasskeyLoginBegin(username: string) {
  const r = await fetch(`${AUTH_API}/passkeys/auth/begin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username }),
  })
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Could not start passkey login')
  return r.json()
}

export async function authPasskeyLoginFinish(username: string, credential: unknown, rememberMe = getRememberPreference()) {
  const r = await fetch(`${AUTH_API}/passkeys/auth/finish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, credential }),
  })
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Passkey login failed')
  const data: AuthSessionResponse = await r.json()
  saveAuthSession(data, rememberMe)
  return data
}

function uploaderIdentity(): string {
  const username = getAuthUsername()
  if (hasAccountAuth() && username) return username
  return 'Unknown (token user)'
}

export function loginWithToken(token: string, rememberMe = true) {
  saveTokenSession(token, rememberMe)
}

export async function authTokenStatus(token: string): Promise<'available' | 'used' | 'invalid'> {
  const r = await fetch(`${AUTH_API}/token/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Could not verify token')
  const data = await r.json() as { status?: 'available' | 'used' | 'invalid' }
  if (!data.status) throw new Error('Could not verify token')
  return data.status
}

export async function getShareXConfig(): Promise<Blob> {
  const r = await fetch(`${AUTH_API}/sharex`, {
    headers: { Authorization: `Bearer ${getJwt()}` },
  })
  if (!r.ok) throw new Error('Failed to get ShareX config')
  return r.blob()
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
  const r = await fetch(`${PASTE_API}/list`, {
    headers: { Authorization: getToken() },
  })
  if (!r.ok) throw new Error('Failed to list files')
  const data: RawPasteFile[] = await r.json()
  return data.map((f) => ({
    file_name: f.file_name,
    file_size: f.file_size,
    expires_at: f.expires_at_utc ?? null,
    created_at: f.creation_date_utc ?? null,
  }))
}

function pasteUploadUrl(): string {
  return `${PASTE_API}/`
}

export interface UploadOptions {
  expiry?: string
  encrypt?: boolean
  keepFileName?: boolean
  onProgress?: (progress: UploadProgress) => void
}

interface UploadMeta {
  keepFileName: boolean
  originalName: string
  uploader: string
}

export async function uploadFile(file: File, options: UploadOptions = {}): Promise<string> {
  const shouldEncrypt = options.encrypt ?? false
  const shouldKeepFileName = options.keepFileName ?? true
  const expiry = options.expiry
  const onProgress = options.onProgress
  let uploadFileValue = file
  let encryptedKey: string | null = null
  let encryptedMetadata: Awaited<ReturnType<typeof encryptFile>>['metadata'] | null = null
  onProgress?.({ phase: shouldEncrypt ? 'encrypting' : 'uploading', percent: shouldEncrypt ? 0 : 1 })
  if (shouldEncrypt) {
    const encrypted = await encryptFile(file, uploaderIdentity())
    uploadFileValue = new File([encrypted.blob], `${file.name}.rpenc`, { type: 'application/octet-stream' })
    encryptedKey = encrypted.key
    encryptedMetadata = encrypted.metadata
  }
  const form = new FormData()
  const uploadMeta: UploadMeta = {
    keepFileName: shouldKeepFileName,
    originalName: file.name,
    uploader: uploaderIdentity(),
  }
  form.append('meta', JSON.stringify(uploadMeta))
  form.append('file', uploadFileValue)
  const headers: Record<string, string> = { Authorization: getToken() }
  if (expiry) headers.expire = expiry
  const rawUrl = (await uploadForm(form, headers, onProgress)).trim()
  const fileName = fileNameFromUrl(rawUrl)
  const origin = originFromUrl(rawUrl)
  if (shouldEncrypt && encryptedKey && encryptedMetadata) {
    rememberEncryptedFile(fileName, encryptedKey, encryptedMetadata, origin)
  } else {
    forgetEncryptedFile(fileName)
  }
  onProgress?.({ phase: 'complete', percent: 100 })
  if (shouldEncrypt && encryptedKey) return encryptedShareUrl(fileName, encryptedKey, origin)
  return `${origin}/${publicPathFromFileName(fileName)}`
}

export async function uploadText(text: string, options: UploadOptions = {}): Promise<string> {
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
  const r = await fetch(`${PASTE_API}/${filename}`, {
    method: 'DELETE',
    headers: { Authorization: getToken() },
  })
  if (!r.ok) throw new Error('Delete failed')
  forgetEncryptedFile(filename)
}

export interface PublicFileMeta {
  file_name: string
  display_name: string
  uploader: string
  upload_date_utc: string | null
  download_name: string
  file_size: number
  mime_type: string
}

export async function getPublicFileMeta(fileName: string): Promise<PublicFileMeta> {
  const r = await fetch(`${PASTE_API}/meta/${encodeURIComponent(fileName)}`)
  if (!r.ok) throw new Error(r.status === 404 ? 'File not found or expired' : 'Could not load file metadata')
  return r.json()
}

export function publicApiFileUrl(fileName: string): string {
  return `${PASTE_API}/${encodeURIComponent(fileName)}`
}

export function fileUrl(filename: string): string {
  const encrypted = getStoredEncryptedFile(filename)
  if (encrypted) return encryptedShareUrl(filename, encrypted.key, encrypted.origin)
  return `${window.location.origin}/${publicPathFromFileName(filename)}`
}

function fileNameFromUrl(value: string): string {
  try {
    const path = decodeURIComponent(new URL(value).pathname.replace(/^\/+/, ''))
    return path.includes('/') ? rawFileNameFromPublicPath(path) : path
  } catch {
    const path = value.replace(/^https?:\/\/[^/]+\//, '').replace(/^\/+/, '')
    return path.includes('/') ? rawFileNameFromPublicPath(path) : path
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

export function isLoggedIn(): boolean {
  return !!getToken()
}
