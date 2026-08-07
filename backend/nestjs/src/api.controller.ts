import { Controller, Delete, Get, Headers, HttpCode, Param, Post, Query, Req, Res, UploadedFiles, UseInterceptors } from '@nestjs/common'
import { AnyFilesInterceptor } from '@nestjs/platform-express'
import type { Request, Response } from 'express'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, readFileSync } from 'node:fs'
import { readFile, unlink } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { basename } from 'node:path'
import { tmpdir } from 'node:os'
import { diskStorage } from 'multer'
import { AuthService } from './auth.service.js'
import { ConfigService } from './config.service.js'
import { apiError } from './errors.js'
import { requestPinnedHttp } from './safe-http.js'
import { StorageService, type UploadMetadata } from './storage.service.js'

function flag(value: unknown) { return ['1', 'true', 'yes'].includes(String(value ?? '').trim().toLowerCase()) }
function jsonBody(value: unknown): Record<string, any> {
  if (typeof value !== 'string') return value && typeof value === 'object' ? value as Record<string, any> : {}
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' ? parsed : {} } catch { return {} }
}

async function readRemoteBody(response: IncomingMessage, maximumBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const value of response) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    total += chunk.length
    if (total > maximumBytes) {
      response.destroy()
      throw apiError(413, 'payload too large')
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, total)
}

async function fetchRemoteFile(start: URL, timeoutMs: number, maximumBytes: number): Promise<{ data: Buffer; name: string }> {
  let current = start
  for (let attempt = 0; attempt < 5; attempt++) {
    let response: IncomingMessage
    try {
      response = await requestPinnedHttp(current, { method: 'GET', timeoutMs })
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error)
      if (message.includes('private')) throw apiError(403, 'remote uploads cannot target private addresses')
      if (message.includes('credentials') || message.includes('HTTP(S)')) throw apiError(400, 'remote upload URL must be public HTTP(S) without credentials')
      throw apiError(400, 'could not resolve remote URL')
    }
    const status = response.statusCode ?? 0
    if (status >= 300 && status < 400) {
      const locationHeader = response.headers.location
      const location = Array.isArray(locationHeader) ? locationHeader[0] : locationHeader
      response.resume()
      if (!location) throw apiError(502, 'remote upload redirect is invalid')
      try { current = new URL(location, current) } catch { throw apiError(502, 'remote upload redirect is invalid') }
      continue
    }
    if (status < 200 || status >= 300) {
      response.resume()
      throw apiError(502, 'remote upload failed')
    }
    return { data: await readRemoteBody(response, maximumBytes), name: basename(current.pathname) || 'file' }
  }
  throw apiError(502, 'too many remote upload redirects')
}

@Controller()
export class ApiController {
  constructor(private readonly config: ConfigService, private readonly auth: AuthService, private readonly storage: StorageService) {}

  @Get('/')
  index(@Res() response: Response) {
    const page = this.config.value.landingPage
    if (page?.file) {
      try { return response.type(page.contentType ?? 'text/plain; charset=utf-8').send(readFileSync(page.file, 'utf8')) } catch { return response.redirect(302, 'https://github.com/emiliauh/yaemipaste') }
    }
    if (page?.text != null) return response.type(page.contentType ?? 'text/plain; charset=utf-8').send(page.text)
    return response.redirect(302, 'https://github.com/emiliauh/yaemipaste')
  }

  @Get('version')
  version(@Req() request: Request) {
    if (!this.auth.uploadToken(request)) throw apiError(401, 'Unauthorized')
    if (!this.config.value.exposeVersion) throw apiError(404, '')
    return `${process.env.npm_package_version || '0.1.0'}\n`
  }

  @Get('list')
  list(@Req() request: Request) {
    const token = this.auth.uploadToken(request)
    if (!token) throw apiError(401, 'Unauthorized')
    if (!this.config.value.exposeList) throw apiError(404, '')
    return this.storage.listFiles(this.storage.rootForToken(token))
  }

  @Get('resolve/:token')
  resolve(@Param('token') token: string) {
    const resolved = this.storage.resolveToken(token)
    return { file_name: resolved.fileName, raw_path: resolved.rawPath, uploader: resolved.uploader ?? null }
  }

  @Get('token-owner')
  tokenOwner(@Req() request: Request) {
    const token = this.auth.tokenForRequest(request)
    const user = token ? this.auth.userByToken(token) : undefined
    if (!user) throw apiError(404, 'token not found')
    return { username: user.username }
  }

