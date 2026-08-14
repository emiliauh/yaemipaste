import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req, Res } from '@nestjs/common'
import { compareSync, hashSync } from 'bcryptjs'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, statSync, unlinkSync } from 'node:fs'
import { basename, relative } from 'node:path'
import type { Request, Response } from 'express'
import { AuthService } from './auth.service.js'
import { DatabaseService, nowSeconds } from './database.service.js'
import { ConfigService } from './config.service.js'
import { apiError } from './errors.js'
import { StorageService } from './storage.service.js'
import { assertPublicHttpUrl } from './safe-http.js'

const CONFIRM_DELETE_USER = 'DELETE USER'
const CONFIRM_PURGE_UPLOADS = 'PURGE UPLOADS'
const CONFIRM_PURGE_EXPIRED = 'PURGE EXPIRED'

function bool(value: unknown) { return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase()) }
function events(value: unknown) { return Array.isArray(value) ? [...new Set(value.map(String).map(item => item.trim().toLowerCase()).filter(Boolean))] : [] }
function preview(value: string) { return value.length <= 8 ? `${value.slice(0, 3)}…` : `${value.slice(0, 4)}…${value.slice(-4)}` }
function webhookUrl(value: string) {
  let parsed: URL
  try { parsed = new URL(value) } catch { throw apiError(400, 'Invalid webhook URL') }
  // Delegate to the same blocklist that guards actual delivery (requestPinnedHttp) so this
  // upfront check can never drift out of sync with the real enforcement point.
  try { assertPublicHttpUrl(parsed) } catch { throw apiError(400, 'Webhook URL must use a public HTTP(S) host') }
  return parsed.toString()
}

@Controller('auth/admin')
export class AdminController {
  constructor(private readonly auth: AuthService, private readonly db: DatabaseService, private readonly config: ConfigService, private readonly storage: StorageService) {}

  @Get('public-settings') publicSettings() {
    const settings = this.auth.settings()
    const turnstileSecretConfigured = !!(settings.turnstile_secret_key?.trim() || process.env.TURNSTILE_SECRET_KEY?.trim())
    return { app_name: settings.app_name || 'yaemipaste', public_title: settings.public_title || 'yaemipaste', registration_enabled: settings.registration_enabled !== 'false', base_api_url: settings.base_api_url || '', file_size_limit_bytes: Number(settings.file_size_limit_bytes || 0), file_size_limit_unlimited: settings.file_size_limit_unlimited === 'true', upload_access_mode: settings.upload_access_mode === 'public' ? 'public' : 'private', passkeys_enabled: this.auth.passkeysEnabled(), turnstile_site_key: settings.turnstile_site_key || '', turnstile_required: settings.turnstile_enabled === 'true' && !!settings.turnstile_site_key?.trim() && turnstileSecretConfigured }
  }

  @Get('claim/status') claimStatus() { return { admin_exists: this.auth.adminExists(), pending_claim: this.auth.pendingClaimExists(), claim_available: !this.auth.adminExists() && this.auth.pendingClaimExists() } }

  @Post('claim/init')
  @HttpCode(200)
  claimInit(@Req() request: Request, @Body() body: { reset?: boolean; ttl_seconds?: number }) {
    if (!this.auth.rateLimit(`claim-init:${request.ip}`, 6, 60_000)) throw apiError(429, 'Too many claim initialization attempts')
    this.auth.requireAdminBearer(request)
    if (this.auth.adminExists()) throw apiError(409, 'An administrator already exists; admin claim tokens are only for the first administrator')
    if (this.auth.pendingClaimExists() && !body.reset) throw apiError(409, 'A claim token is already pending and cannot be shown again; reset it explicitly if needed')
    const token = randomBytes(64).toString('base64url')
    const expires = nowSeconds() + Math.max(1, Number(body.ttl_seconds || 86_400))
    this.db.run('UPDATE admin_claims SET used_at=? WHERE used_at IS NULL', [nowSeconds()])
    this.db.run('INSERT INTO admin_claims (token_hash,created_at,expires_at) VALUES (?,?,?)', [hashSync(token, 12), nowSeconds(), expires])
    this.auth.audit('installer', 'admin.claim.init', null, 'success')
    return { token, expires_at: expires, detail: 'Admin claim token generated; it will not be shown again' }
  }

