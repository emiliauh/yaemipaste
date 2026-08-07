import { Injectable } from '@nestjs/common'
import { compareSync, hashSync } from 'bcryptjs'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import jwt, { type JwtPayload } from 'jsonwebtoken'
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server'
import { apiError } from './errors.js'
import { ConfigService } from './config.service.js'
import { DatabaseService, nowSeconds } from './database.service.js'
import { requestPinnedHttp } from './safe-http.js'

export type AuthUser = {
  id: number
  username: string
  token: string
  is_admin: boolean
  suspended_at: number | null
  suspended_reason: string | null
  created_at: number
  session_revoked_at: number | null
  session_version: number
}

function normalized(value: unknown): string { return String(value ?? '').trim().toLowerCase() }
export function isInstallerSecret(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value) && !/^([a-f0-9])\1{63}$/.test(value)
}
@Injectable()
export class AuthService {
  readonly jwtSecret: string
  readonly jwtTtlSeconds: number
  private readonly rateLimits = new Map<string, { count: number; resetAt: number }>()

  constructor(private readonly db: DatabaseService, private readonly config: ConfigService) {
    this.jwtSecret = process.env.JWT_SECRET || 'change-me-in-production'
    if (process.env.NODE_ENV === 'production') {
      if (!isInstallerSecret(this.jwtSecret)) throw new Error('JWT_SECRET must be a non-degenerate 64-character lowercase hex secret in production')
      const adminBearers = (process.env.AUTH_ADMIN_BEARER || '').split(',').map(value => value.trim()).filter(Boolean)
      if (!adminBearers.length || adminBearers.some(value => !isInstallerSecret(value))) throw new Error('every AUTH_ADMIN_BEARER value must be a non-degenerate 64-character lowercase hex secret in production')
    }
    this.jwtTtlSeconds = Math.max(1, Number(process.env.JWT_TTL_SECONDS || 60 * 60 * 24 * 30))
  }

  rateLimit(key: string, maximum: number, windowMs: number): boolean {
    const now = Date.now()
    const previous = this.rateLimits.get(key)
    if (!previous || previous.resetAt <= now) {
      this.rateLimits.set(key, { count: 1, resetAt: now + windowMs })
      return true
    }
    if (previous.count >= maximum) return false
    previous.count++
    return true
  }