  @Get('meta/:file')
  publicMeta(@Req() request: Request, @Res() response: Response, @Query('raw') _raw: string, @Query('download') _download: string) {
    const requested = decodeURIComponent(String(request.params.file))
    const located = this.storage.locate(requested, this.auth.uploadToken(request))
    if (!['file', 'oneshot'].includes(located.kind)) throw apiError(404, 'file is not found or expired :(')
    const meta = this.storage.metadataFor(located)
    const stat = this.storage.fileStat(located)
    return response.set({
      'Cache-Control': 'no-store',
      'CDN-Cache-Control': 'no-store',
      'Cloudflare-CDN-Cache-Control': 'no-store',
    }).json({
      file_name: requested,
      display_name: meta?.display_name ?? requested,
      uploader: meta?.uploader ?? 'Unknown (token user)',
      source: meta?.source ?? null,
      upload_date_utc: new Date(Math.floor(stat.birthtimeMs / 1000) * 1000).toISOString(),
      download_name: meta?.display_name ?? requested,
      file_size: stat.size,
      mime_type: this.storage.contentType(requested),
    })
  }

  @Get('file/:token/:mode')
  fileRoute(@Req() _request: Request, @Res() response: Response) {
    const token = String(_request.params.token).split('+')[0]
    const mode = String(_request.params.mode)
    if (!['preview', 'raw', 'download'].includes(mode)) throw apiError(404, 'file is not found or expired :(')
    const resolved = this.storage.resolveToken(token)
    if ((mode === 'raw' || mode === 'download') && resolved.fileName.endsWith('.rpenc')) {
      return response.redirect(302, `/file/${_request.params.token}/preview`)
    }
    return response.redirect(302, this.storage.publicPath(resolved.fileName))
  }

  @Get(':id/:name')
  shortFile(@Req() request: Request, @Res() response: Response, @Query('raw') raw: string, @Query('download') download: string) {
    const id = String(request.params.id)
    const name = String(request.params.name)
    const resolvedName = name === 'file' ? id : name.startsWith('file.') ? `${id}.${name.slice(5)}` : `${id}.${name}`
    return this.serve(request, response, resolvedName, raw, download)
  }

  @Get(':file')
  file(@Req() request: Request, @Res() response: Response, @Query('raw') raw: string, @Query('download') download: string) {
    return this.serve(request, response, decodeURIComponent(String(request.params.file)), raw, download)
  }