  @Post('claim')
  @HttpCode(200)
  claim(@Req() request: Request, @Body() body: { claim_token?: string; username?: string; password?: string; upload_token?: string }) {
    if (!this.auth.rateLimit(`claim:${request.ip}`, 8, 60_000)) throw apiError(429, 'Too many claim attempts')
    const username = String(body.username ?? '').trim().toLowerCase()
    if (this.auth.adminExists()) throw apiError(409, 'Admin access has already been claimed')
    const row = this.db.get<{ id: number; token_hash: string; expires_at: number | null }>('SELECT id,token_hash,expires_at FROM admin_claims WHERE used_at IS NULL ORDER BY id DESC LIMIT 1')
    if (!row) throw apiError(403, 'No active admin claim token')
    if (row.expires_at != null && row.expires_at <= nowSeconds()) throw apiError(403, 'Admin claim token expired')
    if (!body.claim_token || !compareSync(body.claim_token, row.token_hash)) throw apiError(403, 'Invalid admin claim token')
    const created = this.auth.createUser(username, String(body.password ?? ''), String(body.upload_token ?? ''), true)
    const claimed: any = this.db.run('UPDATE admin_claims SET used_at=? WHERE id=? AND used_at IS NULL', [nowSeconds(), row.id])
    if (!claimed.changes) throw apiError(409, 'Admin claim token already used')
    const session = { access_token: this.auth.createJwt(username), paste_token: created.token, username, is_admin: true }
    this.auth.audit(username, 'admin.claim', username, 'success')
    return session
  }

  private actor(request: Request) { return this.auth.requireJwtAdmin(request) }