  private configuredTokens(kind: 'auth' | 'delete' = 'auth'): Set<string> {
    const values = new Set<string>()
    const keys = kind === 'auth' ? ['TOKEN', 'AUTH_TOKEN'] : ['TOKEN', 'DELETE_TOKEN']
    for (const key of keys) {
      const value = process.env[key]?.trim()
      if (value) values.add(value)
    }
    for (const key of kind === 'auth' ? ['TOKENS_FILE', 'AUTH_TOKENS_FILE'] : ['TOKENS_FILE', 'DELETE_TOKENS_FILE']) {
      const path = process.env[key]
      if (!path) continue
      try { for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) if (line.trim()) values.add(line.trim()) } catch { /* fail closed */ }
    }
    for (const token of (kind === 'auth' ? this.config.value.authTokens : this.config.value.deleteTokens) ?? []) values.add(token)
    return values
  }

  private rowToUser(row: any): AuthUser {
    return {
      id: Number(row.id), username: row.username, token: row.token, is_admin: Number(row.is_admin) === 1,
      suspended_at: row.suspended_at == null ? null : Number(row.suspended_at),
      suspended_reason: row.suspended_reason ?? null, created_at: Number(row.created_at),
      session_revoked_at: row.session_revoked_at == null ? null : Number(row.session_revoked_at),
      session_version: Number(row.session_version ?? 0),
    }
  }

  userByName(username: string): AuthUser | undefined {
    const row = this.db.get('SELECT id, username, token, created_at, is_admin, suspended_at, suspended_reason, session_revoked_at, session_version FROM users WHERE username=? LIMIT 1', [normalized(username)])
    return row ? this.rowToUser(row) : undefined
  }

  userByToken(token: string): AuthUser | undefined {
    const row = this.db.get('SELECT id, username, token, created_at, is_admin, suspended_at, suspended_reason, session_revoked_at, session_version FROM users WHERE token=? LIMIT 1', [token])
    return row ? this.rowToUser(row) : undefined
  }

  isRevoked(token: string): boolean { return !!this.db.get('SELECT 1 FROM revoked_tokens WHERE token=? LIMIT 1', [token]) }

  isValidPasteToken(token: string): boolean {
    if (!token.trim()) return false
    const user = this.userByToken(token)
    if (user) return !user.suspended_at
    if (this.isRevoked(token)) return false
    const configured = this.configuredTokens('auth')
    return configured.size > 0 && configured.has(token)
  }

  tokenForRequest(request: { headers: Record<string, any> }): string | undefined {
    const value = request.headers.authorization
    if (typeof value !== 'string' || !value.trim()) return undefined
    return value.trim().split(/\s+/).pop() || undefined
  }

  bearerForRequest(request: { headers: Record<string, any> }): string | undefined {
    const value = request.headers.authorization
    return typeof value === 'string' && value.startsWith('Bearer ') ? value.slice(7).trim() || undefined : undefined
  }

  uploadToken(request: { headers: Record<string, any> }): string | undefined {
    const token = this.tokenForRequest(request)
    return token && this.isValidPasteToken(token) ? token : undefined
  }

  deleteToken(request: { headers: Record<string, any> }): string | undefined {
    const token = this.tokenForRequest(request)
    if (!token) return undefined
    if (this.userByToken(token)) return token
    if (this.isRevoked(token)) return undefined
    const configured = this.configuredTokens('delete')
    return configured.has(token) ? token : undefined
  }

  requireUploadAccess(request: { headers: Record<string, any> }) {
    const token = this.uploadToken(request)
    if (!token && !this.isAnonymousUploadsEnabled()) throw apiError(401, 'Unauthorized')
    return token
  }

  isAnonymousUploadsEnabled(): boolean {
    const value = this.settings().upload_access_mode
    return value === 'public'
  }

  uploadOwner(request: { headers: Record<string, any> }): string {
    const token = this.uploadToken(request)
    return token ? this.userByToken(token)?.username ?? 'Unknown (token user)' : 'Anonymous'
  }

  tokenDirectory(token: string): string {
    return Buffer.from(token).toString('base64url')
  }

  createJwt(username: string): string {
    const version = Number(this.db.get<{ session_version: number }>('SELECT session_version FROM users WHERE username=?', [normalized(username)])?.session_version ?? 0)
    return jwt.sign({ sub: username, session_version: version }, this.jwtSecret, { algorithm: 'HS256', expiresIn: this.jwtTtlSeconds })
  }

  currentUser(request: { headers: Record<string, any> }): AuthUser {
    const token = this.bearerForRequest(request)
    if (!token) throw apiError(401, 'Invalid token')
    let payload: JwtPayload
    try { payload = jwt.verify(token, this.jwtSecret, { algorithms: ['HS256'] }) as JwtPayload } catch (error: any) { throw apiError(401, error?.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token') }
    const username = typeof payload.sub === 'string' ? payload.sub : ''
    const user = this.userByName(username)
    if (!user) throw apiError(404, 'User not found')
    if (user.suspended_at) throw apiError(403, 'Account is suspended')
    if (Number(payload.session_version ?? 0) !== user.session_version) throw apiError(401, 'Session revoked')
    return user
  }

  requireAdminBearer(request: { headers: Record<string, any> }) {
    const allowed = (process.env.AUTH_ADMIN_BEARER || '').split(',').map(value => value.trim()).filter(Boolean)
    if (!allowed.length) throw apiError(403, 'Admin operations are disabled')
    const token = this.bearerForRequest(request)
    if (!token) throw apiError(401, 'Missing admin token')
    if (!allowed.includes(token)) throw apiError(401, 'Invalid admin token')
  }

  requireJwtAdmin(request: { headers: Record<string, any> }): AuthUser {
    const user = this.currentUser(request)
    if (!user.is_admin) throw apiError(403, 'Administrator access required')
    return user
  }

  settings(): Record<string, string> {
    const rows = this.db.query<{ key: string; value: string }>('SELECT key,value FROM admin_settings')
    return Object.fromEntries(rows.map(row => [row.key, row.value]))
  }

  audit(actor: string | null, action: string, target: string | null, status: string, reason: string | null = null) {
    this.db.run('INSERT INTO audit_log (created_at,actor,action,target,status,reason) VALUES (?,?,?,?,?,?)', [nowSeconds(), actor, action, target, status, reason])
  }

  registrationEnabled() { return this.settings().registration_enabled !== 'false' }
  fileSizeLimit(): number | undefined {
    const settings = this.settings()
    if (settings.file_size_limit_unlimited === 'true') return undefined
    const value = Number(settings.file_size_limit_bytes || 0)
    return value > 0 ? value : undefined
  }

  tokenStatus(token: string): 'available' | 'used' | 'invalid' {
    if (this.userByToken(token)) return 'used'
    if (this.isRevoked(token)) return 'invalid'
    const configured = this.configuredTokens('auth')
    if (configured.size && !configured.has(token)) return 'invalid'
    const registration = this.db.get<{ expires_at: number | null; revoked_at: number | null }>('SELECT expires_at,revoked_at FROM registration_tokens WHERE token=?', [token])
    if (registration && (registration.revoked_at != null || (registration.expires_at != null && registration.expires_at <= nowSeconds()))) return 'invalid'
    return 'available'
  }

  private randomToken() { return randomBytes(36).toString('base64url') }

  register(usernameValue: string, password: string, token: string) {
    const username = normalized(usernameValue)
    if (username.length < 2) throw apiError(400, 'Username too short')
    if (password.length < 6) throw apiError(400, 'Password must be at least 6 characters')
    if (!token.trim()) throw apiError(400, 'Token is required')
    if (!this.registrationEnabled()) throw apiError(403, 'Registration is disabled')
    if (this.tokenStatus(token.trim()) !== 'available') throw apiError(400, 'Invalid or unrecognised token')
    try {
      this.db.run('INSERT INTO users (username,password,token,created_at) VALUES (?,?,?,?)', [username, hashSync(password, 10), token.trim(), nowSeconds()])
    } catch (error: any) {
      const message = String(error?.message ?? '')
      if (message.includes('username')) throw apiError(400, 'Username already taken')
      if (message.includes('token')) throw apiError(400, 'Token already used')
      throw apiError(500, 'Could not create account')
    }
    return { detail: 'Account created' }
  }

  async login(usernameValue: string, password: string, turnstileToken = '') {
    const settings = this.settings()
    const turnstileEnabled = settings.turnstile_enabled === 'true'
    const turnstileSecret = settings.turnstile_secret_key?.trim() || process.env.TURNSTILE_SECRET_KEY?.trim() || ''
    if (turnstileEnabled && (!turnstileSecret || !(await this.verifyTurnstile(turnstileSecret, turnstileToken)))) throw apiError(400, 'Security check failed')
    const username = normalized(usernameValue)
    const row = this.db.get('SELECT username,password,token,is_admin,suspended_at FROM users WHERE username=?', [username])
    if (!row || !compareSync(password, row.password)) throw apiError(401, 'Invalid credentials')
    if (row.suspended_at != null) throw apiError(403, 'Account is suspended')
    if (!this.isValidPasteToken(row.token)) throw apiError(401, 'Invalid credentials')
    if (Number(row.is_admin) === 1) this.audit(row.username, 'admin.login', null, 'success')
    return { access_token: this.createJwt(row.username), paste_token: row.token, username: row.username, is_admin: Number(row.is_admin) === 1 }
  }

  private async verifyTurnstile(secret: string, token: string): Promise<boolean> {
    if (!token.trim()) return false
    try {
      const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ secret, response: token }), signal: AbortSignal.timeout(5_000),
      })
      if (!response.ok) return false
      const result = await response.json() as { success?: boolean }
      return result.success === true
    } catch { return false }
  }

  createRegistrationToken(label = 'generated', ttlSeconds?: number) {
    const token = this.randomToken()
    const expires = ttlSeconds && ttlSeconds > 0 ? nowSeconds() + ttlSeconds : null
    this.db.run('INSERT OR REPLACE INTO registration_tokens (token,label,created_at,expires_at,revoked_at) VALUES (?,?,?,?,NULL)', [token, label.trim() || 'generated', nowSeconds(), expires])
    return token
  }

  revokeToken(token: string) {
    if (!token.trim()) throw apiError(400, 'Token is required')
    this.db.run('INSERT OR REPLACE INTO revoked_tokens (token,revoked_at) VALUES (?,?)', [token, nowSeconds()])
    this.db.run('UPDATE registration_tokens SET revoked_at=? WHERE token=?', [nowSeconds(), token])
    return { detail: 'Token revoked' }
  }

  bootstrap(username: string, password: string, requestedToken = '') {
    const configured = this.configuredTokens('auth')
    let token = requestedToken.trim()
    if (token) {
      if (this.tokenStatus(token) !== 'available') throw apiError(400, 'Token is not available')
    } else if (configured.size) {
      token = [...configured].sort().find(value => this.tokenStatus(value) === 'available') ?? ''
      if (!token) throw apiError(409, 'No available configured tokens left')
    } else token = this.createRegistrationToken('bootstrap')
    const created = this.createUser(username, password, token, false)
    return { detail: 'Initial user created', token: created.token }
  }

  adminExists() { return !!this.db.get('SELECT 1 FROM users WHERE is_admin=1 LIMIT 1') }
  pendingClaimExists() { return !!this.db.get('SELECT 1 FROM admin_claims WHERE used_at IS NULL AND (expires_at IS NULL OR expires_at>?) LIMIT 1', [nowSeconds()]) }

  createUser(usernameValue: string, password: string, requestedToken = '', isAdmin = false) {
    const username = normalized(usernameValue)
    if (username.length < 2) throw apiError(400, 'Username too short')
    if (password.length < 6) throw apiError(400, 'Password must be at least 6 characters')
    let token = requestedToken.trim()
    if (!token) token = this.createRegistrationToken('user')
    if (this.tokenStatus(token) !== 'available') throw apiError(400, 'Upload token is not available')
    try { this.db.run('INSERT INTO users (username,password,token,created_at,is_admin) VALUES (?,?,?,?,?)', [username, hashSync(password, 10), token, nowSeconds(), isAdmin ? 1 : 0]) } catch (error: any) {
      const message = String(error?.message ?? '')
      if (message.includes('username')) throw apiError(400, 'Username already taken')
      if (message.includes('token')) throw apiError(400, 'Token already used')
      throw apiError(500, 'Could not create user')
    }
    return { username, token, is_admin: isAdmin }
  }

  rotateUserToken(usernameValue: string, requestedToken = '') {
    const username = normalized(usernameValue)
    const user = this.userByName(username)
    if (!user) throw apiError(404, 'User not found')
    let token = requestedToken.trim()
    if (!token) token = this.createRegistrationToken('rotated')
    if (this.tokenStatus(token) !== 'available') throw apiError(400, 'Upload token is not available')
    this.db.run('UPDATE users SET token=? WHERE username=?', [token, username])
    this.db.run('INSERT OR REPLACE INTO revoked_tokens (token,revoked_at) VALUES (?,?)', [user.token, nowSeconds()])
    return token
  }

  updateUser(usernameValue: string, updates: { suspended?: boolean; suspension_reason?: string; is_admin?: boolean }, actor: AuthUser) {
    const username = normalized(usernameValue)
    if (username === actor.username) throw apiError(400, 'You cannot modify your own account')
    const target = this.userByName(username)
    if (!target) throw apiError(404, 'User not found')
    if (updates.suspended != null) this.db.run('UPDATE users SET suspended_at=?,suspended_reason=? WHERE username=?', [updates.suspended ? nowSeconds() : null, updates.suspended ? (updates.suspension_reason?.trim() || 'Suspended by administrator') : null, username])
    if (updates.is_admin != null) {
      if (target.is_admin && !updates.is_admin && Number(this.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM users WHERE is_admin=1')?.count ?? 0) <= 1) throw apiError(400, 'Cannot remove the last administrator')
      this.db.run('UPDATE users SET is_admin=? WHERE username=?', [updates.is_admin ? 1 : 0, username])
    }
    return { detail: 'User updated' }
  }

  userData(user: AuthUser) { return { username: user.username, created_at: user.created_at, is_admin: user.is_admin, suspended_at: user.suspended_at, suspended_reason: user.suspended_reason } }

  changePassword(request: { headers: Record<string, any> }, oldPassword: string, newPassword: string) {
    if (newPassword.length < 6) throw apiError(400, 'Password must be at least 6 characters')
    const user = this.currentUser(request)
    const row = this.db.get<{ password: string }>('SELECT password FROM users WHERE id=?', [user.id])
    if (!row || !compareSync(oldPassword, row.password)) throw apiError(400, 'Current password is incorrect')
    this.db.run('UPDATE users SET password=? WHERE id=?', [hashSync(newPassword, 10), user.id])
    this.db.run('UPDATE users SET session_revoked_at=?,session_version=session_version+1 WHERE id=?', [nowSeconds(), user.id])
    this.audit(user.username, 'account.password_changed', user.username, 'success')
    return { detail: 'Password changed' }
  }

  logoutAllDevices(request: { headers: Record<string, any> }) {
    const user = this.currentUser(request)
    this.db.run('UPDATE users SET session_revoked_at=?,session_version=session_version+1 WHERE id=?', [nowSeconds(), user.id])
    this.audit(user.username, 'account.logout_all_devices', user.username, 'success')
    return { detail: 'Logged out of all devices' }
  }

  dispatchWebhook(event: string, payload: Record<string, unknown>) {
    void (async () => {
      const hooks = this.db.query<{ id: number; url: string; events: string }>('SELECT id,url,events FROM webhooks WHERE enabled=1')
      const createdAt = nowSeconds()
      for (const hook of hooks) {
        const subscribed = hook.events.split(',').map(value => value.trim()).includes(event)
        if (event !== 'admin.webhook.test' && !subscribed) continue
        const body = JSON.stringify({ event, created_at: createdAt, payload })
        const delivery = this.db.run('INSERT INTO webhook_deliveries (webhook_id,event,payload,status,created_at) VALUES (?,?,?,?,?)', [hook.id, event, body, 'pending', createdAt])
        let statusCode: number | null = null
        let error = ''
        try {
          let current = new URL(hook.url)
          let response: Awaited<ReturnType<typeof requestPinnedHttp>> | undefined
          for (let attempt = 0; attempt < 5; attempt++) {
            response = await requestPinnedHttp(current, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) }, body, timeoutMs: 5_000 })
            const status = response.statusCode ?? 0
            if (status < 300 || status >= 400) break
            const locationHeader = response.headers.location
            const location = Array.isArray(locationHeader) ? locationHeader[0] : locationHeader
            response.resume()
            if (!location) throw new Error('webhook redirect is invalid')
            current = new URL(location, current)
          }
          if (!response) throw new Error('webhook request failed')
          statusCode = response.statusCode ?? null
          if (statusCode == null || statusCode < 200 || statusCode >= 300) error = `HTTP ${statusCode ?? 0}`
          response.resume()
        } catch (cause) { error = String(cause instanceof Error ? cause.message : cause) }
        this.db.run('UPDATE webhook_deliveries SET status=?,status_code=?,error=?,delivered_at=? WHERE id=?', [error ? 'failed' : 'delivered', statusCode, error || null, nowSeconds(), Number(delivery.lastInsertRowid)])
      }
    })().catch(() => { /* webhook delivery is best-effort and is recorded when possible */ })
  }

  passkeysEnabled() {
    const setting = this.settings().passkeys_enabled
    return setting === undefined ? this.config.value.passkeysEnabled : setting !== 'false'
  }

  private requirePasskeysEnabled() {
    if (!this.passkeysEnabled()) throw apiError(400, 'Passkeys are disabled')
  }

  private passkeySettings() {
    const origins = this.config.value.passkeyOrigins.length ? this.config.value.passkeyOrigins : [this.config.value.publicUrl, 'http://localhost:5173', 'http://127.0.0.1:5173']
    const first = new URL(origins[0])
    return { origins, rpId: this.config.value.passkeyRpId || first.hostname, allowAnyPort: this.config.value.passkeyAllowAnyPort, allowSubdomains: this.config.value.passkeyAllowSubdomains }
  }

  private originAllowed(origin: string, settings: { origins: string[]; allowAnyPort: boolean; allowSubdomains: boolean }): boolean {
    let actual: URL
    try { actual = new URL(origin) } catch { return false }
    return settings.origins.some(value => {
      try {
        const expected = new URL(value)
        const hostMatches = actual.hostname === expected.hostname || (settings.allowSubdomains && actual.hostname.endsWith(`.${expected.hostname}`))
        const portMatches = settings.allowAnyPort || actual.port === expected.port
        return actual.protocol === expected.protocol && hostMatches && portMatches && actual.pathname === expected.pathname
      } catch { return false }
    })
  }

  private ceremonyOrigin(response: any, settings: { origins: string[]; allowAnyPort: boolean; allowSubdomains: boolean }): string {
    try {
      const clientData = JSON.parse(Buffer.from(String(response?.response?.clientDataJSON ?? ''), 'base64url').toString('utf8')) as { origin?: string }
      if (typeof clientData.origin === 'string' && this.originAllowed(clientData.origin, settings)) return clientData.origin
    } catch { /* the verifier will return a generic failure for malformed ceremony data */ }
    throw apiError(400, 'Passkey origin is not allowed')
  }

  passkeyList(request: { headers: Record<string, any> }) {
    this.requirePasskeysEnabled()
    const user = this.currentUser(request)
    return this.db.query('SELECT id,credential_id,created_at,last_used_at,transports FROM passkeys WHERE user_id=? ORDER BY created_at DESC', [user.id]).map(row => ({ ...row, transports: row.transports ? String(row.transports).split(',').filter(Boolean) : [] }))
  }

  passkeyRegisterBegin(request: { headers: Record<string, any> }) {
    this.requirePasskeysEnabled(); const user = this.currentUser(request); const { origins, rpId } = this.passkeySettings()
    const existing = this.db.query<{ credential_id: string; transports: string | null }>('SELECT credential_id,transports FROM passkeys WHERE user_id=?', [user.id])
    return generateRegistrationOptions({ rpName: this.config.value.passkeyRpName, rpID: rpId, userName: user.username, userID: Buffer.from(String(user.id)), userDisplayName: user.username, attestationType: 'none', excludeCredentials: existing.map(row => ({ id: row.credential_id, transports: row.transports ? row.transports.split(',') as any : undefined })) }).then(options => {
      this.db.run('UPDATE users SET passkey_reg_state=? WHERE id=?', [JSON.stringify({ challenge: options.challenge, origins, rpId, allowAnyPort: this.config.value.passkeyAllowAnyPort, allowSubdomains: this.config.value.passkeyAllowSubdomains }), user.id])
      return options
    })
  }

  async passkeyRegisterFinish(request: { headers: Record<string, any> }, credential: unknown) {
    this.requirePasskeysEnabled(); const user = this.currentUser(request)
    const state = this.db.get<{ passkey_reg_state: string | null }>('SELECT passkey_reg_state FROM users WHERE id=?', [user.id])?.passkey_reg_state
    if (!state || !credential || typeof credential !== 'object') throw apiError(400, 'No passkey registration is pending')
    const ceremony = JSON.parse(state) as { challenge: string; origins: string[]; rpId: string; allowAnyPort?: boolean; allowSubdomains?: boolean }
    const expectedOrigin = this.ceremonyOrigin(credential, { origins: ceremony.origins, allowAnyPort: ceremony.allowAnyPort ?? this.config.value.passkeyAllowAnyPort, allowSubdomains: ceremony.allowSubdomains ?? this.config.value.passkeyAllowSubdomains })
    let verification: any
    try { verification = await verifyRegistrationResponse({ response: credential as any, expectedChallenge: ceremony.challenge, expectedOrigin, expectedRPID: ceremony.rpId }) } catch { throw apiError(400, 'Could not verify passkey registration') }
    if (!verification.verified || !verification.registrationInfo) throw apiError(400, 'Could not verify passkey registration')
    const info = verification.registrationInfo
    const credentialId = String(info.credential.id)
    const publicKey = Buffer.from(info.credential.publicKey)
    const transports = Array.isArray((credential as any).response?.transports) ? (credential as any).response.transports.join(',') : null
    this.db.run('INSERT INTO passkeys (user_id,credential_id,public_key,sign_count,transports,created_at,last_used_at,passkey_data) VALUES (?,?,?,?,?,?,NULL,?)', [user.id, credentialId, publicKey, info.credential.counter, transports, nowSeconds(), JSON.stringify({ id: credentialId, publicKey: publicKey.toString('base64url'), counter: info.credential.counter, transports: transports ? transports.split(',') : [] })])
    this.db.run('UPDATE users SET passkey_reg_state=NULL WHERE id=?', [user.id])
    return { detail: 'Passkey registered' }
  }

  passkeyDelete(request: { headers: Record<string, any> }, id: number) {
    this.requirePasskeysEnabled(); const user = this.currentUser(request)
    const result: any = this.db.run('DELETE FROM passkeys WHERE id=? AND user_id=?', [id, user.id])
    if (!result.changes) throw apiError(404, 'Passkey not found')
    return { detail: 'Passkey deleted' }
  }

  async passkeyAuthBegin(usernameValue: string) {
    this.requirePasskeysEnabled(); const username = normalized(usernameValue); const user = this.userByName(username)
    if (!user) throw apiError(404, 'User not found')
    const { origins, rpId } = this.passkeySettings()
    const credentials = this.db.query<{ credential_id: string; transports: string | null }>('SELECT credential_id,transports FROM passkeys WHERE user_id=?', [user.id])
    if (!credentials.length) throw apiError(404, 'No passkeys registered')
    const options = await generateAuthenticationOptions({ rpID: rpId, allowCredentials: credentials.map(row => ({ id: row.credential_id, transports: row.transports ? row.transports.split(',') as any : undefined })), userVerification: 'preferred' })
    this.db.run('UPDATE users SET passkey_auth_state=? WHERE id=?', [JSON.stringify({ challenge: options.challenge, origins, rpId, allowAnyPort: this.config.value.passkeyAllowAnyPort, allowSubdomains: this.config.value.passkeyAllowSubdomains }), user.id])
    return options
  }

  async passkeyAuthFinish(usernameValue: string, credential: unknown) {
    this.requirePasskeysEnabled(); const username = normalized(usernameValue); const user = this.userByName(username)
    if (!user || user.suspended_at) throw apiError(401, 'Invalid passkey login')
    const state = this.db.get<{ passkey_auth_state: string | null }>('SELECT passkey_auth_state FROM users WHERE id=?', [user.id])?.passkey_auth_state
    if (!state || !credential || typeof credential !== 'object') throw apiError(400, 'No passkey authentication is pending')
    const ceremony = JSON.parse(state) as { challenge: string; origins: string[]; rpId: string; allowAnyPort?: boolean; allowSubdomains?: boolean }
    const expectedOrigin = this.ceremonyOrigin(credential, { origins: ceremony.origins, allowAnyPort: ceremony.allowAnyPort ?? this.config.value.passkeyAllowAnyPort, allowSubdomains: ceremony.allowSubdomains ?? this.config.value.passkeyAllowSubdomains })
    const credentialId = String((credential as any).id ?? '')
    const row = this.db.get<{ id: number; passkey_data: string | null; public_key: Uint8Array; sign_count: number; transports: string | null }>('SELECT id,passkey_data,public_key,sign_count,transports FROM passkeys WHERE user_id=? AND (credential_id=? OR credential_id=?)', [user.id, credentialId, Buffer.from(credentialId, 'base64url').toString('base64url')])
    if (!row) throw apiError(401, 'Unknown passkey')
    let stored: any = row.passkey_data ? JSON.parse(row.passkey_data) : { id: credentialId, publicKey: Buffer.from(row.public_key).toString('base64url'), counter: row.sign_count, transports: row.transports?.split(',') ?? [] }
    let verification: any
    try { verification = await verifyAuthenticationResponse({ response: credential as any, expectedChallenge: ceremony.challenge, expectedOrigin, expectedRPID: ceremony.rpId, credential: { id: stored.id, publicKey: new Uint8Array(Buffer.from(stored.publicKey, 'base64url')), counter: Number(stored.counter ?? row.sign_count), transports: stored.transports } as any }) } catch { throw apiError(401, 'Could not verify passkey login') }
    if (!verification.verified) throw apiError(401, 'Could not verify passkey login')
    this.db.run('UPDATE passkeys SET sign_count=?,last_used_at=? WHERE id=?', [verification.authenticationInfo.newCounter, nowSeconds(), row.id])
    this.db.run('UPDATE users SET passkey_auth_state=NULL WHERE id=?', [user.id])
    return { access_token: this.createJwt(user.username), paste_token: user.token, username: user.username, is_admin: user.is_admin }
  }
}
