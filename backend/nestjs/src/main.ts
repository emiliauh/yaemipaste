import { BaseExceptionFilter, NestFactory } from '@nestjs/core'
import { Catch, type ArgumentsHost } from '@nestjs/common'
import { json, urlencoded, type NextFunction, type Request, type Response } from 'express'
import { AppModule } from './app.module.js'
import { ConfigService } from './config.service.js'

const activeMultipartUploads = new Map<string, number>()
const maximumTrackedClients = 10_000
const aggregateUploadLimitExceeded = Symbol('aggregateUploadLimitExceeded')

type GuardedRequest = Request & { [aggregateUploadLimitExceeded]?: boolean }

@Catch()
class AggregateUploadLimitFilter extends BaseExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const context = host.switchToHttp()
    const request = context.getRequest<GuardedRequest>()
    if (request?.[aggregateUploadLimitExceeded]) {
      const response = context.getResponse<Response>()
      if (!response.headersSent) response.status(413).json({ code: 'payload_too_large', detail: 'payload too large' })
      return
    }
    super.catch(exception, host)
  }
}

function configuredConcurrentUploadLimit(): number {
  const value = Number(process.env.MAX_CONCURRENT_UPLOADS_PER_CLIENT ?? 4)
  return Number.isInteger(value) && value > 0 ? value : 4
}

function isMultipartUpload(request: Request): boolean {
  return request.method === 'POST' && String(request.headers['content-type'] ?? '').toLowerCase().startsWith('multipart/form-data;')
}

function releaseUpload(client: string) {
  const active = activeMultipartUploads.get(client)
  if (active == null || active <= 1) activeMultipartUploads.delete(client)
  else activeMultipartUploads.set(client, active - 1)
}

export async function createApp() {
  const app = await NestFactory.create(AppModule, { bodyParser: false })
  const config = app.get(ConfigService)
  app.useGlobalFilters(new AggregateUploadLimitFilter(app.getHttpAdapter()))
  const maximumConcurrentUploadsPerClient = configuredConcurrentUploadLimit()
  app.getHttpAdapter().getInstance().set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 1))
  app.use((request: Request, response: Response, next: NextFunction) => {
    const length = Number(request.headers['content-length'] ?? 0)
    if (Number.isFinite(length) && length > config.value.maxContentLength) return response.status(413).json({ code: 'payload_too_large', detail: 'payload too large' })
    if (!isMultipartUpload(request)) return next()

    const client = request.ip || request.socket.remoteAddress || 'unknown'
    const active = activeMultipartUploads.get(client) ?? 0
    if (active >= maximumConcurrentUploadsPerClient) return response.status(429).json({ code: 'rate_limited', detail: 'too many concurrent uploads' })
    if (!active && activeMultipartUploads.size >= maximumTrackedClients) return response.status(429).json({ code: 'rate_limited', detail: 'too many concurrent upload clients' })
    activeMultipartUploads.set(client, active + 1)

    let released = false
    const release = () => {
      if (released) return
      released = true
      releaseUpload(client)
    }
    response.once('finish', release)
    response.once('close', release)

    let total = 0
    let rejected = false
    const guardChunk = (chunk: Buffer) => {
      if (rejected) return
      total += chunk.length
      if (total <= config.value.maxContentLength) return
      rejected = true
      const guardedRequest = request as GuardedRequest
      guardedRequest[aggregateUploadLimitExceeded] = true
      if (!response.headersSent) response.status(413).json({ code: 'payload_too_large', detail: 'payload too large' })
      request.destroy()
    }

    // Let Multer attach its multipart parser before observing the stream. Adding
    // a data listener first switches IncomingMessage into flowing mode.
    next()
    queueMicrotask(() => {
      if (!request.readableEnded && !request.destroyed) request.on('data', guardChunk)
    })
  })
  app.use(json({ limit: `${Math.ceil(config.value.maxContentLength / 1024 / 1024)}mb` }))
  app.use(urlencoded({ extended: true, limit: '1mb' }))
  app.enableCors({ origin: config.value.corsOrigins.length ? config.value.corsOrigins : false, methods: config.value.corsMethods, allowedHeaders: config.value.corsHeaders, credentials: false })
  return { app, config }
}

export async function bootstrap() {
  const { app, config } = await createApp()
  await app.listen(config.value.port, config.value.host)
  console.log(`yaemipaste NestJS API listening on ${config.value.host}:${config.value.port}`)
}

if (process.env.YAEMIPASTE_START !== '0') void bootstrap()
