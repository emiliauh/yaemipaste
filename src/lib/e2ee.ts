const MAGIC = 'RPENC1\n'
import { encodeFileTokenFromName, fileIdFromFileName } from './fileTokens'

const MAGIC_BYTES = new TextEncoder().encode(MAGIC)
const MAX_HEADER_BYTES = 16 * 1024
const KEY_STORAGE = 'rp_e2ee_keys'
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/
const BLOCKED_STORAGE_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
export interface EncryptedMetadata {
  name: string
  type: string
  size: number
  createdAt: string
  uploader: string
}

interface EncryptedHeader extends EncryptedMetadata {
  v: 1
  alg: 'AES-GCM'
  iv: string
}

interface StoredKey extends EncryptedMetadata {
  key: string
  origin: string
}

export interface EncryptionResult {
  blob: Blob
  key: string
  metadata: EncryptedMetadata
}

export interface DecryptionResult {
  blob: Blob
  metadata: EncryptedMetadata
}

export function supportsBrowserEncryption(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext && !!window.crypto?.subtle
}

function requireBrowserEncryption(): void {
  if (supportsBrowserEncryption()) return
  throw new Error('Browser encryption requires HTTPS or localhost.')
}

function hasMagicBytes(payload: Uint8Array): boolean {
  if (payload.byteLength < MAGIC_BYTES.byteLength) return false
  for (let i = 0; i < MAGIC_BYTES.byteLength; i += 1) {
    if (payload[i] !== MAGIC_BYTES[i]) return false
  }
  return true
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
}

async function importAesKey(rawKey: string): Promise<CryptoKey> {
  requireBrowserEncryption()
  const normalized = normalizeToBase64Url(rawKey)
  if (!normalized) throw new Error('Invalid decryption key')
  const keyBytes = base64UrlToBytes(normalized)
  if (keyBytes.byteLength !== 32) throw new Error('Invalid decryption key')
  return crypto.subtle.importKey('raw', bytesToArrayBuffer(keyBytes), 'AES-GCM', false, ['decrypt'])
}

function normalizeToBase64Url(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (BASE64URL_RE.test(trimmed)) return trimmed
  if (!BASE64_RE.test(trimmed)) return null
  return trimmed.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function readStoredKeys(): Record<string, StoredKey> {
  const parsed: unknown = (() => {
    try {
      return JSON.parse(localStorage.getItem(KEY_STORAGE) ?? '{}')
    } catch {
      return {}
    }
  })()

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const safeKeys: Record<string, StoredKey> = Object.create(null)
  for (const [fileName, value] of Object.entries(parsed)) {
    if (!isSafeStorageKey(fileName)) continue
    const normalized = normalizeStoredKey(value, fileName)
    if (normalized) safeKeys[fileName] = normalized
  }

  return safeKeys
}

function writeStoredKeys(keys: Record<string, StoredKey>) {
  const safeKeys: Record<string, StoredKey> = Object.create(null)
  for (const [fileName, value] of Object.entries(keys)) {
    if (!isSafeStorageKey(fileName)) continue
    const normalized = normalizeStoredKey(value, fileName)
    if (normalized) safeKeys[fileName] = normalized
  }
  localStorage.setItem(KEY_STORAGE, JSON.stringify(safeKeys))
}

function isSafeStorageKey(fileName: string): boolean {
  return !!fileName && !BLOCKED_STORAGE_KEYS.has(fileName)
}

function normalizeStoredKey(value: unknown, fallbackName: string): StoredKey | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Partial<StoredKey>
  if (typeof candidate.key !== 'string') return null
  // allow base64url key OR 'pw:{base64url_salt}' for password-encrypted files
  const isPwKey = candidate.key.startsWith('pw:')
  const keyPayload = isPwKey ? candidate.key.slice(3) : candidate.key
  const normalizedPayload = normalizeToBase64Url(keyPayload)
  if (!normalizedPayload) return null
  const normalizedKey = isPwKey ? `pw:${normalizedPayload}` : normalizedPayload
  const origin = typeof candidate.origin === 'string' && candidate.origin.trim()
    ? candidate.origin
    : window.location.origin
  const type = typeof candidate.type === 'string' && candidate.type.trim()
    ? candidate.type
    : 'application/octet-stream'
  const createdAt = typeof candidate.createdAt === 'string' ? candidate.createdAt : ''
  const uploader = typeof candidate.uploader === 'string' && candidate.uploader
    ? candidate.uploader
    : 'Unknown (token user)'
  const size = Number.isFinite(candidate.size) && Number(candidate.size) >= 0 ? Number(candidate.size) : 0
  const name = typeof candidate.name === 'string' && candidate.name ? candidate.name : fallbackName
  return {
    key: normalizedKey,
    origin,
    name,
    type,
    size,
    createdAt,
    uploader,
  }
}

