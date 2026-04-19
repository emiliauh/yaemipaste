import { createServer } from 'node:http'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

const PORT = Number.parseInt(process.env.RESOLVER_PORT ?? '3101', 10)
const UPLOAD_DIR = process.env.RESOLVER_UPLOAD_DIR?.trim() || '/var/lib/rustypaste/upload'
const PUBLIC_ORIGIN = (process.env.RESOLVER_PUBLIC_ORIGIN?.trim() || 'https://example.invalid').replace(/\/$/, '')
const CACHE_TTL_MS = Number.parseInt(process.env.RESOLVER_CACHE_TTL_MS ?? '30000', 10)

const cache = new Map()

function json(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  response.end(JSON.stringify(body))
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

function publicPathFromFileName(fileName) {
  const [id = '', ...rest] = fileName.split('.')
  const suffix = rest.join('.')
  return suffix ? `/${encodeURIComponent(id)}/file.${encodeURIComponent(suffix)}` : `/${encodeURIComponent(id)}/file`
}

async function fileExists(fileName) {
  try {
    const result = await stat(join(UPLOAD_DIR, fileName))
    return result.isFile()
  } catch {
    return false
  }
}

async function resolveFileName(token) {
  const cleanToken = decodeToken(token)
  if (!cleanToken || cleanToken.includes('/')) return null

  const cached = cache.get(cleanToken)
  if (cached && cached.expiresAt > Date.now()) return cached.fileName

  if (await fileExists(cleanToken)) {
    cache.set(cleanToken, { fileName: cleanToken, expiresAt: Date.now() + CACHE_TTL_MS })
    return cleanToken
  }

  const entries = await readdir(UPLOAD_DIR, { withFileTypes: true })
  const matches = entries
    .filter((entry) => entry.isFile() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .filter((name) => fileIdFromName(name) === cleanToken)
    .sort()

  if (matches.length !== 1) return null

  cache.set(cleanToken, { fileName: matches[0], expiresAt: Date.now() + CACHE_TTL_MS })
  return matches[0]
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
      const fileName = await resolveFileName(segments.slice(1).join('/'))
      if (!fileName) return json(response, 404, { error: 'not_found' })
      return json(response, 200, {
        file_name: fileName,
        raw_path: publicPathFromFileName(fileName),
      })
    } catch (error) {
      return json(response, 500, { error: 'resolve_failed', detail: error instanceof Error ? error.message : 'resolve_failed' })
    }
  }

  if (segments[0] === 'file' && segments[1] && ['preview', 'raw', 'download'].includes(segments[2] ?? '')) {
    try {
      const token = segments[1].split('+')[0]
      const fileName = await resolveFileName(token)
      if (!fileName) return json(response, 404, { error: 'not_found' })
      response.writeHead(302, {
        Location: `${PUBLIC_ORIGIN}${publicPathFromFileName(fileName)}`,
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
