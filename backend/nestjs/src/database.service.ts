import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ConfigService } from './config.service.js'

export type DbRow = Record<string, any>

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name)
  readonly db: DatabaseSync

  constructor(config: ConfigService) {
    const path = process.env.DB_PATH || '/var/lib/yaemipaste-auth/users.db'
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
    this.initialize(config.value.passkeysEnabled)
    this.logger.log(`Using SQLite database ${path}`)
  }

  private initialize(passkeysEnabledByDefault: boolean) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, token TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0, suspended_at INTEGER, suspended_reason TEXT, passkey_user_uuid TEXT, passkey_reg_state TEXT, passkey_auth_state TEXT, session_revoked_at INTEGER, session_version INTEGER NOT NULL DEFAULT 0, avatar_color TEXT, avatar_image TEXT);
      CREATE TABLE IF NOT EXISTS passkeys (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, credential_id TEXT UNIQUE NOT NULL, public_key BLOB NOT NULL, sign_count INTEGER NOT NULL DEFAULT 0, transports TEXT, created_at INTEGER NOT NULL, last_used_at INTEGER, passkey_data TEXT, name TEXT, FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS idx_passkeys_user_id ON passkeys(user_id);
      CREATE TABLE IF NOT EXISTS registration_tokens (token TEXT PRIMARY KEY, label TEXT, created_at INTEGER NOT NULL, expires_at INTEGER, revoked_at INTEGER);
      CREATE TABLE IF NOT EXISTS revoked_tokens (token TEXT PRIMARY KEY, revoked_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS admin_claims (id INTEGER PRIMARY KEY AUTOINCREMENT, token_hash TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER, used_at INTEGER);
      CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL, actor TEXT, action TEXT NOT NULL, target TEXT, status TEXT NOT NULL, reason TEXT);
      CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);
      CREATE TABLE IF NOT EXISTS admin_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT);
      CREATE TABLE IF NOT EXISTS webhooks (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL, events TEXT NOT NULL, secret_hash TEXT, secret_preview TEXT, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT);
      CREATE TABLE IF NOT EXISTS webhook_deliveries (id INTEGER PRIMARY KEY, webhook_id INTEGER, event TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, status_code INTEGER, error TEXT, created_at INTEGER NOT NULL, delivered_at INTEGER, FOREIGN KEY(webhook_id) REFERENCES webhooks(id) ON DELETE SET NULL);
      CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_created_at ON webhook_deliveries(created_at);
    `)
    const columns = this.query<{ name: string }>('PRAGMA table_info(users)')
    const existing = new Set(columns.map(row => row.name))
    for (const [name, definition] of [['is_admin', 'INTEGER NOT NULL DEFAULT 0'], ['suspended_at', 'INTEGER'], ['suspended_reason', 'TEXT'], ['passkey_user_uuid', 'TEXT'], ['passkey_reg_state', 'TEXT'], ['passkey_auth_state', 'TEXT'], ['session_revoked_at', 'INTEGER'], ['session_version', 'INTEGER NOT NULL DEFAULT 0'], ['avatar_color', 'TEXT'], ['avatar_image', 'TEXT']] as const) {
      if (!existing.has(name)) this.db.exec(`ALTER TABLE users ADD COLUMN ${name} ${definition}`)
    }
    const passkeyColumns = new Set(this.query<{ name: string }>('PRAGMA table_info(passkeys)').map(row => row.name))
    if (!passkeyColumns.has('passkey_data')) this.db.exec('ALTER TABLE passkeys ADD COLUMN passkey_data TEXT')
    if (!passkeyColumns.has('name')) this.db.exec('ALTER TABLE passkeys ADD COLUMN name TEXT')
    const now = nowSeconds()
    const access = process.env.ALLOW_ANONYMOUS_UPLOADS === '1' ? 'public' : 'private'
    const insert = this.db.prepare('INSERT OR IGNORE INTO admin_settings (key,value,updated_at,updated_by) VALUES (?,?,?,?)')
    for (const [key, value] of [['app_name', 'yaemipaste'], ['public_title', 'yaemipaste'], ['base_api_url', ''], ['registration_enabled', 'true'], ['file_size_limit_bytes', '0'], ['file_size_limit_unlimited', 'false'], ['upload_access_mode', access], ['passkeys_enabled', passkeysEnabledByDefault ? 'true' : 'false']]) insert.run(key, value, now, 'system')
  }

  query<T extends DbRow = DbRow>(sql: string, params: any[] = []): T[] {
    return this.db.prepare(sql).all(...params) as T[]
  }

  get<T extends DbRow = DbRow>(sql: string, params: any[] = []): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined
  }

  run(sql: string, params: any[] = []): any {
    return this.db.prepare(sql).run(...params)
  }

  onModuleDestroy() { this.db.close() }
}

export function nowSeconds(): number { return Math.floor(Date.now() / 1000) }