function parseEncryptedHeader(value: unknown): EncryptedHeader {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Encrypted file header is invalid')
  const header = value as Record<string, unknown>
  if (header.v !== 1 || header.alg !== 'AES-GCM') throw new Error('Unsupported encrypted file format')
  if (typeof header.iv !== 'string' || !BASE64URL_RE.test(header.iv)) {
    throw new Error('Encrypted file header is invalid')
  }
  const type = typeof header.type === 'string' && header.type.trim()
    ? header.type
    : 'application/octet-stream'
  const size = Number.isFinite(header.size) && Number(header.size) >= 0 ? Number(header.size) : 0
  return {
    v: 1,
    alg: 'AES-GCM',
    iv: header.iv,
    name: typeof header.name === 'string' && header.name ? header.name : 'decrypted-file',
    type,
    size,
    createdAt: typeof header.createdAt === 'string' ? header.createdAt : '',
    uploader: typeof header.uploader === 'string' && header.uploader ? header.uploader : 'Unknown (token user)',
  }
}

function normalizeFileName(fileName: string): string {
  return fileName.replace(/^\/+/, '').replace(/[\u0000-\u001F\u007F]/g, '').trim()
}

function sanitizePathSegment(segment: string): string {
  return encodeURIComponent(segment.replace(/[\u0000-\u001F\u007F]/g, ''))
}

function encodePath(fileName: string): string {
  return normalizeFileName(fileName).split('/').map(sanitizePathSegment).join('/')
}

export async function encryptFile(file: File, uploader: string): Promise<EncryptionResult> {
  requireBrowserEncryption()
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
  const rawKey = bytesToBase64Url(new Uint8Array(await crypto.subtle.exportKey('raw', key)))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const metadata: EncryptedMetadata = {
    name: file.name,
    type: file.type || 'application/octet-stream',
    size: file.size,
    createdAt: new Date().toISOString(),
    uploader,
  }
  const header: EncryptedHeader = {
    v: 1,
    alg: 'AES-GCM',
    iv: bytesToBase64Url(iv),
    ...metadata,
  }
  const headerBytes = new TextEncoder().encode(JSON.stringify(header))
  const headerLength = new Uint8Array(4)
  new DataView(headerLength.buffer).setUint32(0, headerBytes.byteLength)
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, await file.arrayBuffer())

  return {
    blob: new Blob([MAGIC_BYTES, headerLength, headerBytes, ciphertext], { type: 'application/octet-stream' }),
    key: rawKey,
    metadata,
  }
}

async function decryptBlobWithKey(blob: Blob, key: CryptoKey): Promise<DecryptionResult> {
  requireBrowserEncryption()
  const payload = new Uint8Array(await blob.arrayBuffer())
  if (!hasMagicBytes(payload)) {
    throw new Error('This file is not a rustypaste encrypted file')
  }
  if (payload.byteLength < MAGIC_BYTES.byteLength + 4) {
    throw new Error('Encrypted file header is incomplete')
  }

  const headerOffset = MAGIC_BYTES.byteLength + 4
  const headerLength = new DataView(payload.buffer, MAGIC_BYTES.byteLength, 4).getUint32(0)
  if (!headerLength || headerLength > MAX_HEADER_BYTES || headerOffset + headerLength > payload.byteLength) {
    throw new Error('Encrypted file header is invalid')
  }
  const headerBytes = payload.subarray(headerOffset, headerOffset + headerLength)
  let header: EncryptedHeader
  try {
    header = parseEncryptedHeader(JSON.parse(new TextDecoder().decode(headerBytes)))
  } catch (error) {
    if (error instanceof Error) throw error
    throw new Error('Encrypted file header is invalid')
  }
  const ciphertext = payload.subarray(headerOffset + headerLength)
  if (!ciphertext.byteLength) throw new Error('Encrypted payload is empty')
  let plaintext: ArrayBuffer
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytesToArrayBuffer(base64UrlToBytes(header.iv)) },
      key,
      bytesToArrayBuffer(ciphertext),
    )
  } catch {
    throw new Error('Decryption failed. The key or password is incorrect.')
  }
  const metadata = {
    name: header.name,
    type: header.type,
    size: header.size,
    createdAt: header.createdAt,
    uploader: header.uploader ?? 'Unknown (token user)',
  }

  return {
    blob: new Blob([plaintext], { type: metadata.type }),
    metadata,
  }
}

export async function decryptEncryptedBlob(blob: Blob, rawKey: string): Promise<DecryptionResult> {
  const key = await importAesKey(rawKey)
  return decryptBlobWithKey(blob, key)
}

