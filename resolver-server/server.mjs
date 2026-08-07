import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const PORT = Number.parseInt(process.env.RESOLVER_PORT ?? '3101', 10)
const UPLOAD_DIR = process.env.RESOLVER_UPLOAD_DIR?.trim() || '/var/lib/yaemipaste/upload'
const USERS_DB_PATH = process.env.RESOLVER_USERS_DB_PATH?.trim() || '/var/lib/yaemipaste-auth/users.db'
const PUBLIC_ORIGIN = (process.env.RESOLVER_PUBLIC_ORIGIN?.trim() || 'http://localhost:8080').replace(/\/$/, '')
const CACHE_TTL_MS = Number.parseInt(process.env.RESOLVER_CACHE_TTL_MS ?? '30000', 10)
const execFileAsync = promisify(execFile)

const cache = new Map()

function json(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  response.end(JSON.stringify(body))
}

function tokenCandidates(token) {
  const candidates = new Set()
  const clean = decodeToken(token)
  if (clean) candidates.add(clean)
  try {
    const normalized = clean.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
    const decoded = Buffer.from(padded, 'base64').toString('utf8').trim()
    if (decoded && !decoded.includes('\n')) candidates.add(decoded)
  } catch {
    // ignore invalid base64 tokens
  }
  return [...candidates]
}

