const MAGIC = 'RPENC1\n'
const MAGIC_BYTES = new TextEncoder().encode(MAGIC)
const KEY_STORAGE = 'rp_e2ee_keys'
const PUBLIC_BASE = 'https://example.invalid'

export interface EncryptedMetadata {
  name: string
  type: string
  size: number
  createdAt: string
}

interface EncryptedHeader extends EncryptedMetadata {
  v: 1
  alg: 'AES-GCM'
  iv: string
}

interface StoredKey extends EncryptedMetadata {
  key: string
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
  return crypto.subtle.importKey('raw', bytesToArrayBuffer(base64UrlToBytes(rawKey)), 'AES-GCM', false, ['decrypt'])
}

function readStoredKeys(): Record<string, StoredKey> {
  try {
    return JSON.parse(localStorage.getItem(KEY_STORAGE) ?? '{}')
  } catch {
    return {}
  }
}

function writeStoredKeys(keys: Record<string, StoredKey>) {
  localStorage.setItem(KEY_STORAGE, JSON.stringify(keys))
}

export async function encryptFile(file: File): Promise<EncryptionResult> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
  const rawKey = bytesToBase64Url(new Uint8Array(await crypto.subtle.exportKey('raw', key)))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const metadata: EncryptedMetadata = {
    name: file.name,
    type: file.type || 'application/octet-stream',
    size: file.size,
    createdAt: new Date().toISOString(),
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

export async function decryptEncryptedBlob(blob: Blob, rawKey: string): Promise<DecryptionResult> {
  const payload = new Uint8Array(await blob.arrayBuffer())
  const magic = new TextDecoder().decode(payload.subarray(0, MAGIC_BYTES.byteLength))
  if (magic !== MAGIC) throw new Error('This file is not a rustypaste encrypted file')

  const headerOffset = MAGIC_BYTES.byteLength + 4
  const headerLength = new DataView(payload.buffer, MAGIC_BYTES.byteLength, 4).getUint32(0)
  const headerBytes = payload.subarray(headerOffset, headerOffset + headerLength)
  const header = JSON.parse(new TextDecoder().decode(headerBytes)) as EncryptedHeader
  if (header.v !== 1 || header.alg !== 'AES-GCM') throw new Error('Unsupported encrypted file format')

  const ciphertext = payload.subarray(headerOffset + headerLength)
  const key = await importAesKey(rawKey)
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytesToArrayBuffer(base64UrlToBytes(header.iv)) },
    key,
    bytesToArrayBuffer(ciphertext),
  )
  const metadata = {
    name: header.name,
    type: header.type,
    size: header.size,
    createdAt: header.createdAt,
  }

  return {
    blob: new Blob([plaintext], { type: metadata.type }),
    metadata,
  }
}

export function rememberEncryptedFile(fileName: string, key: string, metadata: EncryptedMetadata) {
  const keys = readStoredKeys()
  keys[fileName] = { key, ...metadata }
  writeStoredKeys(keys)
}

export function forgetEncryptedFile(fileName: string) {
  const keys = readStoredKeys()
  delete keys[fileName]
  writeStoredKeys(keys)
}

export function getStoredEncryptedFile(fileName: string): StoredKey | null {
  return readStoredKeys()[fileName] ?? null
}

export function encryptedShareUrl(fileName: string, key: string): string {
  const params = new URLSearchParams({ f: fileName, k: key })
  return `${PUBLIC_BASE}/#/file?${params.toString()}`
}

export function encryptedDownloadUrl(fileName: string): string {
  return `${PUBLIC_BASE}/${fileName}`
}
