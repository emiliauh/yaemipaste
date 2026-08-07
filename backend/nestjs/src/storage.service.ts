import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, extname, join, normalize, relative, resolve } from 'node:path'
import { ConfigService, type RandomUrlConfig } from './config.service.js'
import { apiError } from './errors.js'
import { AuthService } from './auth.service.js'

export type UploadMetadata = { keep_file_name: boolean; original_name: string; uploader: string; source: string; password_salt?: string }
export type LocatedFile = { path: string; root: string; name: string; kind: 'file' | 'url' | 'oneshot' | 'oneshot_url' }

const hiddenDirs = new Set(['.rpmeta', 'url', 'oneshot', 'oneshot_url'])

function parseDuration(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/i)
  if (!match) return undefined
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2].toLowerCase() as 'ms' | 's' | 'm' | 'h' | 'd']
  return Number(match[1]) * unit
}

function expiryFromName(name: string): number | undefined {
  const value = name.slice(name.lastIndexOf('.') + 1)
  return /^\d{10,}$/.test(value) ? Number(value) : undefined
}

function utcSeconds(value: number): string { return new Date(Math.floor(value / 1000) * 1000).toISOString() }

function stripExpiry(name: string): string {
  const expiry = expiryFromName(name)
  return expiry ? name.slice(0, name.lastIndexOf('.')) : name
}

function randomName(config: RandomUrlConfig): string {
  if (config.type === 'alphanumeric') {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    const bytes = randomBytes(config.length ?? 8)
    return Array.from(bytes, byte => alphabet[byte % alphabet.length]).join('')
  }
  const words = ['amber', 'cedar', 'cobalt', 'crimson', 'maple', 'meadow', 'north', 'orbit', 'river', 'silver', 'violet', 'winter']
  return Array.from({ length: config.words ?? 2 }, () => words[Math.floor(Math.random() * words.length)]).join(config.separator ?? '-')
}

function safeChild(root: string, name: string): string {
  const clean = basename(name)
  if (!clean || clean === '.' || clean === '..' || clean !== name || name.includes('\0') || name.includes('\\')) throw apiError(400, 'invalid filename')
  const resolvedRoot = resolve(root)
  const candidate = resolve(resolvedRoot, clean)
  if (relative(resolvedRoot, candidate).startsWith('..')) throw apiError(400, 'invalid filename')
  return candidate
}

function mimeFromName(name: string): string {
  const ext = extname(name).toLowerCase()
  const values: Record<string, string> = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska', '.ogv': 'video/ogg',
    '.pdf': 'application/pdf', '.json': 'application/json', '.html': 'text/html', '.htm': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.txt': 'text/plain', '.md': 'text/plain', '.log': 'text/plain', '.csv': 'text/csv', '.xml': 'text/xml',
  }
  return values[ext] ?? 'application/octet-stream'
}

@Injectable()
export class StorageService implements OnModuleInit, OnModuleDestroy {
  private readonly root: string
  private cleanupTimer?: ReturnType<typeof setInterval>

  constructor(private readonly config: ConfigService, private readonly auth: AuthService) {
    this.root = resolve(config.value.uploadPath)
    mkdirSync(this.root, { recursive: true })
    for (const directory of ['', 'url', 'oneshot', 'oneshot_url']) mkdirSync(join(this.root, directory), { recursive: true })
  }

  get uploadRoot() { return this.root }

  onModuleInit() {
    if (this.config.value.cleanupEnabled) {
      this.cleanupExpired()
      this.cleanupTimer = setInterval(() => this.cleanupExpired(), this.config.value.cleanupIntervalMs)
      this.cleanupTimer.unref?.()
    }
  }

  onModuleDestroy() { if (this.cleanupTimer) clearInterval(this.cleanupTimer) }

  resolveAdminPath(value: string): string {
    const clean = value.replaceAll('\\', '/')
    const candidate = resolve(this.root, clean)
    if (relative(this.root, candidate).startsWith('..')) throw apiError(400, 'invalid upload path')
    if (existsSync(candidate)) {
      const target = realpathSync(candidate)
      if (relative(realpathSync(this.root), target).startsWith('..')) throw apiError(400, 'invalid upload path')
    }
    return candidate
  }