async function deriveKeyFromPassword(password: string, salt: Uint8Array): Promise<CryptoKey> {
  requireBrowserEncryption()
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: bytesToArrayBuffer(salt), iterations: 200_000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export interface PasswordEncryptionResult {
  blob: Blob
  salt: string
  metadata: EncryptedMetadata
}

export async function encryptFileWithPassword(file: File, password: string, uploader: string): Promise<PasswordEncryptionResult> {
  requireBrowserEncryption()
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const saltStr = bytesToBase64Url(salt)
  const key = await deriveKeyFromPassword(password, salt)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const metadata: EncryptedMetadata = {
    name: file.name,
    type: file.type || 'application/octet-stream',
    size: file.size,
    createdAt: new Date().toISOString(),
    uploader,
  }
  const header: EncryptedHeader = {
    v: 1,
    alg: 'AES-GCM',
    iv: bytesToBase64Url(iv),
    ...metadata,
  }
  const headerBytes = new TextEncoder().encode(JSON.stringify(header))
  const headerLength = new Uint8Array(4)
  new DataView(headerLength.buffer).setUint32(0, headerBytes.byteLength)
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, await file.arrayBuffer())
  return {
    blob: new Blob([MAGIC_BYTES, headerLength, headerBytes, ciphertext], { type: 'application/octet-stream' }),
    salt: saltStr,
    metadata,
  }
}

export async function decryptBlobWithPassword(blob: Blob, password: string, salt: string): Promise<DecryptionResult> {
  requireBrowserEncryption()
  const saltBytes = base64UrlToBytes(salt)
  const key = await deriveKeyFromPassword(password, saltBytes)
  return decryptBlobWithKey(blob, key)
}

export async function isRustypasteEncryptedBlob(blob: Blob): Promise<boolean> {
  const prefix = new Uint8Array(await blob.slice(0, MAGIC_BYTES.byteLength).arrayBuffer())
  return hasMagicBytes(prefix)
}

export function rememberEncryptedFile(fileName: string, key: string, metadata: EncryptedMetadata, origin: string) {
  if (!isSafeStorageKey(fileName)) throw new Error('Invalid encrypted file identifier')
  const keys = readStoredKeys()
  keys[fileName] = { key, origin, ...metadata }
  writeStoredKeys(keys)
}

export function forgetEncryptedFile(fileName: string) {
  if (!isSafeStorageKey(fileName)) return
  const keys = readStoredKeys()
  delete keys[fileName]
  writeStoredKeys(keys)
}

function keyLookupCandidates(fileName: string): string[] {
  const cleaned = fileName.replace(/^\/+/, '')
  const candidates = new Set<string>([cleaned])
  if (cleaned.toLowerCase().endsWith('.rpenc')) candidates.add(cleaned.slice(0, -6))
  else candidates.add(`${cleaned}.rpenc`)
  const fileId = fileIdFromFileName(cleaned)
  if (fileId) {
    candidates.add(fileId)
    candidates.add(`${fileId}.rpenc`)
  }
  return [...candidates].filter(isSafeStorageKey)
}

export function getStoredEncryptedFile(fileName: string): StoredKey | null {
  if (!isSafeStorageKey(fileName)) return null
  const keys = readStoredKeys()
  for (const candidate of keyLookupCandidates(fileName)) {
    const stored = keys[candidate]
    if (!stored) continue
    if (candidate !== fileName) {
      keys[fileName] = stored
      writeStoredKeys(keys)
    }
    return stored
  }
  return null
}

export function encryptedShareUrl(fileName: string, key: string, origin = window.location.origin): string {
  return `${origin}/file/${encodeFileTokenFromName(fileName)}+${key}/preview`
}

export function passwordEncryptedShareUrl(fileName: string, salt: string, origin = window.location.origin): string {
  return `${origin}/file/${encodeFileTokenFromName(fileName)}+pw:${salt}/preview`
}

export function encryptedDownloadUrl(fileName: string, origin = window.location.origin): string {
  return `${origin}/${publicPathFromFileName(fileName)}?raw=1`
}

export function originFromUrl(value: string): string {
  try {
    return new URL(value).origin
  } catch {
    return window.location.origin
  }
}

export function publicPathFromFileName(fileName: string): string {
  const normalized = normalizeFileName(fileName)
  const [id, ...rest] = normalized.split('.')
  if (!id) return encodePath(normalized)
  const suffix = rest.join('.')
  const tail = suffix ? `file.${suffix}` : 'file'
  return `${sanitizePathSegment(id)}/${sanitizePathSegment(tail)}`
}

export function rawFileNameFromPublicPath(pathname: string): string {
  const cleaned = normalizeFileName(pathname)
  const [idSegment = '', tailSegment = ''] = cleaned.split('/', 2)
  const id = decodeURIComponent(idSegment)
  const tail = decodeURIComponent(tailSegment)
  if (!id) return ''
  if (!tail) return id
  if (tail === 'file') return id
  if (tail.startsWith('file.')) return `${id}.${tail.slice(5)}`
  return `${id}.${tail}`
}
