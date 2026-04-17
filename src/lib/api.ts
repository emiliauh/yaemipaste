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

export async function listFiles(): Promise<PasteFile[]> {
  const r = await fetch(`${PASTE_API}/list`, {
    headers: { Authorization: getToken() },
  })
  if (!r.ok) throw new Error('Failed to list files')
  const text = await r.text()
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(' ')
      return {
        file_name: parts[0] ?? '',
        file_size: parseInt(parts[1] ?? '0', 10),
        expires_at: parts[2] ?? null,
        created_at: parts[3] ?? null,
      }
    })
}

export async function uploadFile(file: File, expiry?: string): Promise<string> {
  const form = new FormData()
  form.append('file', file)
  const headers: Record<string, string> = { Authorization: getToken() }
  if (expiry) headers['x-expire-after'] = expiry
  const r = await fetch(PASTE_API, { method: 'POST', headers, body: form })
  if (!r.ok) throw new Error('Upload failed')
  return r.text()
}

export async function uploadText(text: string, expiry?: string): Promise<string> {
  const form = new FormData()
  form.append('file', new Blob([text], { type: 'text/plain' }), 'paste.txt')
  const headers: Record<string, string> = { Authorization: getToken() }
  if (expiry) headers['x-expire-after'] = expiry
  const r = await fetch(PASTE_API, { method: 'POST', headers, body: form })
  if (!r.ok) throw new Error('Upload failed')
  return r.text()
}

export async function deleteFile(filename: string): Promise<void> {
  const r = await fetch(`${PASTE_API}/${filename}`, {
    method: 'DELETE',
    headers: { Authorization: getToken() },
  })
  if (!r.ok) throw new Error('Delete failed')
}

export function fileUrl(filename: string): string {
  return `https://example.invalid/${filename}`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

export function isLoggedIn(): boolean {
  return !!localStorage.getItem('rp_token')
}
