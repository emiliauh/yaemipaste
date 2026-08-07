import { Injectable, Logger } from '@nestjs/common'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseToml } from 'smol-toml'

export type RandomUrlConfig = {
  enabled?: boolean
  type?: 'petname' | 'alphanumeric'
  length?: number
  words?: number
  separator?: string
  suffix_mode?: boolean
  no_extension?: boolean
}

export type AppConfig = {
  address: string
  host: string
  port: number
  publicUrl: string
  uploadPath: string
  maxContentLength: number
  maxUploadDirSize?: number
  timeoutMs: number
  exposeVersion: boolean
  exposeList: boolean
  handleSpaces?: 'encode' | 'replace'
  landingPage?: { text?: string; file?: string; contentType?: string }
  defaultExtension: string
  mimeOverride: Array<{ mime: string; regex?: RegExp }>
  mimeBlacklist: string[]
  duplicateFiles: boolean
  defaultExpiryMs?: number
  randomUrl?: RandomUrlConfig
  remoteUploadsEnabled: boolean
  allowAnonymousUploads: boolean
  passkeysEnabled: boolean
  passkeyRpName: string
  passkeyRpId?: string
  passkeyOrigins: string[]
  passkeyAllowAnyPort: boolean
  passkeyAllowSubdomains: boolean
  sharexEnabled: boolean
  authTokens: string[]
  deleteTokens: string[]
  corsOrigins: string[]
  corsMethods: string[]
  corsHeaders: string[]
  cleanupEnabled: boolean
  cleanupIntervalMs: number
}

const truthy = (value: unknown, fallback = false) => {
  if (value == null) return fallback
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase())
}

function numberValue(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function durationMs(value: unknown): number | undefined {
  if (value == null || value === '') return undefined
  if (typeof value === 'number') return value
  const text = String(value).trim()
  if (/^\d+$/.test(text)) return Number(text)
  const match = text.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/i)
  if (!match) return undefined
  const multiplier = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2].toLowerCase() as 'ms' | 's' | 'm' | 'h' | 'd']
  return Number(match[1]) * multiplier
}

function byteValue(value: unknown, fallback: number): number {
  if (value == null || value === '') return fallback
  if (typeof value === 'number') return value
  const match = String(value).trim().match(/^(\d+(?:\.\d+)?)\s*(B|KB|KiB|MB|MiB|GB|GiB|TB|TiB)?$/i)
  if (!match) return fallback
  const unit = (match[2] ?? 'B').toLowerCase()
  const multiplier = unit === 'kb' ? 1000 : unit === 'kib' ? 1024 : unit === 'mb' ? 1_000_000 : unit === 'mib' ? 1_048_576 : unit === 'gb' ? 1_000_000_000 : unit === 'gib' ? 1_073_741_824 : unit === 'tb' ? 1_000_000_000_000 : unit === 'tib' ? 1_099_511_627_776 : 1
  return Math.round(Number(match[1]) * multiplier)
}

function envOr(value: unknown, key: string, fallback = ''): string {
  const envValue = process.env[key]
  return (envValue ?? value ?? fallback).toString()
}

@Injectable()
export class ConfigService {
  private readonly logger = new Logger(ConfigService.name)
  readonly value: AppConfig