  private uploadRows() {
    return this.storage.allUploadFiles().map(item => {
      const meta = this.storage.metadataForPath(item.path, item.root, item.name)
      const stat = statSync(item.path)
      const relativePath = relative(this.storage.uploadRoot, item.path).replaceAll('\\', '/')
      const first = relativePath.split('/')[0]
      const owner = first === relativePath ? undefined : this.auth.userByToken(Buffer.from(first, 'base64url').toString())?.username
      const expires = this.storage.expiresAt(item.name)
      return { path: relativePath, owner: meta?.uploader || owner || null, file_name: item.name, display_name: meta?.display_name ?? null, uploader: meta?.uploader ?? null, source: meta?.source ?? null, size_bytes: stat.size, created_at: Math.floor(stat.birthtimeMs / 1000), expires_at: expires ? Math.floor(expires / 1000) : null, expired: !!expires && expires <= Date.now(), content_type: this.storage.contentType(meta?.display_name ?? item.name), password_salt: meta?.password_salt ?? meta?.passwordSalt ?? null }
    }).sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))
  }

  private users() {
    const uploads = this.uploadRows()
    return this.db.query('SELECT id,username,token,created_at,is_admin,suspended_at,suspended_reason FROM users ORDER BY username').map(row => {
      const owned = uploads.filter(upload => upload.owner === row.username)
      return { username: row.username, created_at: Number(row.created_at), is_admin: Number(row.is_admin) === 1, suspended_at: row.suspended_at == null ? null : Number(row.suspended_at), suspended_reason: row.suspended_reason ?? null, upload_token_preview: preview(row.token), upload_count: owned.length, disk_usage_bytes: owned.reduce((sum, upload) => sum + upload.size_bytes, 0) }
    })
  }

  @Get('dashboard') dashboard(@Req() request: Request) {
    const actor = this.actor(request); const uploads = this.uploadRows(); const users = this.users()
    this.auth.audit(actor.username, 'admin.dashboard.view', null, 'success')
    return { total_disk_usage_bytes: uploads.reduce((sum, item) => sum + item.size_bytes, 0), upload_count: uploads.length, user_count: users.length, suspended_user_count: users.filter(user => user.suspended_at != null).length, admin_count: users.filter(user => user.is_admin).length, users, recent_uploads: uploads.slice(0, 10), recent_audit: this.db.query('SELECT id,created_at,actor,action,target,status,reason FROM audit_log ORDER BY created_at DESC LIMIT 20'), failed_webhook_deliveries: this.db.query("SELECT id,webhook_id,event,status,status_code,error,created_at,delivered_at FROM webhook_deliveries WHERE status='failed' ORDER BY created_at DESC LIMIT 10"), config_status: { upload_path: this.storage.uploadRoot, max_content_length_bytes: this.config.value.maxContentLength, max_upload_dir_size_bytes: this.config.value.maxUploadDirSize ?? null, delete_expired_files_enabled: true, registration_enabled: this.auth.registrationEnabled() }, warnings: [] }
  }

  @Get('users') listUsers(@Req() request: Request) { this.actor(request); return this.users() }

  @Post('users')
  @HttpCode(200)
  createUser(@Req() request: Request, @Body() body: { username?: string; password?: string; upload_token?: string; is_admin?: boolean }) {
    const actor = this.actor(request); const created = this.auth.createUser(body.username ?? '', body.password ?? '', body.upload_token ?? '', !!body.is_admin)
    this.auth.audit(actor.username, 'admin.user.create', created.username, 'success')
    this.auth.dispatchWebhook('user.created', { username: created.username, is_admin: created.is_admin })
    return { detail: 'User created', username: created.username, upload_token: created.token }
  }

  @Post('registration-tokens')
  @HttpCode(200)
  createRegistrationToken(@Req() request: Request, @Body() body: { label?: string; ttl_seconds?: number | string | null }) {
    const actor = this.actor(request)
    const rawTtl = body.ttl_seconds
    const ttlSeconds = rawTtl == null || rawTtl === '' ? undefined : Number(rawTtl)
    if (ttlSeconds != null && (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 0)) throw apiError(400, 'Token expiration must be a non-negative number of seconds')
    const label = String(body.label ?? '').trim() || 'generated'
    const token = this.auth.createRegistrationToken(label, ttlSeconds)
    const expiresAt = this.db.get<{ expires_at: number | null }>('SELECT expires_at FROM registration_tokens WHERE token=?', [token])?.expires_at ?? null
    this.auth.audit(actor.username, 'admin.registration_token.create', label, 'success')
    return { detail: 'Registration token created', token, label, expires_at: expiresAt }
  }

  @Get('registration-tokens')
  listRegistrationTokens(@Req() request: Request) {
    this.actor(request)
    const now = nowSeconds()
    const rows = this.db.query<{ token: string; label: string | null; created_at: number; expires_at: number | null; revoked_at: number | null }>('SELECT token,label,created_at,expires_at,revoked_at FROM registration_tokens ORDER BY created_at DESC')
    const tokens = rows.map(row => {
      const usedBy = this.auth.userByToken(row.token)
      const status = row.revoked_at != null
        ? 'revoked'
        : usedBy
          ? 'used'
          : row.expires_at != null && row.expires_at <= now
            ? 'expired'
            : 'available'
      return {
        token_ref: createHash('sha256').update(row.token).digest('hex'),
        label: row.label || 'generated',
        created_at: Number(row.created_at),
        expires_at: row.expires_at == null ? null : Number(row.expires_at),
        revoked_at: row.revoked_at == null ? null : Number(row.revoked_at),
        status,
        used_by: usedBy?.username ?? null,
        used_at: usedBy?.created_at ?? null,
      }
    }).sort((left, right) => {
      const rank = { available: 0, used: 1, expired: 2, revoked: 3 } as Record<string, number>
      return (rank[left.status] - rank[right.status]) || (right.created_at - left.created_at)
    })
    return tokens
  }

  @Delete('registration-tokens/history')
  clearRegistrationTokenHistory(@Req() request: Request) {
    const actor = this.actor(request)
    const result = this.db.run('DELETE FROM registration_tokens WHERE revoked_at IS NOT NULL OR (expires_at IS NOT NULL AND expires_at <= ?) OR EXISTS (SELECT 1 FROM users WHERE users.token = registration_tokens.token)', [nowSeconds()])
    const removed = Number(result.changes ?? 0)
    this.auth.audit(actor.username, 'admin.registration_token.history.clear', String(removed), 'success')
    return { detail: 'Registration token history cleared', removed }
  }

  @Delete('registration-tokens/:tokenRef')
  revokeRegistrationToken(@Req() request: Request, @Param('tokenRef') tokenRef: string) {
    const actor = this.actor(request)
    const row = this.db.query<{ token: string; expires_at: number | null; revoked_at: number | null }>('SELECT token,expires_at,revoked_at FROM registration_tokens').find(item => createHash('sha256').update(item.token).digest('hex') === tokenRef)
    if (!row) throw apiError(404, 'Registration token not found')
    if (row.revoked_at != null || (row.expires_at != null && row.expires_at <= nowSeconds()) || this.auth.userByToken(row.token)) throw apiError(409, 'Registration token is no longer active')
    this.auth.revokeToken(row.token)
    this.auth.audit(actor.username, 'admin.registration_token.revoke', tokenRef, 'success')
    return { detail: 'Registration token revoked' }
  }

  @Patch('users/:username') updateUser(@Req() request: Request, @Param('username') username: string, @Body() body: { suspended?: boolean; suspension_reason?: string; is_admin?: boolean }) { const actor = this.actor(request); const result = this.auth.updateUser(username, body, actor); this.auth.audit(actor.username, 'admin.user.update', username, 'success'); return result }

  @Post('users/:username/token')
  @HttpCode(200)
  rotateToken(@Req() request: Request, @Param('username') username: string, @Body() body: { token?: string }) { const actor = this.actor(request); const token = this.auth.rotateUserToken(username, body.token ?? ''); this.auth.audit(actor.username, 'admin.user.token.rotate', username, 'success'); return { detail: 'Token rotated', upload_token: token } }

  @Delete('users/:username') deleteUser(@Req() request: Request, @Param('username') username: string, @Body() body: { confirmation?: string }) {
    const actor = this.actor(request); if (body.confirmation?.trim() !== CONFIRM_DELETE_USER) throw apiError(400, 'Confirmation text mismatch')
    const normalized = username.trim().toLowerCase(); if (normalized === actor.username) throw apiError(400, 'You cannot modify your own account')
    const target = this.auth.userByName(normalized); if (!target) throw apiError(404, 'User not found')
    if (target.is_admin && Number(this.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM users WHERE is_admin=1')?.count ?? 0) <= 1) throw apiError(400, 'Cannot delete the last administrator')
    const owned = this.uploadRows().filter(row => row.owner === normalized); for (const row of owned) this.deleteRelative(row.path)
    this.db.run('DELETE FROM users WHERE username=?', [normalized]); this.db.run('INSERT OR REPLACE INTO revoked_tokens (token,revoked_at) VALUES (?,?)', [target.token, nowSeconds()]); this.auth.audit(actor.username, 'admin.user.delete', normalized, 'success'); this.auth.dispatchWebhook('user.deleted', { username: normalized })
    return { detail: 'User deleted' }
  }

  @Post('users/:username/purge')
  @HttpCode(200)
  purgeUser(@Req() request: Request, @Param('username') username: string, @Body() body: { confirmation?: string }) {
    const actor = this.actor(request); if (body.confirmation?.trim() !== CONFIRM_PURGE_UPLOADS) throw apiError(400, 'Confirmation text mismatch')
    const rows = this.uploadRows().filter(row => row.owner === username.trim().toLowerCase()); let bytes = 0; for (const row of rows) { bytes += row.size_bytes; this.deleteRelative(row.path) }
    this.auth.audit(actor.username, 'admin.uploads.purge_user', username, 'success'); return { detail: 'User uploads purged', bytes_removed: bytes }
  }

  @Get('users/:username/uploads') userUploads(@Req() request: Request, @Param('username') username: string) { this.actor(request); return this.uploadRows().filter(row => row.owner === username.trim().toLowerCase()) }
  @Get('uploads') uploads(@Req() request: Request) { this.actor(request); return this.uploadRows() }

  private deleteRelative(path: string) { const file = this.storage.resolveAdminPath(path); if (!existsSync(file) || !statSync(file).isFile()) return 0; const size = statSync(file).size; unlinkSync(file); return size }

  @Get('uploads/content') uploadContent(@Req() request: Request, @Res() response: Response, @Query('path') path?: string) { this.actor(request); if (!path) throw apiError(400, 'path is required'); const file = this.storage.resolveAdminPath(path); if (!existsSync(file) || !statSync(file).isFile()) throw apiError(404, 'File not found'); return response.sendFile(file) }
  @Delete('uploads') deleteUpload(@Req() request: Request, @Query('path') path?: string) { const actor = this.actor(request); if (!path) throw apiError(400, 'path is required'); const bytes = this.deleteRelative(path); if (!bytes) throw apiError(404, 'File not found'); this.auth.audit(actor.username, 'admin.upload.delete', path, 'success'); return { detail: 'Upload deleted', bytes_removed: bytes } }

  @Post('uploads/bulk-delete')
  @HttpCode(200)
  bulkDelete(@Req() request: Request, @Body() body: { paths?: string[]; confirmation?: string }) { const actor = this.actor(request); if (body.confirmation?.trim() !== CONFIRM_PURGE_UPLOADS) throw apiError(400, 'Confirmation text mismatch'); let deleted = 0; let bytes = 0; const errors: any[] = []; for (const path of body.paths ?? []) try { const size = this.deleteRelative(path); if (!size) throw new Error('File not found'); deleted++; bytes += size } catch (error) { errors.push({ path, error: String(error) }) } this.auth.audit(actor.username, 'admin.uploads.bulk_delete', null, 'success'); return { deleted, bytes_removed: bytes, errors } }
  @Post('uploads/purge-expired')
  @HttpCode(200)
  purgeExpired(@Req() request: Request, @Body() body: { confirmation?: string }) { const actor = this.actor(request); if (body.confirmation?.trim() !== CONFIRM_PURGE_EXPIRED) throw apiError(400, 'Confirmation text mismatch'); let deleted = 0; let bytes = 0; for (const row of this.uploadRows()) if (row.expired) { bytes += row.size_bytes; if (this.deleteRelative(row.path)) deleted++ } this.auth.audit(actor.username, 'admin.uploads.purge_expired', null, 'success'); return { deleted, bytes_removed: bytes } }

  private safeSettings() { const settings = this.auth.settings(); const configured = !!settings.turnstile_secret_key?.trim(); delete settings.turnstile_secret_key; settings.turnstile_secret_configured = String(configured); return settings }
  @Get('settings') settings(@Req() request: Request) { this.actor(request); return this.safeSettings() }
  @Put('settings') updateSettings(@Req() request: Request, @Body() body: Record<string, any>) { const actor = this.actor(request); const allowed = ['app_name', 'public_title', 'base_api_url', 'registration_enabled', 'file_size_limit_bytes', 'file_size_limit_unlimited', 'upload_access_mode', 'passkeys_enabled', 'turnstile_enabled', 'turnstile_site_key', 'turnstile_secret_key']; const now = nowSeconds(); for (const key of allowed) if (body[key] !== undefined) { let value = body[key]; if (typeof value === 'boolean') value = value ? 'true' : 'false'; if (key === 'passkeys_enabled' && !['true', 'false'].includes(String(value))) throw apiError(400, 'passkeys_enabled must be a boolean'); if (key === 'upload_access_mode' && !['private', 'public'].includes(value)) throw apiError(400, 'Invalid upload access mode'); if (key === 'base_api_url' && value && !/^https?:\/\/[^\s:@]+(?:\/[^\s]*)?$/i.test(String(value))) throw apiError(400, 'Base API URL must be http(s) without credentials'); this.db.run('INSERT INTO admin_settings (key,value,updated_at,updated_by) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at,updated_by=excluded.updated_by', [key, String(value), now, actor.username]) } if (body.passkeys_enabled !== undefined && String(body.passkeys_enabled).toLowerCase() === 'false') this.auth.invalidatePasskeyCeremonies(); this.auth.audit(actor.username, 'admin.settings.update', null, 'success'); this.auth.dispatchWebhook('admin.settings.updated', { actor: actor.username, keys: allowed.filter(key => body[key] !== undefined) }); return this.safeSettings() }

  @Get('webhooks') listWebhooks(@Req() request: Request) { this.actor(request); return this.db.query('SELECT id,url,events,enabled,secret_preview,created_at,updated_at,updated_by FROM webhooks ORDER BY id').map(row => ({ ...row, events: String(row.events).split(',').filter(Boolean), enabled: Number(row.enabled) === 1, secret_configured: !!row.secret_preview })) }
  @Post('webhooks')
  @HttpCode(200)
  createWebhook(@Req() request: Request, @Body() body: { url?: string; events?: string[]; secret?: string; enabled?: boolean }) { const actor = this.actor(request); const url = webhookUrl(body.url ?? ''); const list = events(body.events); if (!list.length) throw apiError(400, 'At least one webhook event is required'); const now = nowSeconds(); const result: any = this.db.run('INSERT INTO webhooks (url,events,secret_hash,secret_preview,enabled,created_at,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?)', [url, list.join(','), body.secret?.trim() ? hashSync(body.secret.trim(), 12) : null, body.secret?.trim() ? preview(body.secret.trim()) : null, body.enabled === false ? 0 : 1, now, now, actor.username]); this.auth.audit(actor.username, 'admin.webhook.create', url, 'success'); return { detail: 'Webhook created', id: Number(result.lastInsertRowid) } }
  @Patch('webhooks/:id') updateWebhook(@Req() request: Request, @Param('id') id: string, @Body() body: { url?: string; events?: string[]; secret?: string; enabled?: boolean }) { const actor = this.actor(request); const current = this.db.get('SELECT * FROM webhooks WHERE id=?', [Number(id)]); if (!current) throw apiError(404, 'Webhook not found'); if (body.url !== undefined) this.db.run('UPDATE webhooks SET url=? WHERE id=?', [webhookUrl(body.url), Number(id)]); if (body.events !== undefined) this.db.run('UPDATE webhooks SET events=? WHERE id=?', [events(body.events).join(','), Number(id)]); if (body.enabled !== undefined) this.db.run('UPDATE webhooks SET enabled=? WHERE id=?', [body.enabled ? 1 : 0, Number(id)]); if (body.secret !== undefined) this.db.run('UPDATE webhooks SET secret_hash=?,secret_preview=? WHERE id=?', [body.secret.trim() ? hashSync(body.secret.trim(), 12) : null, body.secret.trim() ? preview(body.secret.trim()) : null, Number(id)]); this.db.run('UPDATE webhooks SET updated_at=?,updated_by=? WHERE id=?', [nowSeconds(), actor.username, Number(id)]); return { detail: 'Webhook updated' } }
  @Delete('webhooks/:id') deleteWebhook(@Req() request: Request, @Param('id') id: string) { const actor = this.actor(request); const result: any = this.db.run('DELETE FROM webhooks WHERE id=?', [Number(id)]); if (!result.changes) throw apiError(404, 'Webhook not found'); this.auth.audit(actor.username, 'admin.webhook.delete', id, 'success'); return { detail: 'Webhook deleted' } }
  @Post('webhooks/:id/test')
  @HttpCode(200)
  testWebhook(@Req() request: Request, @Param('id') id: string) { const actor = this.actor(request); const hook = this.db.get('SELECT id FROM webhooks WHERE id=?', [Number(id)]); if (!hook) throw apiError(404, 'Webhook not found'); this.auth.dispatchWebhook('admin.webhook.test', { webhook_id: Number(id), actor: actor.username }); this.auth.audit(actor.username, 'admin.webhook.test', id, 'success'); return { detail: 'Webhook test queued' } }
  @Get('webhooks/deliveries') deliveries(@Req() request: Request) { this.actor(request); return this.db.query('SELECT id,webhook_id,event,status,status_code,error,created_at,delivered_at FROM webhook_deliveries ORDER BY created_at DESC LIMIT 100') }
  @Get('audit') audit(@Req() request: Request) { this.actor(request); return this.db.query('SELECT id,created_at,actor,action,target,status,reason FROM audit_log ORDER BY created_at DESC LIMIT 200') }
}