  rootForToken(token?: string): string {
    const root = token ? join(this.root, this.auth.tokenDirectory(token)) : this.root
    mkdirSync(root, { recursive: true })
    for (const directory of ['', 'url', 'oneshot', 'oneshot_url']) mkdirSync(join(root, directory), { recursive: true })
    return root
  }

  parseExpiry(value: string | undefined): number | undefined {
    const custom = parseDuration(value)
    const duration = custom ?? this.config.value.defaultExpiryMs
    return duration && duration > 0 ? Date.now() + duration : undefined
  }

  private applyNameRules(original: string, content: Buffer): string {
    let name = basename(original || 'file')
    if (name === '-') name = 'stdin'
    if (name === '.' || !name) name = 'file'
    if (this.config.value.handleSpaces === 'replace') name = name.replaceAll(' ', '_')
    if (this.config.value.handleSpaces === 'encode') name = name.replaceAll(' ', '%20')
    const detectedExtension = extname(name).slice(1) || this.config.value.mimeOverride.find(item => item.regex?.test(name))?.mime.split('/')[1] || this.config.value.defaultExtension
    let stem = name.slice(0, name.length - extname(name).length) || 'file'
    let extension = detectedExtension
    const random = this.config.value.randomUrl
    if (random && random.enabled !== false) {
      const value = randomName(random ?? {})
      if (random?.suffix_mode) extension = `${value}.${extension}`
      else stem = value
    }
    if (random?.no_extension) extension = ''
    const candidate = extension ? `${stem}.${extension}` : stem
    void content
    return candidate
  }

  private metadataPath(root: string, fileName: string) { return join(root, '.rpmeta', `${fileName.replaceAll('/', '_')}.json`) }

  writeMetadata(root: string, storedName: string, metadata: UploadMetadata) {
    if (!metadata.keep_file_name && !metadata.uploader.trim() && !metadata.source.trim() && !metadata.password_salt?.trim()) return
    mkdirSync(join(root, '.rpmeta'), { recursive: true })
    const body = {
      display_name: metadata.keep_file_name && metadata.original_name.trim() ? metadata.original_name.trim() : undefined,
      uploader: metadata.uploader.trim() || undefined,
      source: metadata.source.trim() || undefined,
      password_salt: metadata.password_salt && /^[A-Za-z0-9_-]{22}$/.test(metadata.password_salt) ? metadata.password_salt : undefined,
    }
    writeFileSync(this.metadataPath(root, storedName), JSON.stringify(body))
  }

  readMetadata(root: string, name: string): any | undefined {
    const parse = (value: string) => {
      const metadata = JSON.parse(value)
      if (metadata && metadata.password_salt == null && typeof metadata.passwordSalt === 'string') {
        metadata.password_salt = metadata.passwordSalt
      }
      return metadata
    }
    const candidates = [name, stripExpiry(name)]
    for (const candidate of candidates) {
      try { return parse(readFileSync(this.metadataPath(root, candidate), 'utf8')) } catch { /* try the next compatible sidecar name */ }
    }
    try {
      const prefix = `${stripExpiry(name)}.`
      const sidecar = readdirSync(join(root, '.rpmeta')).find(entry => entry.startsWith(prefix) && entry.endsWith('.json'))
      if (sidecar) return parse(readFileSync(join(root, '.rpmeta', sidecar), 'utf8'))
    } catch { /* metadata is optional */ }
    return undefined
  }