async function resolveTokenOwner(token) {
  for (const candidate of tokenCandidates(token)) {
    try {
      const escapedToken = candidate.replace(/'/g, "''")
      const { stdout } = await execFileAsync('sqlite3', [
        '-noheader',
        '-batch',
        USERS_DB_PATH,
        `SELECT username FROM users WHERE token = '${escapedToken}' LIMIT 1;`,
      ])
      const username = stdout.trim()
      if (username) return username
    } catch {
      // continue to next candidate
    }
  }
  return null
}

function decodeToken(token) {
  try {
    return decodeURIComponent(token).replace(/^\/+/, '').trim()
  } catch {
    return token.replace(/^\/+/, '').trim()
  }
}

function fileIdFromName(fileName) {
  const dot = fileName.indexOf('.')
  return dot === -1 ? fileName : fileName.slice(0, dot)
}

const GENERATED_SUFFIX_EXTENSIONS = new Set([
  'mp4',
  'webm',
  'mov',
  'avi',
  'mkv',
  'm4v',
  'mp3',
  'wav',
  'ogg',
  'flac',
  'm4a',
  'aac',
  'opus',
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'avif',
  'bmp',
  'svg',
  'txt',
  'md',
  'json',
  'csv',
  'log',
  'xml',
  'yaml',
  'yml',
  'toml',
  'ini',
  'js',
  'ts',
  'css',
  'html',
  'pdf',
  'rpenc',
])

function stripGeneratedSuffix(fileName) {
  const parts = fileName.split('.')
  if (parts.length < 3) return fileName
  const trailing = parts[parts.length - 1]
  const extension = parts[parts.length - 2].toLowerCase()
  if (!/^\d{6,}$/.test(trailing)) return fileName
  if (!GENERATED_SUFFIX_EXTENSIONS.has(extension)) return fileName
  return parts.slice(0, -1).join('.')
}

function publicPathFromFileName(fileName) {
  const cleanedName = stripGeneratedSuffix(fileName)
  const [id = '', ...rest] = cleanedName.split('.')
  const suffix = rest.join('.')
  return suffix ? `/${encodeURIComponent(id)}/file.${encodeURIComponent(suffix)}` : `/${encodeURIComponent(id)}/file`
}

function redirectLocation(url, fileName) {
  const target = new URL(`${PUBLIC_ORIGIN}${publicPathFromFileName(fileName)}`)
  if (url.search) target.search = url.search
  return target.toString()
}

async function fileExists(fileName) {
  try {
    const result = await stat(join(UPLOAD_DIR, fileName))
    return result.isFile()
  } catch {
    return false
  }
}

async function findMatchesInDirectory(directoryPath, cleanToken) {
  const entries = await readdir(directoryPath, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .filter((name) => fileIdFromName(name) === cleanToken)
}

async function resolveFileRecord(token) {
  const cleanToken = decodeToken(token)
  if (!cleanToken || cleanToken.includes('/')) return null

  const cached = cache.get(cleanToken)
  if (cached && cached.expiresAt > Date.now()) return { fileName: cached.fileName, ownerToken: cached.ownerToken ?? null }

  if (await fileExists(cleanToken)) {
    cache.set(cleanToken, { fileName: cleanToken, ownerToken: null, expiresAt: Date.now() + CACHE_TTL_MS })
    return { fileName: cleanToken, ownerToken: null }
  }

  const rootEntries = await readdir(UPLOAD_DIR, { withFileTypes: true })
  const matches = (await findMatchesInDirectory(UPLOAD_DIR, cleanToken))
    .map((fileName) => ({ fileName, canonicalFileName: stripGeneratedSuffix(fileName), ownerToken: null }))

  for (const entry of rootEntries) {
    if (!entry.isDirectory()) continue
    if (['oneshot', 'oneshot_url', 'url'].includes(entry.name)) continue
    for (const name of await findMatchesInDirectory(join(UPLOAD_DIR, entry.name), cleanToken)) {
      matches.push({ fileName: name, canonicalFileName: stripGeneratedSuffix(name), ownerToken: entry.name })
    }
  }

  // The upload store can expose the same file under several names:
  // - root and token-scoped mirrors/symlinks
  // - generated timestamp suffixes (e.g. .mp4.1777...)
  // Collapse to one canonical filename, preferring owner-scoped and clean names.
  const byCanonicalName = new Map()
  for (const entry of matches) {
    const key = entry.canonicalFileName
    const existing = byCanonicalName.get(key)
    if (!existing) {
      byCanonicalName.set(key, entry)
      continue
    }
    if (!existing.ownerToken && entry.ownerToken) {
      byCanonicalName.set(key, entry)
      continue
    }
    if (existing.fileName !== existing.canonicalFileName && entry.fileName === entry.canonicalFileName) {
      byCanonicalName.set(key, entry)
    }
  }
  const uniqueMatches = [...byCanonicalName.values()]
  if (uniqueMatches.length !== 1) return null

  const resolved = uniqueMatches[0]
  cache.set(cleanToken, { fileName: resolved.canonicalFileName, ownerToken: resolved.ownerToken, expiresAt: Date.now() + CACHE_TTL_MS })
  return { fileName: resolved.canonicalFileName, ownerToken: resolved.ownerToken }
}

function routeSegments(pathname) {
  return pathname.split('/').filter(Boolean)
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
  const segments = routeSegments(url.pathname)

  if (url.pathname === '/healthz') {
    return json(response, 200, { ok: true })
  }

  if (segments[0] === 'resolve' && segments[1]) {
    try {
      const resolved = await resolveFileRecord(segments.slice(1).join('/'))
      if (!resolved) return json(response, 404, { error: 'not_found' })
      const uploader = resolved.ownerToken ? await resolveTokenOwner(resolved.ownerToken) : null
      return json(response, 200, {
        file_name: resolved.fileName,
        raw_path: publicPathFromFileName(resolved.fileName),
        uploader,
      })
    } catch (error) {
      return json(response, 500, { error: 'resolve_failed', detail: error instanceof Error ? error.message : 'resolve_failed' })
    }
  }

  if (url.pathname === '/token-owner') {
    const token = request.headers.authorization?.trim() ?? ''
    if (!token) return json(response, 401, { error: 'missing_token' })
    const username = await resolveTokenOwner(token)
    if (!username) return json(response, 404, { error: 'not_found' })
    return json(response, 200, { username })
  }

  if (segments[0] === 'file' && segments[1] && ['preview', 'raw', 'download'].includes(segments[2] ?? '')) {
    try {
      const token = segments[1].split('+')[0]
      const resolved = await resolveFileRecord(token)
      if (!resolved) return json(response, 404, { error: 'not_found' })
      response.writeHead(302, {
        Location: redirectLocation(url, resolved.fileName),
        'Cache-Control': 'no-store',
      })
      response.end()
      return
    } catch (error) {
      return json(response, 500, { error: 'redirect_failed', detail: error instanceof Error ? error.message : 'redirect_failed' })
    }
  }

  return json(response, 404, { error: 'not_found' })
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`resolver-server listening on ${PORT}`)
})
