import {
  encryptedShareUrl,
  encryptedDownloadUrl,
  encryptFile,
  forgetEncryptedFile,
  getStoredEncryptedFile,
  originFromUrl,
  rememberEncryptedFile,
} from './e2ee'

const PASTE_API = import.meta.env.VITE_PASTE_API ?? 'https://api.example.invalid'
const AUTH_API = import.meta.env.VITE_AUTH_API ?? 'https://example.invalid/auth'

function getToken(): string {
  return localStorage.getItem('rp_token') ?? ''
}

function getJwt(): string {
  return localStorage.getItem('rp_jwt') ?? ''
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

export async function authLogin(username: string, password: string) {
  const r = await fetch(`${AUTH_API}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Login failed')
  const data = await r.json()
  localStorage.setItem('rp_jwt', data.access_token)
  localStorage.setItem('rp_token', data.paste_token)
  localStorage.setItem('rp_username', data.username)
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
  localStorage.removeItem('rp_jwt')
  localStorage.removeItem('rp_token')
  localStorage.removeItem('rp_username')
}

function uploaderIdentity(): string {
  const username = localStorage.getItem('rp_username')
  if (localStorage.getItem('rp_jwt') && username) return username
  return 'Unknown (token user)'
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

export async function uploadFile(file: File, expiry?: string): Promise<string> {
  const encrypted = await encryptFile(file, uploaderIdentity())
  const encryptedFile = new File([encrypted.blob], `${file.name}.rpenc`, { type: 'application/octet-stream' })
  const form = new FormData()
  form.append('file', encryptedFile)
  const headers: Record<string, string> = { Authorization: getToken() }
  if (expiry) headers.expire = expiry
  const r = await fetch(PASTE_API, { method: 'POST', headers, body: form })
  if (!r.ok) throw new Error('Upload failed')
  const rawUrl = (await r.text()).trim()
  const fileName = fileNameFromUrl(rawUrl)
  const origin = originFromUrl(rawUrl)
  rememberEncryptedFile(fileName, encrypted.key, encrypted.metadata, origin)
  return encryptedShareUrl(fileName, encrypted.key, origin)
}

export async function uploadText(text: string, expiry?: string): Promise<string> {
  return uploadFile(new File([text], 'paste.txt', { type: 'text/plain' }), expiry)
}

export async function deleteFile(filename: string): Promise<void> {
  const r = await fetch(`${PASTE_API}/${filename}`, {
    method: 'DELETE',
    headers: { Authorization: getToken() },
  })
  if (!r.ok) throw new Error('Delete failed')
  forgetEncryptedFile(filename)
}

export function fileUrl(filename: string): string {
  const encrypted = getStoredEncryptedFile(filename)
  if (encrypted) return encryptedShareUrl(filename, encrypted.key, encrypted.origin)
  return encryptedDownloadUrl(filename)
}

function fileNameFromUrl(value: string): string {
  try {
    return decodeURIComponent(new URL(value).pathname.replace(/^\/+/, ''))
  } catch {
    return value.replace(/^https?:\/\/[^/]+\//, '').replace(/^\/+/, '')
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

export function isLoggedIn(): boolean {
  return !!localStorage.getItem('rp_token')
}
