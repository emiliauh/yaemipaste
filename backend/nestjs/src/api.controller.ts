import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Post, Put, Query, Req, Res, UploadedFiles, UseInterceptors } from '@nestjs/common'
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

function html(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character] ?? character))
}

/** Normalize a stored accent color into a 6-digit lowercase hex (#rrggbb) usable by
 *  crawler theme-color tags (Discord ignores non-hex or short values). Returns '' when absent/invalid. */
function accentThemeColor(value: unknown): string {
  let v = String(value ?? '').trim()
  if (!v) return ''
  v = v.replace(/^#/, '')
  if (/^[0-9a-f]{3}$/i.test(v)) v = v.split('').map(c => c + c).join('')
  if (!/^[0-9a-f]{6}$/i.test(v)) return ''
  return '#' + v.toLowerCase()
}

async function readRemoteBody(response: IncomingMessage, maximumBytes?: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const value of response) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    total += chunk.length
    if (maximumBytes != null && total > maximumBytes) {
      response.destroy()
      throw apiError(413, 'payload too large')
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, total)
}

async function fetchRemoteFile(start: URL, timeoutMs: number, maximumBytes?: number): Promise<{ data: Buffer; name: string }> {
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

  @Get('pins')
  pins(@Req() request: Request) {
    const token = this.auth.uploadToken(request)
    if (!token) throw apiError(401, 'Unauthorized')
    return { pins: this.storage.readPins(token) }
  }

  @Put('pins')
  updatePins(@Req() request: Request, @Body() body: { pins?: unknown }) {
    const token = this.auth.uploadToken(request)
    if (!token) throw apiError(401, 'Unauthorized')
    const pins = Array.isArray(body.pins) ? body.pins.map(String).filter((value: string) => value.trim() !== '') : []
    this.storage.writePins(token, pins)
    return { pins: this.storage.readPins(token) }
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
  fileRoute(@Req() _request: Request, @Res() response: Response, @Headers('x-preview-embed') previewEmbed?: string, @Query('embed') embed?: string) {
    const token = String(_request.params.token).split('+')[0]
    const mode = String(_request.params.mode)
    if (!['preview', 'raw', 'download'].includes(mode)) throw apiError(404, 'file is not found or expired :(')
    const resolved = this.storage.resolveToken(token)
    if ((mode === 'raw' || mode === 'download') && resolved.fileName.endsWith('.rpenc')) {
      return response.redirect(302, `/file/${_request.params.token}/preview`)
    }
    // Keep canonical raw links direct. This makes /file/<token>/raw usable by
    // media crawlers and clients that do not follow SPA redirects (Discord).
    if (mode === 'raw') return this.serve(_request, response, resolved.fileName, '1', '')
    if (mode === 'preview' && (flag(previewEmbed) || flag(embed) || String(_request.headers.accept ?? '').includes('text/html'))) {
      return this.previewEmbed(response, token, resolved.fileName, resolved.uploader, resolved.located)
    }
    return response.redirect(302, this.storage.publicPath(resolved.fileName))
  }

  private previewEmbed(response: Response, token: string, fileName: string, uploader: string | undefined, located: ReturnType<StorageService['locate']>) {
    const metadata = this.storage.metadataFor(located)
    const stat = this.storage.fileStat(located)
    const displayName = metadata?.display_name ?? fileName
    const contentType = this.storage.contentType(displayName)
    const origin = this.config.value.publicUrl
    const previewUrl = `${origin}/file/${encodeURIComponent(token)}/preview`
    // Social crawlers need a public URL that resolves directly to the media.
    // The API raw route handles expiring filenames consistently behind both
    // the bundled Nginx proxy and split-host reverse proxies.
    const rawUrl = `${origin}/api/${encodeURIComponent(fileName)}?raw=1`
    const description = `${contentType} · ${stat.size.toLocaleString('en-US')} bytes${uploader ? ` · ${uploader}` : ''}`
    const isImage = contentType.startsWith('image/')
    const isVideo = contentType.startsWith('video/')
    const isAudio = contentType.startsWith('audio/')
    const mediaType = isVideo ? 'video.other' : isAudio ? 'music.song' : 'website'
    const imageMeta = isImage
      ? `<meta property="og:image" content="${html(rawUrl)}"><meta property="og:image:url" content="${html(rawUrl)}"><meta property="og:image:secure_url" content="${html(rawUrl)}"><meta property="og:image:type" content="${html(contentType)}"><meta property="og:image:alt" content="${html(displayName)}">`
      : ''
    const videoMeta = isVideo
      ? `<meta property="og:video" content="${html(rawUrl)}"><meta property="og:video:secure_url" content="${html(rawUrl)}"><meta property="og:video:type" content="${html(contentType)}">`
      : ''
    const audioMeta = isAudio
      ? `<meta property="og:audio" content="${html(rawUrl)}"><meta property="og:audio:secure_url" content="${html(rawUrl)}"><meta property="og:audio:type" content="${html(contentType)}">`
      : ''
    const themeColor = accentThemeColor(this.auth.settings().accent_color)
    const themeColorMeta = themeColor ? `<meta name="theme-color" content="${themeColor}">` : ''
    const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${html(displayName)} · yaemipaste</title>${themeColorMeta}<meta name="description" content="${html(description)}"><link rel="canonical" href="${html(previewUrl)}"><meta property="og:type" content="${mediaType}"><meta property="og:title" content="${html(displayName)}"><meta property="og:description" content="${html(description)}"><meta property="og:url" content="${html(previewUrl)}">${imageMeta}${videoMeta}${audioMeta}<meta name="twitter:card" content="${isImage ? 'summary_large_image' : 'summary'}"><meta name="twitter:title" content="${html(displayName)}"><meta name="twitter:description" content="${html(description)}">${isImage ? `<meta name="twitter:image" content="${html(rawUrl)}">` : ''}</head><body><main><h1>${html(displayName)}</h1><p>${html(description)}</p><p><a href="${html(previewUrl)}">Open preview</a></p></main></body></html>`
    return response.status(200).set({
      'Cache-Control': 'no-store',
      'CDN-Cache-Control': 'no-store',
      'Content-Type': 'text/html; charset=utf-8',
      Vary: 'Accept, User-Agent',
    }).send(body)
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
    return this.streamFile(request, response, located, forceDownload)
  }

  /**
   * Stream a stored file, honouring HTTP Range requests so media can seek and
   * play in browsers that require partial-content support (iOS Safari, Firefox).
   */
  private streamFile(request: Request, response: Response, located: ReturnType<StorageService['locate']>, forceDownload: boolean) {
    const size = this.storage.fileStat(located).size
    const rangeHeader = String(request.headers.range ?? '')
    const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/)
    const isSingle = !!match
    if (!forceDownload && isSingle) {
      const startText = match[1]
      const endText = match[2]
      let start = 0
      let end = size - 1
      if (startText) {
        start = Number(startText)
        if (!Number.isFinite(start)) start = 0
      } else if (endText) {
        const suffix = Number(endText)
        if (Number.isFinite(suffix) && suffix > 0) start = Math.max(0, size - suffix)
      }
      if (endText && startText) {
        end = Number(endText)
        if (!Number.isFinite(end)) end = size - 1
      }
      if (start >= size || end < start) {
        response.set({ 'Content-Range': 'bytes */' + size })
        return response.status(416).end()
      }
      end = Math.min(end, size - 1)
      const length = end - start + 1
      response.set({
        'Accept-Ranges': 'bytes',
        'Content-Range': 'bytes ' + start + '-' + end + '/' + size,
        'Content-Length': String(length),
      })
      const stream = createReadStream(located.path, { start, end })
      if (located.kind === 'oneshot' && end >= size - 1) stream.once('end', () => this.storage.renameForOneshot(located))
      stream.once('error', () => response.destroy())
      response.status(206); stream.pipe(response); return response
    }

    response.set({ 'Accept-Ranges': 'bytes', 'Content-Length': String(size) })
    const stream = createReadStream(located.path)
    if (located.kind === 'oneshot') stream.once('end', () => this.storage.renameForOneshot(located))
    stream.once('error', () => response.destroy())
    stream.pipe(response); return response
  }

  @Post('/')
  @HttpCode(200)
  @UseInterceptors(AnyFilesInterceptor({
    storage: diskStorage({
      destination: tmpdir(),
      filename: (_request, file, callback) => callback(null, `yaemipaste-${randomUUID()}-${basename(file.originalname || 'file')}`),
    }),
    limits: { files: 4 },
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