  private serve(request: Request, response: Response, requested: string, raw: string, download: string) {
    const located = this.storage.locate(requested, this.auth.uploadToken(request))
    const forceRaw = flag(raw)
    const forceDownload = flag(download)
    if ((located.kind === 'url' || located.kind === 'oneshot_url')) {
      const destination = this.storage.read(located).toString('utf8')
      if (located.kind === 'oneshot_url') this.storage.renameForOneshot(located)
      return response.redirect(302, destination)
    }
    const acceptsHtml = String(request.headers.accept ?? '').includes('text/html')
    if (!forceRaw && !forceDownload && acceptsHtml && !located.name.endsWith('.rpenc')) {
      const dot = requested.indexOf('.')
      const fileToken = encodeURIComponent(dot < 0 ? requested : requested.slice(0, dot))
      return response.status(302).set({ 'Location': `${this.config.value.publicUrl}/file/${fileToken}/preview`, 'Cache-Control': 'no-store', Vary: 'Accept' }).send()
    }
    const meta = this.storage.metadataFor(located)
    const contentType = forceDownload ? 'application/octet-stream' : this.storage.contentType(meta?.display_name ?? requested)
    const unsafeInline = ['text/html', 'application/xhtml+xml', 'image/svg+xml', 'application/javascript', 'text/javascript'].includes(contentType)
    const downloadName = basename(meta?.display_name ?? requested).replace(/[\u0000-\u001f\u007f"]/g, '') || 'file'
    response.set({ 'Content-Type': contentType, 'Content-Disposition': `${forceDownload || unsafeInline ? 'attachment' : 'inline'}; filename="${downloadName}"`, 'X-Content-Type-Options': 'nosniff' })
    const stream = createReadStream(located.path)
    if (located.kind === 'oneshot') stream.once('end', () => this.storage.renameForOneshot(located))
    stream.once('error', () => response.destroy())
    return stream.pipe(response)
  }

  @Post('/')
  @HttpCode(200)
  @UseInterceptors(AnyFilesInterceptor({
    storage: diskStorage({
      destination: tmpdir(),
      filename: (_request, file, callback) => callback(null, `yaemipaste-${randomUUID()}-${basename(file.originalname || 'file')}`),
    }),
    limits: { fileSize: 256 * 1024 * 1024, files: 4 },
  }))
  async upload(@Req() request: Request, @Res() response: Response, @UploadedFiles() files: Array<{ fieldname: string; buffer?: Buffer; path?: string; originalname: string }>) {
    const token = this.auth.requireUploadAccess(request)
    const body = request.body ?? {}
    const meta = jsonBody(body.meta)
    const uploader = String(body.uploader ?? meta.uploader ?? (request.headers['x-upload-client'] ? this.auth.uploadOwner(request) : '')).trim()
    const source = String(body.source ?? meta.source ?? (String(request.headers['x-upload-client'] ?? '').toLowerCase() === 'sharex' ? 'ShareX' : '')).trim()
    const metadata: UploadMetadata = {
      keep_file_name: flag(body.keepFileName ?? body.keep_file_name ?? meta.keepFileName ?? meta.keep_file_name),
      original_name: String(body.originalName ?? body.original_name ?? meta.originalName ?? meta.original_name ?? ''),
      uploader,
      source,
      password_salt: String(body.passwordSalt ?? body.password_salt ?? meta.passwordSalt ?? meta.password_salt ?? ''),
    }
    const expiry = this.storage.parseExpiry(String(request.headers.expire ?? ''))
    const headerName = request.headers.filename ? String(request.headers.filename) : undefined
    const results: string[] = []
    const candidates = files?.length ? files : Object.entries(body).filter(([key]) => ['file', 'remote', 'url', 'oneshot', 'oneshot_url'].includes(key)).map(([fieldname, value]) => ({ fieldname, buffer: Buffer.from(String(value)), originalname: fieldname })) as any
    if (!candidates.length) throw apiError(400, 'file data not present')
    for (const file of candidates) {
      const tempPath = typeof file.path === 'string' ? file.path : ''
      try {
        const field = String(file.fieldname)
        let type: 'file' | 'remote' | 'oneshot' | 'url' | 'oneshot_url' = field === 'remote' || field === 'url' || field === 'oneshot' || field === 'oneshot_url' ? field : 'file'
        let data = file.buffer ? Buffer.from(file.buffer) : tempPath ? await readFile(tempPath) : Buffer.alloc(0)
        let name = file.originalname || 'file'
        if (type === 'remote') {
          if (!this.config.value.remoteUploadsEnabled) throw apiError(403, 'remote uploads are disabled')
          let url: URL
          try { url = new URL(data.toString('utf8').trim()) } catch { throw apiError(400, 'invalid URL') }
          const remote = await fetchRemoteFile(url, this.config.value.timeoutMs, this.config.value.maxContentLength)
          data = remote.data
          name = remote.name
        }
        const stored = await this.storage.store(type, data, name, expiry, headerName, metadata, token)
        results.push(`${this.config.value.publicUrl}${this.storage.publicPath(stored.fileName)}\n`)
        this.auth.dispatchWebhook('file.uploaded', {
          file: stored.fileName,
          url: `${this.config.value.publicUrl}${this.storage.publicPath(stored.fileName)}`,
          uploader: metadata.uploader || this.auth.uploadOwner(request),
          source: metadata.source || null,
          size_bytes: stored.size,
          sha256: createHash('sha256').update(data).digest('hex'),
        })
      } finally {
        if (tempPath) await unlink(tempPath).catch(() => undefined)
      }
    }
    return response.type('text/plain').send(results.join(''))
  }

  @Delete('*file')
  delete(@Req() request: Request) {
    const token = this.auth.deleteToken(request)
    if (!token) throw apiError(401, 'Unauthorized')
    const wildcard = (request.params as Record<string, unknown>).file
    const rawValue = Array.isArray(wildcard) ? wildcard.join('/') : String(wildcard ?? '')
    const rawPath = decodeURIComponent(rawValue).replace(/^\/+/, '')
    const segments = rawPath.split('/')
    const requested = segments.length === 1
      ? segments[0]
      : segments.length === 2
        ? segments[1] === 'file'
          ? segments[0]
          : segments[1].startsWith('file.')
            ? `${segments[0]}.${segments[1].slice(5)}`
            : `${segments[0]}.${segments[1]}`
        : rawPath
    const located = this.storage.locate(requested, token)
    const bytes = this.storage.fileStat(located).size
    this.storage.remove(located)
    this.auth.dispatchWebhook('file.deleted', { file: rawPath, owner: this.auth.userByToken(token)?.username ?? null, bytes_removed: bytes })
    return 'file deleted\n'
  }
}