  async store(type: 'file' | 'remote' | 'oneshot' | 'url' | 'oneshot_url', input: Buffer | string, originalName: string, expiry: number | undefined, headerName: string | undefined, metadata: UploadMetadata, token?: string): Promise<{ fileName: string; storedName: string; root: string; size: number }> {
    const root = this.rootForToken(token)
    const directory = type === 'file' || type === 'remote' ? root : join(root, type)
    mkdirSync(directory, { recursive: true })
    const data = typeof input === 'string' ? Buffer.from(input) : input
    const guessedMime = mimeFromName(originalName)
    if (this.config.value.mimeBlacklist.includes(guessedMime)) throw apiError(415, 'this file type is not permitted')
    if (data.length === 0) throw apiError(400, 'invalid file size')
    const limit = this.auth.fileSizeLimit()
    if (limit != null && data.length > limit) throw apiError(413, 'file exceeds the configured file size limit')
    if (this.config.value.maxContentLength && data.length > this.config.value.maxContentLength) throw apiError(413, 'payload too large')
    if (type === 'remote' && !this.config.value.duplicateFiles && expiry == null) {
      const digest = createHash('sha256').update(data).digest('hex')
      const existing = this.allUploadFiles().find(item => !expiryFromName(item.name) && createHash('sha256').update(readFileSync(item.path)).digest('hex') === digest)
      if (existing) return { fileName: stripExpiry(existing.name), storedName: existing.name, root: existing.root, size: statSync(existing.path).size }
    }
    if (this.config.value.maxUploadDirSize != null && this.directorySize(this.root) + data.length > this.config.value.maxUploadDirSize) throw apiError(507, 'upload directory size limit exceeded')
    let name = type === 'url' || type === 'oneshot_url' ? (headerName || (this.config.value.randomUrl ? randomName(this.config.value.randomUrl) : type)) : this.applyNameRules(headerName || originalName, data)
    if (headerName) name = basename(headerName)
    const path = safeChild(directory, name)
    if (existsSync(path) && !expiry) throw apiError(409, 'file already exists')
    const storedName = expiry ? `${name}.${expiry}` : name
    const storedPath = safeChild(directory, storedName)
    if (existsSync(storedPath)) throw apiError(409, 'file already exists')
    writeFileSync(storedPath, data)
    this.writeMetadata(root, storedName, metadata)
    return { fileName: name, storedName, root, size: data.length }
  }