  constructor() {
    const configuredPath = process.env.CONFIG
    const defaultPath = resolve(process.cwd(), 'config.toml')
    const repositoryConfig = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docker/yaemipaste/config.toml')
    const path = configuredPath || (existsSync(defaultPath) ? defaultPath : repositoryConfig)
    let raw: any = {}
    if (existsSync(path)) {
      try {
        raw = parseToml(readFileSync(path, 'utf8'))
      } catch (error) {
        this.logger.warn(`Could not parse ${path}: ${String(error)}`)
      }
    }
    const server = raw.server ?? {}
    const paste = raw.paste ?? {}
    const cors = server.cors ?? {}
    const address = envOr(server.address, 'SERVER__ADDRESS', '0.0.0.0:8000')
    const addressParts = address.lastIndexOf(':')
    const host = addressParts > 0 ? address.slice(0, addressParts) : '0.0.0.0'
    const port = numberValue(process.env.PORT ?? (addressParts > 0 ? address.slice(addressParts + 1) : 8000), 8000)
    const matcherValues = Array.isArray(paste.mime_override) ? paste.mime_override : []
    const randomUrl = paste.random_url
      ? {
          ...paste.random_url,
          type: String(paste.random_url.type ?? 'petname').toLowerCase() as RandomUrlConfig['type'],
          enabled: paste.random_url.enabled == null ? true : truthy(paste.random_url.enabled),
        }
      : undefined
    const cleanup = paste.delete_expired_files ?? {}
    const configuredOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean)
    this.value = {
      address,
      host,
      port,
      publicUrl: envOr(server.url, 'PASTE_URL', 'http://localhost:8080').replace(/\/$/, ''),
      uploadPath: envOr(server.upload_path, 'SERVER__UPLOAD_PATH', '/var/lib/yaemipaste/upload'),
      maxContentLength: byteValue(server.max_content_length, 256 * 1024 * 1024),
      maxUploadDirSize: byteValue(process.env.MAX_UPLOAD_DIR_SIZE ?? server.max_upload_dir_size, 10 * 1024 * 1024 * 1024),
      timeoutMs: durationMs(server.timeout) ?? 30_000,
      exposeVersion: truthy(server.expose_version, false),
      exposeList: truthy(server.expose_list, false),
      handleSpaces: envOr(server.handle_spaces, 'SERVER__HANDLE_SPACES', '').toLowerCase() as AppConfig['handleSpaces'],
      landingPage: raw.landing_page ? { text: raw.landing_page.text, file: raw.landing_page.file, contentType: raw.landing_page.content_type } : undefined,
      defaultExtension: String(paste.default_extension ?? 'txt'),
      mimeOverride: matcherValues.flatMap((item: any) => {
        try { return [{ mime: String(item.mime), regex: item.regex ? new RegExp(String(item.regex)) : undefined }] } catch { return [] }
      }),
      mimeBlacklist: Array.isArray(paste.mime_blacklist) ? paste.mime_blacklist.map(String) : [],
      duplicateFiles: paste.duplicate_files == null ? true : truthy(paste.duplicate_files),
      defaultExpiryMs: durationMs(paste.default_expiry),
      randomUrl,
      remoteUploadsEnabled: truthy(process.env.REMOTE_UPLOADS_ENABLED, false),
      allowAnonymousUploads: truthy(process.env.ALLOW_ANONYMOUS_UPLOADS, false),
      passkeysEnabled: truthy(process.env.PASSKEYS_ENABLED, false),
      passkeyRpName: process.env.PASSKEY_RP_NAME || 'yaemipaste',
      passkeyRpId: process.env.PASSKEY_RP_ID || undefined,
      passkeyOrigins: (process.env.PASSKEY_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean),
      passkeyAllowAnyPort: truthy(process.env.PASSKEY_ALLOW_ANY_PORT, false),
      passkeyAllowSubdomains: truthy(process.env.PASSKEY_ALLOW_SUBDOMAINS, false),
      sharexEnabled: truthy(process.env.SHAREX_ENABLED ?? process.env.VITE_ENABLE_SHAREX, true),
      authTokens: Array.isArray(server.tokens) ? server.tokens.map(String) : [],
      deleteTokens: [...(Array.isArray(server.tokens) ? server.tokens.map(String) : []), ...(Array.isArray(server.delete_tokens) ? server.delete_tokens.map(String) : [])],
      corsOrigins: configuredOrigins.length ? configuredOrigins : (Array.isArray(cors.allowed_origins) ? cors.allowed_origins.map(String) : []),
      corsMethods: Array.isArray(cors.allowed_methods) ? cors.allowed_methods.map(String) : ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      corsHeaders: Array.isArray(cors.allowed_headers) ? cors.allowed_headers.map(String) : ['Authorization', 'Content-Type', 'Expire', 'Cache-Control'],
      cleanupEnabled: truthy(cleanup.enabled, false),
      cleanupIntervalMs: Math.max(1_000, durationMs(cleanup.interval) ?? 3_600_000),
    }
    if (this.value.maxUploadDirSize === 0) this.value.maxUploadDirSize = undefined
  }
}