  private candidateNames(directory: string, requested: string): string[] {
    const clean = basename(requested)
    if (clean !== requested) return []
    const found: string[] = []
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      if (entry.name === clean || stripExpiry(entry.name) === clean) {
        const expiry = expiryFromName(entry.name)
        if (!expiry || expiry > Date.now()) found.push(entry.name)
      }
    }
    return found.sort()
  }

  locate(requested: string, token?: string): LocatedFile {
    const clean = decodeURIComponent(requested).replace(/^\/+/, '')
    if (!clean || clean.includes('/') || clean.includes('\\')) throw apiError(404, 'file is not found or expired :(')
    const roots = token ? [this.rootForToken(token)] : [this.root]
    if (!token) {
      for (const entry of readdirSync(this.root, { withFileTypes: true })) if (entry.isDirectory() && !hiddenDirs.has(entry.name)) roots.push(join(this.root, entry.name))
    }
    const locations: Array<[string, 'file' | 'url' | 'oneshot' | 'oneshot_url']> = []
    for (const root of roots) {
      const accountRootWithoutToken = !token && root !== this.root
      const directories = accountRootWithoutToken
        ? [['', 'file'] as const]
        : [['', 'file'], ['url', 'url'], ['oneshot', 'oneshot'], ['oneshot_url', 'oneshot_url']] as const
      for (const [dir, kind] of directories) locations.push([join(root, dir), kind])
    }
    for (const [directory, kind] of locations) {
      if (!existsSync(directory)) continue
      const matches = this.candidateNames(directory, clean)
      if (matches.length === 1) {
        const root = roots.filter(candidate => directory === candidate || directory.startsWith(`${candidate}/`)).sort((a, b) => b.length - a.length)[0] ?? this.root
        return { path: join(directory, matches[0]), root, name: matches[0], kind }
      }
    }
    throw apiError(404, 'file is not found or expired :(')
  }

  resolveToken(token: string): { fileName: string; rawPath: string; uploader?: string; located: LocatedFile } {
    const clean = decodeURIComponent(token).replace(/^\/+/, '')
    if (!clean || clean.includes('/')) throw apiError(404, 'file is not found or expired :(')
    const matches: Array<{ located: LocatedFile; owner?: string }> = []
    const roots = [this.root]
    for (const entry of readdirSync(this.root, { withFileTypes: true })) if (entry.isDirectory() && !hiddenDirs.has(entry.name)) roots.push(join(this.root, entry.name))
    for (const root of roots) {
      for (const directory of [root, join(root, 'url'), join(root, 'oneshot'), join(root, 'oneshot_url')]) {
        if (!existsSync(directory)) continue
        for (const name of readdirSync(directory)) if ((stripExpiry(name) === clean || stripExpiry(name).split('.')[0] === clean) && (!expiryFromName(name) || (expiryFromName(name) as number) > Date.now())) {
          const located: LocatedFile = { path: join(directory, name), root, name, kind: directory.endsWith('/url') ? 'url' : directory.endsWith('/oneshot') ? 'oneshot' : directory.endsWith('/oneshot_url') ? 'oneshot_url' : 'file' }
          const ownerToken = root === this.root ? undefined : Buffer.from(root.split('/').pop()!, 'base64url').toString()
          matches.push({ located, owner: ownerToken ? this.auth.userByToken(ownerToken)?.username : undefined })
        }
      }
    }
    if (matches.length !== 1) throw apiError(404, 'file is not found or expired :(')
    const fileName = stripExpiry(matches[0].located.name)
    return { fileName, rawPath: this.publicPath(fileName), uploader: matches[0].owner, located: matches[0].located }
  }

  publicPath(fileName: string) {
    const dot = fileName.indexOf('.')
    return dot < 0 ? `/${fileName}/file` : `/${fileName.slice(0, dot)}/file.${fileName.slice(dot + 1)}`
  }

  contentType(name: string): string {
    for (const matcher of this.config.value.mimeOverride) if (matcher.regex?.test(name)) return matcher.mime
    return mimeFromName(name)
  }

  remove(located: LocatedFile) {
    try { unlinkSync(located.path) } catch { throw apiError(404, 'file is not found or expired :(') }
    const sidecar = this.metadataPath(located.root, located.name)
    try { unlinkSync(sidecar) } catch { /* metadata is optional */ }
  }

  expiresAt(name: string) { return expiryFromName(name) }
  metadataFor(located: LocatedFile) { return this.readMetadata(located.root, located.name) }
  fileStat(located: LocatedFile) { return statSync(located.path) }
  read(located: LocatedFile) { return readFileSync(located.path) }
  renameForOneshot(located: LocatedFile) { renameSync(located.path, `${located.path}.consumed`) }
  listFiles(root: string) {
    const rows: any[] = []
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name.startsWith('.')) continue
      const expiry = expiryFromName(entry.name)
      if (expiry && expiry <= Date.now()) continue
      const stat = statSync(join(root, entry.name))
      rows.push({ file_name: stripExpiry(entry.name), file_size: stat.size, creation_date_utc: utcSeconds(stat.birthtimeMs), expires_at_utc: expiry ? utcSeconds(expiry) : null })
    }
    return rows
  }

  metadataForPath(path: string, root: string, requested: string) { return this.readMetadata(root, basename(path)) ?? this.readMetadata(root, requested) }
  private directorySize(path: string): number {
    if (!existsSync(path)) return 0
    return readdirSync(path, { withFileTypes: true }).reduce((total, entry) => {
      const child = join(path, entry.name)
      if (entry.isDirectory()) return total + this.directorySize(child)
      try { return total + statSync(child).size } catch { return total }
    }, 0)
  }

  cleanupExpired() {
    for (const item of this.allUploadFiles()) {
      const expiry = expiryFromName(item.name)
      if (!expiry || expiry > Date.now()) continue
      try { unlinkSync(item.path) } catch { continue }
      try { unlinkSync(this.metadataPath(item.root, item.name)) } catch { /* metadata is optional */ }
    }
  }

  allUploadFiles() {
    const roots = [this.root, ...readdirSync(this.root, { withFileTypes: true }).filter(entry => entry.isDirectory() && !hiddenDirs.has(entry.name)).map(entry => join(this.root, entry.name))]
    return roots.flatMap(root => [root, join(root, 'oneshot'), join(root, 'url'), join(root, 'oneshot_url')]).flatMap(directory => {
      if (!existsSync(directory)) return []
      const root = roots.filter(candidate => directory === candidate || directory.startsWith(`${candidate}/`)).sort((a, b) => b.length - a.length)[0] ?? this.root
      return readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isFile() && !entry.name.startsWith('.')).map(entry => ({ path: join(directory, entry.name), root, name: entry.name }))
    })
  }
}
