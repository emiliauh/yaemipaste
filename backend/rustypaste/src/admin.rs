//! Web administration API for yaemipaste.
//!
//! Routes in this module live under `/auth/admin`. Installer-only bootstrap
//! endpoints that use `AUTH_ADMIN_BEARER` remain in `account_auth`; these
//! endpoints are user-admin routes protected by signed account JWTs, except for
//! the explicit one-time claim initialization endpoint used by install.sh.

use crate::account_auth::{
    configured_tokens, create_jwt, current_user, json_error, normalize_username, now_seconds,
    open_db, require_admin, verify_turnstile, AuthEnv,
};
use crate::config::Config;
use crate::ratelimit::{client_key, RateLimiter};
use crate::util::{self, safe_path_join, token_to_dir_name};
use actix_files::NamedFile;
use actix_web::http::StatusCode;
use actix_web::{delete, get, patch, post, put, web, HttpRequest, HttpResponse};
use awc::Client;
use bcrypt::{hash, verify, DEFAULT_COST};
use rand::{distr::Alphanumeric, Rng};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use std::time::{Duration, UNIX_EPOCH};

const CLAIM_TOKEN_BYTES: usize = 64;
const DEFAULT_CLAIM_TTL_SECONDS: i64 = 60 * 60 * 24;
const CONFIRM_DELETE_USER: &str = "DELETE USER";
const CONFIRM_PURGE_UPLOADS: &str = "PURGE UPLOADS";
const CONFIRM_PURGE_EXPIRED: &str = "PURGE EXPIRED";

#[derive(Debug, Deserialize)]
struct ClaimInitRequest {
    reset: Option<bool>,
    ttl_seconds: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct ClaimRequest {
    claim_token: String,
    username: String,
    password: String,
    upload_token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CreateUserRequest {
    username: String,
    password: String,
    upload_token: Option<String>,
    is_admin: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct UpdateUserRequest {
    suspended: Option<bool>,
    suspension_reason: Option<String>,
    is_admin: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct RotateTokenRequest {
    token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ConfirmRequest {
    confirmation: String,
}

#[derive(Debug, Deserialize)]
struct BulkDeleteRequest {
    paths: Vec<String>,
    confirmation: String,
}

#[derive(Debug, Deserialize)]
struct SettingsRequest {
    app_name: Option<String>,
    public_title: Option<String>,
    base_api_url: Option<String>,
    registration_enabled: Option<bool>,
    file_size_limit_bytes: Option<u64>,
    file_size_limit_unlimited: Option<bool>,
    upload_access_mode: Option<String>,
    turnstile_enabled: Option<bool>,
    turnstile_site_key: Option<String>,
    turnstile_secret_key: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TurnstileTestRequest { secret_key: String, token: String }

#[derive(Debug, Deserialize)]
struct WebhookRequest {
    url: String,
    events: Vec<String>,
    secret: Option<String>,
    enabled: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct WebhookUpdateRequest {
    url: Option<String>,
    events: Option<Vec<String>>,
    secret: Option<String>,
    enabled: Option<bool>,
}

#[derive(Debug, Serialize)]
struct ClaimStatusResponse {
    admin_exists: bool,
    pending_claim: bool,
    claim_available: bool,
}

#[derive(Debug, Serialize)]
struct ClaimInitResponse {
    token: Option<String>,
    expires_at: Option<i64>,
    detail: String,
}

#[derive(Debug, Serialize)]
struct AdminUserSummary {
    username: String,
    created_at: i64,
    is_admin: bool,
    suspended_at: Option<i64>,
    suspended_reason: Option<String>,
    upload_token_preview: String,
    upload_count: usize,
    disk_usage_bytes: u64,
}

#[derive(Debug, Serialize, Clone)]
struct AdminUploadItem {
    path: String,
    owner: Option<String>,
    file_name: String,
    display_name: Option<String>,
    uploader: Option<String>,
    source: Option<String>,
    size_bytes: u64,
    created_at: Option<i64>,
    expires_at: Option<i64>,
    expired: bool,
    content_type: Option<String>,
}

#[derive(Deserialize, Clone, Default)]
struct UploadSidecarMeta {
    display_name: Option<String>,
    uploader: Option<String>,
    source: Option<String>,
}

#[derive(Debug, Serialize)]
struct DashboardResponse {
    total_disk_usage_bytes: u64,
    upload_count: usize,
    user_count: usize,
    suspended_user_count: usize,
    admin_count: usize,
    users: Vec<AdminUserSummary>,
    recent_uploads: Vec<AdminUploadItem>,
    recent_audit: Vec<Value>,
    failed_webhook_deliveries: Vec<Value>,
    config_status: Value,
    warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
struct WebhookSummary {
    id: i64,
    url: String,
    events: Vec<String>,
    enabled: bool,
    secret_configured: bool,
    secret_preview: Option<String>,
    created_at: i64,
    updated_at: i64,
    updated_by: Option<String>,
}

#[derive(Debug, Clone)]
struct DbUser {
    username: String,
    token: String,
    created_at: i64,
    is_admin: bool,
    suspended_at: Option<i64>,
    suspended_reason: Option<String>,
}

fn generate_secret_token(len: usize) -> String {
    rand::rng()
        .sample_iter(&Alphanumeric)
        .take(len)
        .map(char::from)
        .collect()
}

fn token_preview(token: &str) -> String {
    let mut chars = token.chars();
    let start: String = chars.by_ref().take(6).collect();
    let end: String = token
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    if token.chars().count() <= 12 {
        "••••".to_string()
    } else {
        format!("{start}…{end}")
    }
}

fn user_exists(connection: &Connection, username: &str) -> bool {
    connection
        .query_row(
            "SELECT 1 FROM users WHERE username=?1 LIMIT 1",
            params![username],
            |_row| Ok(true),
        )
        .ok()
        .unwrap_or(false)
}

fn admin_exists(connection: &Connection) -> bool {
    connection
        .query_row("SELECT 1 FROM users WHERE is_admin=1 LIMIT 1", [], |_row| {
            Ok(true)
        })
        .ok()
        .unwrap_or(false)
}

fn pending_claim_exists(connection: &Connection) -> bool {
    let now = now_seconds();
    connection
        .query_row(
            "SELECT 1 FROM admin_claims WHERE used_at IS NULL AND (expires_at IS NULL OR expires_at>?1) LIMIT 1",
            params![now],
            |_row| Ok(true),
        )
        .ok()
        .unwrap_or(false)
}

fn ensure_setting_defaults(connection: &Connection) -> rusqlite::Result<()> {
    let now = now_seconds();
    let upload_access_mode =
        if env::var("ALLOW_ANONYMOUS_UPLOADS").ok().as_deref() == Some("1") {
            "public"
        } else {
            "private"
        };
    for (key, value) in [
        ("app_name", "yaemipaste"),
        ("public_title", "yaemipaste"),
        ("base_api_url", ""),
        ("registration_enabled", "true"),
        ("file_size_limit_bytes", "0"),
        ("file_size_limit_unlimited", "false"),
        ("upload_access_mode", upload_access_mode),
    ] {
        connection.execute(
            "INSERT OR IGNORE INTO admin_settings (key, value, updated_at, updated_by) VALUES (?1, ?2, ?3, 'system')",
            params![key, value, now],
        )?;
    }
    Ok(())
}

fn setting_map(connection: &Connection) -> rusqlite::Result<HashMap<String, String>> {
    ensure_setting_defaults(connection)?;
    let mut statement = connection.prepare("SELECT key, value FROM admin_settings")?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut values = HashMap::new();
    for row in rows {
        let (key, value) = row?;
        values.insert(key, value);
    }
    Ok(values)
}

pub(crate) fn file_size_limit_bytes() -> Option<u64> {
    let auth_env = AuthEnv::from_env();
    let connection = open_db(&auth_env.db_path).ok()?;
    let settings = setting_map(&connection).ok()?;
    if settings.get("file_size_limit_unlimited").map(|value| value == "true").unwrap_or(false) { return None; }
    settings.get("file_size_limit_bytes").and_then(|value| value.parse().ok()).filter(|value| *value > 0)
}

pub(crate) fn registration_enabled(connection: &Connection) -> bool {
    ensure_setting_defaults(connection).ok();
    setting_map(connection)
        .ok()
        .and_then(|settings| settings.get("registration_enabled").cloned())
        .map(|value| value != "false")
        .unwrap_or(true)
}

pub(crate) fn anonymous_uploads_enabled() -> bool {
    let auth_env = AuthEnv::from_env();
    let connection = match open_db(&auth_env.db_path) {
        Ok(connection) => connection,
        Err(_) => return false,
    };
    setting_map(&connection)
        .ok()
        .and_then(|settings| settings.get("upload_access_mode").cloned())
        .is_some_and(|value| value == "public")
}

pub(crate) fn audit(
    connection: &Connection,
    actor: Option<&str>,
    action: &str,
    target: Option<&str>,
    status: &str,
    reason: Option<&str>,
) {
    let _ = connection.execute(
        "INSERT INTO audit_log (created_at, actor, action, target, status, reason) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![now_seconds(), actor, action, target, status, reason],
    );
}

fn db_users(connection: &Connection) -> Result<Vec<DbUser>, HttpResponse> {
    let mut statement = connection
        .prepare(
            "SELECT username, token, created_at, is_admin, suspended_at, suspended_reason FROM users ORDER BY username",
        )
        .map_err(|error| {
            error!("cannot prepare user list query: {}", error);
            json_error(StatusCode::INTERNAL_SERVER_ERROR, "Could not list users")
        })?;
    let rows = statement
        .query_map([], |row| {
            Ok(DbUser {
                username: row.get(0)?,
                token: row.get(1)?,
                created_at: row.get(2)?,
                is_admin: row.get::<_, i64>(3)? == 1,
                suspended_at: row.get(4)?,
                suspended_reason: row.get(5)?,
            })
        })
        .map_err(|error| {
            error!("cannot query users: {}", error);
            json_error(StatusCode::INTERNAL_SERVER_ERROR, "Could not list users")
        })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|error| {
        error!("cannot collect users: {}", error);
        json_error(StatusCode::INTERNAL_SERVER_ERROR, "Could not list users")
    })
}

fn require_jwt_admin(
    request: &HttpRequest,
    connection: &Connection,
    auth_env: &AuthEnv,
) -> Result<String, HttpResponse> {
    let username = current_user(request, &auth_env.jwt_secret)?;
    let row = connection
        .query_row(
            "SELECT is_admin, suspended_at FROM users WHERE username=?1",
            params![username],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<i64>>(1)?)),
        )
        .optional()
        .map_err(|error| {
            error!("cannot check admin auth: {}", error);
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Authorization unavailable",
            )
        })?;
    let Some((is_admin, suspended_at)) = row else {
        audit(
            connection,
            Some(&username),
            "admin.auth",
            None,
            "denied",
            Some("missing user"),
        );
        return Err(json_error(StatusCode::UNAUTHORIZED, "Invalid token"));
    };
    if suspended_at.is_some() {
        audit(
            connection,
            Some(&username),
            "admin.auth",
            None,
            "denied",
            Some("suspended"),
        );
        return Err(json_error(StatusCode::FORBIDDEN, "Account is suspended"));
    }
    if is_admin != 1 {
        audit(
            connection,
            Some(&username),
            "admin.auth",
            None,
            "denied",
            Some("not admin"),
        );
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Administrator access required",
        ));
    }
    Ok(username)
}

fn token_available(
    connection: &Connection,
    configured: Option<&HashSet<String>>,
    token: &str,
) -> bool {
    if token.trim().is_empty() {
        return false;
    }
    if connection
        .query_row(
            "SELECT 1 FROM users WHERE token=?1 LIMIT 1",
            params![token],
            |_row| Ok(true),
        )
        .ok()
        .unwrap_or(false)
    {
        return false;
    }
    if connection
        .query_row(
            "SELECT 1 FROM revoked_tokens WHERE token=?1 LIMIT 1",
            params![token],
            |_row| Ok(true),
        )
        .ok()
        .unwrap_or(false)
    {
        return false;
    }
    configured
        .map(|tokens| tokens.contains(token))
        .unwrap_or(true)
}

fn generate_available_token(
    connection: &Connection,
    configured: Option<&HashSet<String>>,
) -> Option<String> {
    if let Some(configured) = configured {
        return configured
            .iter()
            .find(|token| token_available(connection, Some(configured), token))
            .cloned();
    }
    for _ in 0..16 {
        let token = generate_secret_token(48);
        if token_available(connection, None, &token) {
            return Some(token);
        }
    }
    None
}

fn insert_admin_user(
    connection: &Connection,
    username: &str,
    password: &str,
    upload_token: &str,
    is_admin: bool,
) -> Result<(), HttpResponse> {
    let password_hash = hash(password, DEFAULT_COST).map_err(|error| {
        error!("cannot hash admin-created password: {}", error);
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Could not create account",
        )
    })?;
    connection
        .execute(
            "INSERT INTO users (username, password, token, created_at, is_admin) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![username, password_hash, upload_token, now_seconds(), if is_admin { 1 } else { 0 }],
        )
        .map_err(|error| {
            let detail = if error.to_string().contains("username") {
                "Username already taken"
            } else if error.to_string().contains("token") {
                "Token already used"
            } else {
                error!("cannot insert admin-managed user: {}", error);
                "Could not create account"
            };
            json_error(StatusCode::BAD_REQUEST, detail)
        })?;
    Ok(())
}

fn upload_root(config: &web::Data<RwLock<Config>>) -> Result<PathBuf, HttpResponse> {
    config
        .read()
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Configuration unavailable",
            )
        })
        .map(|config| config.server.upload_path.clone())
}

fn metadata_path(upload_path: &Path, file_name: &str) -> PathBuf {
    upload_path
        .join(".rpmeta")
        .join(format!("{}.json", file_name.replace('/', "_")))
}

/// If `file_name` carries the numeric expiry-timestamp suffix that
/// `stored_file_name` (server.rs) appends to the on-disk name (e.g.
/// `foo.jpg.1784356059807`), returns the pre-suffix name (`foo.jpg`) the
/// file was originally uploaded under.
fn strip_expiry_suffix(file_name: &str) -> Option<&str> {
    let dot = file_name.rfind('.')?;
    let digits = &file_name[dot + 1..];
    (!digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())).then(|| &file_name[..dot])
}

/// Resolves the uploader for a stored file.
///
/// The `.rpmeta/<file>.json` sidecar written at upload time (see
/// `persist_upload_metadata` in server.rs) records the authenticated
/// uploader's username regardless of whether the file's storage directory is
/// sharded per-token, so it is the accurate source of truth. Directory-based
/// attribution (matching the file's parent directory name to a user's
/// token) is kept only as a fallback for uploads that predate metadata
/// tracking or that never carried a `meta` field, such as raw API/ShareX
/// uploads made without the web UI's uploader hint.
fn read_upload_metadata(containing_dir: &Path, file_name: &str) -> Option<UploadSidecarMeta> {
    fn read_metadata(path: PathBuf) -> Option<UploadSidecarMeta> {
        fs::read_to_string(path)
            .ok()
            .and_then(|contents| serde_json::from_str::<UploadSidecarMeta>(&contents).ok())
    }
    read_metadata(metadata_path(containing_dir, file_name)).or_else(|| {
        strip_expiry_suffix(file_name)
            .and_then(|base| read_metadata(metadata_path(containing_dir, base)))
    })
}

fn resolve_upload_owner(
    containing_dir: &Path,
    file_name: &str,
    dir_owner: Option<&String>,
) -> Option<String> {
    fn metadata_uploader(meta: UploadSidecarMeta) -> Option<String> {
        meta.uploader
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty() && value != "Unknown (token user)")
    }
    // Uploads made before the metadata sidecar was keyed by the on-disk
    // (expiry-suffixed) file name wrote it under the pre-suffix name
    // instead; fall back to that legacy path so those uploads don't
    // silently show up as owned by nobody.
    let from_metadata = read_upload_metadata(containing_dir, file_name).and_then(metadata_uploader);
    from_metadata.or_else(|| dir_owner.cloned())
}

fn remove_upload_file(upload_root: &Path, relative_path: &str) -> Result<u64, String> {
    let safe = safe_path_join(upload_root, relative_path).map_err(|e| e.to_string())?;
    let metadata = fs::metadata(&safe).map_err(|_| "File not found".to_string())?;
    if metadata.is_dir() {
        return Err("Refusing to delete directory as file".to_string());
    }
    let size = metadata.len();
    let parent = safe.parent().unwrap_or(upload_root);
    if let Some(name) = safe.file_name().and_then(|value| value.to_str()) {
        let _ = fs::remove_file(metadata_path(parent, name));
        if let Some(base) = strip_expiry_suffix(name) {
            let _ = fs::remove_file(metadata_path(parent, base));
        }
    }
    fs::remove_file(&safe).map_err(|e| e.to_string())?;
    Ok(size)
}

fn expires_at_from_name(name: &str) -> Option<i64> {
    Path::new(name)
        .extension()
        .and_then(|ext| ext.to_str())
        .and_then(|ext| ext.parse::<i64>().ok())
        .map(|millis| millis / 1000)
}

fn collect_uploads(upload_root: &Path, users: &[DbUser]) -> Vec<AdminUploadItem> {
    let mut owner_by_dir: HashMap<String, String> = HashMap::new();
    for user in users {
        owner_by_dir.insert(token_to_dir_name(&user.token), user.username.clone());
    }
    let mut owner_by_file: HashMap<String, String> = HashMap::new();
    fn index_metadata(
        root: &Path,
        current: &Path,
        owner_by_dir: &HashMap<String, String>,
        owner_by_file: &mut HashMap<String, String>,
    ) {
        let Ok(entries) = fs::read_dir(current) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if name == ".rpmeta" {
                let Ok(metadata_entries) = fs::read_dir(&path) else {
                    continue;
                };
                let relative_parent = current
                    .strip_prefix(root)
                    .unwrap_or(current)
                    .to_string_lossy();
                let dir_key = relative_parent.split('/').next().unwrap_or_default();
                for metadata_entry in metadata_entries.flatten() {
                    let metadata_name = metadata_entry.file_name().to_string_lossy().to_string();
                    let Some(file_name) = metadata_name.strip_suffix(".json") else {
                        continue;
                    };
                    if let Some(owner) = resolve_upload_owner(
                        current,
                        file_name,
                        owner_by_dir.get(dir_key),
                    ) {
                        owner_by_file.insert(file_name.to_string(), owner.clone());
                        if let Some(base) = strip_expiry_suffix(file_name) {
                            owner_by_file.insert(base.to_string(), owner);
                        }
                    }
                }
                continue;
            }
            if path.is_dir() {
                index_metadata(root, &path, owner_by_dir, owner_by_file);
            }
        }
    }
    index_metadata(upload_root, upload_root, &owner_by_dir, &mut owner_by_file);
    let mut out = Vec::new();
    fn walk(
        root: &Path,
        current: &Path,
        owner_by_dir: &HashMap<String, String>,
        owner_by_file: &HashMap<String, String>,
        out: &mut Vec<AdminUploadItem>,
    ) {
        let Ok(entries) = fs::read_dir(current) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if name == ".rpmeta" {
                continue;
            }
            // The public short-path compatibility layer creates symlinks at
            // the upload root. They are aliases, not stored uploads, and
            // may remain dangling after the backing file is purged. Do not
            // expose those aliases as admin uploads (or as Unattributed
            // rows).
            let Ok(link_metadata) = fs::symlink_metadata(&path) else {
                continue;
            };
            if link_metadata.file_type().is_symlink() {
                continue;
            }
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            if metadata.is_dir() {
                walk(root, &path, owner_by_dir, owner_by_file, out);
                continue;
            }
            let relative = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            let mut segments = relative.split('/');
            let first = segments.next().unwrap_or_default();
            let sidecar = read_upload_metadata(current, &name);
            let owner = sidecar
                .as_ref()
                .and_then(|meta| meta.uploader.as_ref())
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty() && value != "Unknown (token user)")
                .or_else(|| resolve_upload_owner(current, &name, owner_by_dir.get(first)))
                .or_else(|| owner_by_file.get(&name).cloned())
                .or_else(|| strip_expiry_suffix(&name).and_then(|base| owner_by_file.get(base).cloned()));
            let expires_at = expires_at_from_name(&name);
            let now = now_seconds();
            let content_type = None;
            out.push(AdminUploadItem {
                path: relative,
                owner,
                file_name: name,
                display_name: sidecar.as_ref().and_then(|meta| meta.display_name.clone()),
                uploader: sidecar.as_ref().and_then(|meta| meta.uploader.clone()),
                source: sidecar.and_then(|meta| meta.source),
                size_bytes: metadata.len(),
                created_at: metadata
                    .created()
                    .ok()
                    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                    .map(|duration| duration.as_secs() as i64),
                expires_at,
                expired: expires_at.map(|exp| exp <= now).unwrap_or(false),
                content_type,
            });
        }
    }
    walk(upload_root, upload_root, &owner_by_dir, &owner_by_file, &mut out);
    out.sort_by_key(|item| item.created_at.unwrap_or(0));
    out.reverse();
    out
}

fn user_summary(user: &DbUser, uploads: &[AdminUploadItem]) -> AdminUserSummary {
    let owned: Vec<&AdminUploadItem> = uploads
        .iter()
        .filter(|upload| upload.owner.as_deref() == Some(user.username.as_str()))
        .collect();
    AdminUserSummary {
        username: user.username.clone(),
        created_at: user.created_at,
        is_admin: user.is_admin,
        suspended_at: user.suspended_at,
        suspended_reason: user.suspended_reason.clone(),
        upload_token_preview: token_preview(&user.token),
        upload_count: owned.len(),
        disk_usage_bytes: owned.iter().map(|upload| upload.size_bytes).sum(),
    }
}

fn to_json_rows(connection: &Connection, sql: &str, limit: i64) -> Vec<Value> {
    let mut statement = match connection.prepare(sql) {
        Ok(value) => value,
        Err(error) => {
            error!("cannot prepare admin row query: {}", error);
            return Vec::new();
        }
    };
    let rows = statement.query_map(params![limit], |row| {
        Ok(json!({
            "id": row.get::<_, i64>(0)?,
            "created_at": row.get::<_, i64>(1)?,
            "actor": row.get::<_, Option<String>>(2)?,
            "action": row.get::<_, String>(3)?,
            "target": row.get::<_, Option<String>>(4)?,
            "status": row.get::<_, String>(5)?,
            "reason": row.get::<_, Option<String>>(6)?,
        }))
    });
    match rows {
        Ok(rows) => rows.flatten().collect(),
        Err(error) => {
            error!("cannot query admin rows: {}", error);
            Vec::new()
        }
    }
}

fn webhook_rows(connection: &Connection, failed_only: bool, limit: i64) -> Vec<Value> {
    let sql = if failed_only {
        "SELECT id, webhook_id, event, status, status_code, error, created_at, delivered_at FROM webhook_deliveries WHERE status='failed' ORDER BY created_at DESC LIMIT ?1"
    } else {
        "SELECT id, webhook_id, event, status, status_code, error, created_at, delivered_at FROM webhook_deliveries ORDER BY created_at DESC LIMIT ?1"
    };
    let mut statement = match connection.prepare(sql) {
        Ok(value) => value,
        Err(error) => {
            error!("cannot prepare webhook delivery query: {}", error);
            return Vec::new();
        }
    };
    statement
        .query_map(params![limit], |row| {
            Ok(json!({
                "id": row.get::<_, i64>(0)?,
                "webhook_id": row.get::<_, Option<i64>>(1)?,
                "event": row.get::<_, String>(2)?,
                "status": row.get::<_, String>(3)?,
                "status_code": row.get::<_, Option<i64>>(4)?,
                "error": row.get::<_, Option<String>>(5)?,
                "created_at": row.get::<_, i64>(6)?,
                "delivered_at": row.get::<_, Option<i64>>(7)?,
            }))
        })
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
}

fn parse_events(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect()
}

fn normalized_events(events: &[String]) -> Vec<String> {
    let mut out: Vec<String> = events
        .iter()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .collect();
    out.sort();
    out.dedup();
    out
}

fn validate_url(url: &str) -> bool {
    url::Url::parse(url)
        .map(|parsed| {
            matches!(parsed.scheme(), "http" | "https")
                && parsed.username().is_empty()
                && parsed.password().is_none()
        })
        .unwrap_or(false)
}

fn validate_webhook_url(url: &str) -> bool {
    url::Url::parse(url)
        .map(|parsed| {
            parsed.scheme() == "https"
                && parsed.username().is_empty()
                && parsed.password().is_none()
                && parsed.host_str().is_some_and(is_public_webhook_host)
        })
        .unwrap_or(false)
}

fn is_public_webhook_host(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") || host.ends_with(".localhost") {
        return false;
    }
    let Ok(address) = host.parse::<IpAddr>() else {
        return true;
    };
    match address {
        IpAddr::V4(address) => {
            !(address.is_private()
                || address.is_loopback()
                || address.is_link_local()
                || address.is_unspecified()
                || address.is_multicast()
                || address.is_broadcast()
                || address.is_documentation())
        }
        IpAddr::V6(address) => {
            if let Some(address) = address.to_ipv4() {
                return is_public_webhook_host(&address.to_string());
            }
            let first_segment = address.segments()[0];
            !(address.is_loopback()
                || address.is_unspecified()
                || address.is_multicast()
                || (first_segment & 0xfe00) == 0xfc00
                || (first_segment & 0xffc0) == 0xfe80)
        }
    }
}

fn webhook_summary_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<WebhookSummary> {
    let secret_hash: Option<String> = row.get(3)?;
    Ok(WebhookSummary {
        id: row.get(0)?,
        url: row.get(1)?,
        events: parse_events(&row.get::<_, String>(2)?),
        enabled: row.get::<_, i64>(4)? == 1,
        secret_configured: secret_hash.is_some(),
        secret_preview: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
        updated_by: row.get(8)?,
    })
}

fn webhook_value_text(payload: &Value, key: &str, fallback: &str) -> String {
    match payload.get(key) {
        Some(Value::String(value)) if !value.trim().is_empty() => value.clone(),
        Some(value) if !value.is_null() => value.to_string(),
        _ => fallback.to_string(),
    }
}

fn webhook_embed(event: &str, payload: &Value, app_name: &str) -> Value {
    let (title, color) = match event {
        "file.uploaded" => ("File uploaded", 0x70A7E0),
        "file.deleted" => ("File deleted", 0xD98282),
        "user.created" => ("User created", 0x82C596),
        "user.deleted" => ("User deleted", 0xD98282),
        "admin.webhook.test" => ("Webhook test", 0xA78BFA),
        _ => ("Yaemipaste event", 0x70A7E0),
    };
    let mut fields = Vec::new();
    if payload.get("file").is_some() || payload.get("path").is_some() {
        fields.push(json!({ "name": "File", "value": format!("`{}`", webhook_value_text(payload, "file", &webhook_value_text(payload, "path", "unknown"))), "inline": false }));
    }
    for (key, label) in [
        ("original_name", "Name"),
        ("uploader", "Uploader"),
        ("owner", "Owner"),
        ("source", "Source"),
        ("size_bytes", "Size"),
        ("bytes_removed", "Bytes removed"),
    ] {
        if payload.get(key).is_some() {
            let value = if key == "size_bytes" || key == "bytes_removed" {
                format!("{} bytes", webhook_value_text(payload, key, "0"))
            } else {
                webhook_value_text(payload, key, "unknown")
            };
            if value == "unknown" || value == "\"\"" || value == "null" {
                continue;
            }
            fields.push(json!({ "name": label, "value": value, "inline": true }));
        }
    }
    let mut embed = json!({
        "title": title,
        "description": format!("**{}** · `{}`", app_name, event),
        "color": color,
        "fields": fields,
        "footer": { "text": app_name },
        "timestamp": uts2ts::uts2ts(now_seconds()).as_string(),
    });
    if let Some(url) = payload.get("url").and_then(Value::as_str).filter(|value| !value.is_empty()) {
        embed["url"] = json!(url);
    }
    embed
}

pub(crate) fn dispatch_webhook(event: &str, payload: Value) {
    let event = event.to_string();
    let auth_env = AuthEnv::from_env();
    if !auth_env.db_path.exists() {
        return;
    }
    actix_web::rt::spawn(async move {
        let connection = match open_db(&auth_env.db_path) {
            Ok(connection) => connection,
            Err(_) => return,
        };
        let mut statement =
            match connection.prepare("SELECT id, url, events FROM webhooks WHERE enabled=1") {
                Ok(statement) => statement,
                Err(error) => {
                    error!("cannot prepare webhooks query: {}", error);
                    return;
                }
            };
        let hooks: Vec<(i64, String, Vec<String>)> = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    parse_events(&row.get::<_, String>(2)?),
                ))
            })
            .map(|rows| rows.flatten().collect())
            .unwrap_or_default();
        drop(statement);
        let settings = setting_map(&connection).unwrap_or_default();
        let app_name = settings
            .get("public_title")
            .filter(|value| !value.trim().is_empty())
            .or_else(|| settings.get("app_name"))
            .map(String::as_str)
            .unwrap_or("yaemipaste");
        let client = Client::default();
        for (id, url, events) in hooks {
            // A manual admin test must reach the endpoint even when the
            // webhook is subscribed only to production events such as
            // file.uploaded. Regular events remain strictly filtered.
            if event != "admin.webhook.test" && !events.iter().any(|candidate| candidate == &event) {
                continue;
            }
            let created_at = now_seconds();
            let body = json!({
                // Keep the event envelope below for generic consumers while
                // using the rich embed as Discord's only visible message.
                "username": "Yaemipaste",
                "allowed_mentions": { "parse": [] },
                "embeds": [webhook_embed(&event, &payload, app_name)],
                "event": event,
                "created_at": created_at,
                "payload": payload,
            });
            let delivery_id = connection
                .execute(
                    "INSERT INTO webhook_deliveries (webhook_id, event, payload, status, created_at) VALUES (?1, ?2, ?3, 'pending', ?4)",
                    params![id, event, body.to_string(), created_at],
                )
                .ok()
                .map(|_| connection.last_insert_rowid());
            let response = client
                .post(url)
                .timeout(Duration::from_secs(5))
                .send_json(&body)
                .await;
            match response {
                Ok(response) if response.status().is_success() => {
                    if let Some(delivery_id) = delivery_id {
                        let _ = connection.execute(
                            "UPDATE webhook_deliveries SET status='delivered', status_code=?1, delivered_at=?2 WHERE id=?3",
                            params![response.status().as_u16() as i64, now_seconds(), delivery_id],
                        );
                    }
                }
                Ok(response) => {
                    if let Some(delivery_id) = delivery_id {
                        let _ = connection.execute(
                            "UPDATE webhook_deliveries SET status='failed', status_code=?1, error=?2, delivered_at=?3 WHERE id=?4",
                            params![response.status().as_u16() as i64, format!("HTTP {}", response.status()), now_seconds(), delivery_id],
                        );
                    }
                }
                Err(error) => {
                    if let Some(delivery_id) = delivery_id {
                        let _ = connection.execute(
                            "UPDATE webhook_deliveries SET status='failed', error=?1, delivered_at=?2 WHERE id=?3",
                            params![error.to_string(), now_seconds(), delivery_id],
                        );
                    }
                }
            }
        }
    });
}

#[get("/claim/status")]
async fn claim_status() -> HttpResponse {
    let auth_env = AuthEnv::from_env();
    let connection = match open_db(&auth_env.db_path) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    let admin_exists = admin_exists(&connection);
    let pending_claim = pending_claim_exists(&connection);
    HttpResponse::Ok().json(ClaimStatusResponse {
        admin_exists,
        pending_claim,
        claim_available: !admin_exists && pending_claim,
    })
}

#[post("/claim/init")]
async fn claim_init(
    request: HttpRequest,
    limiter: web::Data<RateLimiter>,
    body: web::Json<ClaimInitRequest>,
) -> HttpResponse {
    if !limiter.check(
        &format!("claim-init:{}", client_key(&request)),
        6,
        Duration::from_secs(60),
    ) {
        return json_error(
            StatusCode::TOO_MANY_REQUESTS,
            "Too many claim initialization attempts",
        );
    }
    let auth_env = AuthEnv::from_env();
    if let Err(response) = require_admin(&request, &auth_env) {
        return response;
    }
    let connection = match open_db(&auth_env.db_path) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    if admin_exists(&connection) && !body.reset.unwrap_or(false) {
        return HttpResponse::Conflict().json(ClaimInitResponse {
            token: None,
            expires_at: None,
            detail: "An administrator already exists".to_string(),
        });
    }
    if pending_claim_exists(&connection) && !body.reset.unwrap_or(false) {
        return HttpResponse::Conflict().json(ClaimInitResponse {
            token: None,
            expires_at: None,
            detail: "A claim token is already pending and cannot be shown again; reset it explicitly if needed".to_string(),
        });
    }
    let token = generate_secret_token(CLAIM_TOKEN_BYTES);
    let token_hash = match hash(&token, DEFAULT_COST) {
        Ok(value) => value,
        Err(error) => {
            error!("cannot hash admin claim token: {}", error);
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Could not create claim token",
            );
        }
    };
    let ttl = body
        .ttl_seconds
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_CLAIM_TTL_SECONDS);
    let expires_at = now_seconds() + ttl;
    if let Err(error) = connection.execute(
        "UPDATE admin_claims SET used_at=?1 WHERE used_at IS NULL",
        params![now_seconds()],
    ) {
        error!("cannot invalidate existing admin claims: {}", error);
        return json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Could not reset claim token",
        );
    }
    if let Err(error) = connection.execute(
        "INSERT INTO admin_claims (token_hash, created_at, expires_at) VALUES (?1, ?2, ?3)",
        params![token_hash, now_seconds(), expires_at],
    ) {
        error!("cannot store admin claim token: {}", error);
        return json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Could not create claim token",
        );
    }
    audit(
        &connection,
        Some("installer"),
        "admin.claim.init",
        None,
        "success",
        None,
    );
    HttpResponse::Ok().json(ClaimInitResponse {
        token: Some(token),
        expires_at: Some(expires_at),
        detail: "Admin claim token generated; it will not be shown again".to_string(),
    })
}

#[post("/claim")]
async fn claim_admin(
    request: HttpRequest,
    limiter: web::Data<RateLimiter>,
    config: web::Data<RwLock<Config>>,
    body: web::Json<ClaimRequest>,
) -> HttpResponse {
    if !limiter.check(
        &format!("claim:{}", client_key(&request)),
        8,
        Duration::from_secs(60),
    ) {
        return json_error(StatusCode::TOO_MANY_REQUESTS, "Too many claim attempts");
    }
    let username = normalize_username(&body.username);
    if username.len() < 2 {
        return json_error(StatusCode::BAD_REQUEST, "Username too short");
    }
    if body.password.len() < 6 {
        return json_error(
            StatusCode::BAD_REQUEST,
            "Password must be at least 6 characters",
        );
    }
    let auth_env = AuthEnv::from_env();
    let connection = match open_db(&auth_env.db_path) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    if admin_exists(&connection) {
        audit(
            &connection,
            Some(&username),
            "admin.claim",
            None,
            "denied",
            Some("admin exists"),
        );
        return json_error(
            StatusCode::CONFLICT,
            "Admin access has already been claimed",
        );
    }
    let row = connection
        .query_row(
            "SELECT id, token_hash, expires_at FROM admin_claims WHERE used_at IS NULL ORDER BY id DESC LIMIT 1",
            [],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<i64>>(2)?)),
        )
        .optional()
        .ok()
        .flatten();
    let Some((claim_id, token_hash, expires_at)) = row else {
        audit(
            &connection,
            Some(&username),
            "admin.claim",
            None,
            "denied",
            Some("missing claim"),
        );
        return json_error(StatusCode::FORBIDDEN, "No active admin claim token");
    };
    if expires_at
        .map(|value| value <= now_seconds())
        .unwrap_or(false)
    {
        audit(
            &connection,
            Some(&username),
            "admin.claim",
            None,
            "denied",
            Some("expired claim"),
        );
        return json_error(StatusCode::FORBIDDEN, "Admin claim token expired");
    }
    if !verify(&body.claim_token, &token_hash).unwrap_or(false) {
        audit(
            &connection,
            Some(&username),
            "admin.claim",
            None,
            "denied",
            Some("invalid token"),
        );
        return json_error(StatusCode::FORBIDDEN, "Invalid admin claim token");
    }
    // Atomically consume the claim row before doing any further work. If two
    // requests race past the SELECT above with a valid token, only one of
    // these UPDATEs can affect a row (SQLite serializes writers), so only one
    // request proceeds to create an admin user.
    let claimed = match connection.execute(
        "UPDATE admin_claims SET used_at=?1 WHERE id=?2 AND used_at IS NULL",
        params![now_seconds(), claim_id],
    ) {
        Ok(rows) => rows,
        Err(error) => {
            error!("cannot mark admin claim used: {}", error);
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Could not claim admin access",
            );
        }
    };
    if claimed == 0 {
        audit(
            &connection,
            Some(&username),
            "admin.claim",
            None,
            "denied",
            Some("claim already used"),
        );
        return json_error(StatusCode::CONFLICT, "Admin claim token already used");
    }
    if admin_exists(&connection) {
        // Defense in depth: another request already created the admin
        // between our earlier check and claiming the token.
        audit(
            &connection,
            Some(&username),
            "admin.claim",
            None,
            "denied",
            Some("admin exists"),
        );
        return json_error(
            StatusCode::CONFLICT,
            "Admin access has already been claimed",
        );
    }
    let configured = match config.read() {
        Ok(config) => configured_tokens(&config),
        Err(_) => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Configuration unavailable",
            )
        }
    };
    let upload_token = if let Some(token) = body
        .upload_token
        .as_ref()
        .map(|token| token.trim())
        .filter(|token| !token.is_empty())
    {
        if !token_available(&connection, configured.as_ref(), token) {
            return json_error(StatusCode::BAD_REQUEST, "Upload token is not available");
        }
        token.to_string()
    } else {
        match generate_available_token(&connection, configured.as_ref()) {
            Some(token) => token,
            None => return json_error(StatusCode::CONFLICT, "No upload token available"),
        }
    };
    if let Err(response) =
        insert_admin_user(&connection, &username, &body.password, &upload_token, true)
    {
        audit(
            &connection,
            Some(&username),
            "admin.claim",
            Some(&username),
            "failed",
            Some("user insert failed"),
        );
        return response;
    }
    audit(
        &connection,
        Some(&username),
        "admin.claim",
        Some(&username),
        "success",
        None,
    );
    dispatch_webhook(
        "user.created",
        json!({ "username": username, "is_admin": true }),
    );
    let jwt = match create_jwt(&auth_env.jwt_secret, auth_env.jwt_ttl_seconds, &username) {
        Ok(jwt) => jwt,
        Err(response) => return response,
    };
    HttpResponse::Ok().json(json!({
        "access_token": jwt,
        "paste_token": upload_token,
        "username": username,
        "is_admin": true,
    }))
}

#[get("/dashboard")]
async fn dashboard(request: HttpRequest, config: web::Data<RwLock<Config>>) -> HttpResponse {
    let auth_env = AuthEnv::from_env();
    let connection = match open_db(&auth_env.db_path) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    let actor = match require_jwt_admin(&request, &connection, &auth_env) {
        Ok(actor) => actor,
        Err(response) => return response,
    };
    let users = match db_users(&connection) {
        Ok(users) => users,
        Err(response) => return response,
    };
    let root = match upload_root(&config) {
        Ok(root) => root,
        Err(response) => return response,
    };
    let uploads = collect_uploads(&root, &users);
    let summaries: Vec<AdminUserSummary> = users
        .iter()
        .map(|user| user_summary(user, &uploads))
        .collect();
    let cfg = match config.read() {
        Ok(config) => config.clone(),
        Err(_) => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Configuration unavailable",
            )
        }
    };
    let total_disk_usage_bytes: u64 = uploads.iter().map(|upload| upload.size_bytes).sum();
    let mut warnings = Vec::new();
    if let Some(limit) = cfg.server.max_upload_dir_size {
        let limit_bytes = u64::from(limit);
        if total_disk_usage_bytes >= limit_bytes {
            warnings.push("Upload storage is at or above configured maximum".to_string());
        } else if total_disk_usage_bytes >= limit_bytes.saturating_mul(9) / 10 {
            warnings.push("Upload storage is above 90% of configured maximum".to_string());
        }
    }
    audit(
        &connection,
        Some(&actor),
        "admin.dashboard.view",
        None,
        "success",
        None,
    );
    let config_status = json!({
        "upload_path": root,
        "max_content_length_bytes": u64::try_from(cfg.server.max_content_length).unwrap_or(0),
        "max_upload_dir_size_bytes": cfg.server.max_upload_dir_size.and_then(|value| u64::try_from(value).ok()),
        "delete_expired_files_enabled": cfg.paste.delete_expired_files.as_ref().map(|value| value.enabled).unwrap_or(false),
        "registration_enabled": registration_enabled(&connection),
    });
    HttpResponse::Ok().json(DashboardResponse {
        total_disk_usage_bytes,
        upload_count: uploads.len(),
        user_count: users.len(),
        suspended_user_count: users.iter().filter(|user| user.suspended_at.is_some()).count(),
        admin_count: users.iter().filter(|user| user.is_admin).count(),
        users: summaries,
        recent_uploads: uploads.into_iter().take(10).collect(),
        recent_audit: to_json_rows(&connection, "SELECT id, created_at, actor, action, target, status, reason FROM audit_log ORDER BY created_at DESC LIMIT ?1", 20),
        failed_webhook_deliveries: webhook_rows(&connection, true, 10),
        config_status,
        warnings,
    })
}

#[get("/users")]
async fn list_users(request: HttpRequest, config: web::Data<RwLock<Config>>) -> HttpResponse {
    let auth_env = AuthEnv::from_env();
    let connection = match open_db(&auth_env.db_path) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    if let Err(response) = require_jwt_admin(&request, &connection, &auth_env) {
        return response;
    }
    let users = match db_users(&connection) {
        Ok(users) => users,
        Err(response) => return response,
    };
    let root = match upload_root(&config) {
        Ok(root) => root,
        Err(response) => return response,
    };
    let uploads = collect_uploads(&root, &users);
    let summaries: Vec<_> = users
        .iter()
        .map(|user| user_summary(user, &uploads))
        .collect();
    HttpResponse::Ok().json(summaries)
}

#[post("/users")]
async fn create_user(
    request: HttpRequest,
    config: web::Data<RwLock<Config>>,
    body: web::Json<CreateUserRequest>,
) -> HttpResponse {
    let auth_env = AuthEnv::from_env();
    let connection = match open_db(&auth_env.db_path) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    let actor = match require_jwt_admin(&request, &connection, &auth_env) {
        Ok(actor) => actor,
        Err(response) => return response,
    };
    let username = normalize_username(&body.username);
    if username.len() < 2 {
        return json_error(StatusCode::BAD_REQUEST, "Username too short");
    }
    if body.password.len() < 6 {
        return json_error(
            StatusCode::BAD_REQUEST,
            "Password must be at least 6 characters",
        );
    }
    let configured = match config.read() {
        Ok(config) => configured_tokens(&config),
        Err(_) => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Configuration unavailable",
            )
        }
    };
    let token = if let Some(token) = body
        .upload_token
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        if !token_available(&connection, configured.as_ref(), token) {
            return json_error(StatusCode::BAD_REQUEST, "Upload token is not available");
        }
        token.to_string()
    } else {
        match generate_available_token(&connection, configured.as_ref()) {
            Some(token) => token,
            None => return json_error(StatusCode::CONFLICT, "No upload token available"),
        }
    };
    if let Err(response) = insert_admin_user(
        &connection,
        &username,
        &body.password,
        &token,
        body.is_admin.unwrap_or(false),
    ) {
        audit(
            &connection,
            Some(&actor),
            "admin.user.create",
            Some(&username),
            "failed",
            None,
        );
        return response;
    }
    audit(
        &connection,
        Some(&actor),
        "admin.user.create",
        Some(&username),
        "success",
        None,
    );
    dispatch_webhook(
        "user.created",
        json!({ "username": username, "is_admin": body.is_admin.unwrap_or(false) }),
    );
    HttpResponse::Ok().json(json!({
        "detail": "User created",
        "username": username,
        "upload_token": token,
    }))
}

#[patch("/users/{username}")]
async fn update_user(
    request: HttpRequest,
    path: web::Path<String>,
    body: web::Json<UpdateUserRequest>,
) -> HttpResponse {
    let auth_env = AuthEnv::from_env();
    let connection = match open_db(&auth_env.db_path) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    let actor = match require_jwt_admin(&request, &connection, &auth_env) {
        Ok(actor) => actor,
        Err(response) => return response,
    };
    let username = normalize_username(&path.into_inner());
    if !user_exists(&connection, &username) {
        return json_error(StatusCode::NOT_FOUND, "User not found");
    }
    if let Some(suspended) = body.suspended {
        if suspended {
            let reason = body
                .suspension_reason
                .as_deref()
                .unwrap_or("Suspended by administrator")
                .trim();
            let reason = if reason.is_empty() {
                "Suspended by administrator"
            } else {
                reason
            };
            if let Err(error) = connection.execute(
                "UPDATE users SET suspended_at=?1, suspended_reason=?2 WHERE username=?3",
                params![now_seconds(), reason, username],
            ) {
                error!("cannot suspend user: {}", error);
                return json_error(StatusCode::INTERNAL_SERVER_ERROR, "Could not suspend user");
            }
            audit(
                &connection,
                Some(&actor),
                "admin.user.suspend",
                Some(&username),
                "success",
                Some(reason),
            );
            dispatch_webhook(
                "user.suspended",
                json!({ "username": username, "reason": reason }),
            );
        } else {
            if let Err(error) = connection.execute(
                "UPDATE users SET suspended_at=NULL, suspended_reason=NULL WHERE username=?1",
                params![username],
            ) {
                error!("cannot unsuspend user: {}", error);
                return json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Could not unsuspend user",
                );
            }
            audit(
                &connection,
                Some(&actor),
                "admin.user.unsuspend",
                Some(&username),
                "success",
                None,
            );
        }
    }
    if let Some(is_admin) = body.is_admin {
        let admin_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM users WHERE is_admin=1", [], |row| {
                row.get(0)
            })
            .unwrap_or(0);
        let target_is_admin: bool = connection
            .query_row(
                "SELECT is_admin FROM users WHERE username=?1",
                params![username],
                |row| row.get::<_, i64>(0),
            )
            .ok()
            .map(|value| value == 1)
            .unwrap_or(false);
        if target_is_admin && !is_admin && admin_count <= 1 {
            return json_error(
                StatusCode::BAD_REQUEST,
                "Cannot remove the last administrator",
            );
        }
        if let Err(error) = connection.execute(
            "UPDATE users SET is_admin=?1 WHERE username=?2",
            params![if is_admin { 1 } else { 0 }, username],
        ) {
            error!("cannot update admin role: {}", error);
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Could not update user role",
            );
        }
        audit(
            &connection,
            Some(&actor),
            "admin.user.role",
            Some(&username),
            "success",
            Some(if is_admin { "admin" } else { "user" }),
        );
    }
    HttpResponse::Ok().json(json!({ "detail": "User updated" }))
}

#[post("/users/{username}/token")]
async fn rotate_user_token(
    request: HttpRequest,
    limiter: web::Data<RateLimiter>,
    config: web::Data<RwLock<Config>>,
    path: web::Path<String>,
    body: web::Json<RotateTokenRequest>,
) -> HttpResponse {
    let auth_env = AuthEnv::from_env();
    let connection = match open_db(&auth_env.db_path) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    let actor = match require_jwt_admin(&request, &connection, &auth_env) {
        Ok(actor) => actor,
        Err(response) => return response,
    };
    if !limiter.check(
        &format!("admin-mutate:{}", client_key(&request)),
        20,
        Duration::from_secs(60),
    ) {
        return json_error(StatusCode::TOO_MANY_REQUESTS, "Too many admin requests");
    }
    let username = normalize_username(&path.into_inner());
    let old_token = connection
        .query_row(
            "SELECT token FROM users WHERE username=?1",
            params![username],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .ok()
        .flatten();
    let Some(old_token) = old_token else {
        return json_error(StatusCode::NOT_FOUND, "User not found");
    };
    let configured = match config.read() {
        Ok(config) => configured_tokens(&config),
        Err(_) => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Configuration unavailable",
            )
        }
    };
    let token = if let Some(token) = body
        .token
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        if !token_available(&connection, configured.as_ref(), token) {
            return json_error(StatusCode::BAD_REQUEST, "Upload token is not available");
        }
        token.to_string()
    } else {
        match generate_available_token(&connection, configured.as_ref()) {
            Some(token) => token,
            None => return json_error(StatusCode::CONFLICT, "No upload token available"),
        }
    };
    if let Err(error) = connection.execute(
        "UPDATE users SET token=?1 WHERE username=?2",
        params![token, username],
    ) {
        error!("cannot rotate user token: {}", error);
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, "Could not rotate token");
    }
    let _ = connection.execute(
        "INSERT OR REPLACE INTO revoked_tokens (token, revoked_at) VALUES (?1, ?2)",
        params![old_token, now_seconds()],
    );
    audit(
        &connection,
        Some(&actor),
        "admin.user.token.rotate",
        Some(&username),
        "success",
        None,
    );
    HttpResponse::Ok().json(json!({ "detail": "Token rotated", "upload_token": token }))
}

#[delete("/users/{username}")]
async fn delete_user(
    request: HttpRequest,
    limiter: web::Data<RateLimiter>,
    config: web::Data<RwLock<Config>>,
    path: web::Path<String>,
    body: web::Json<ConfirmRequest>,
) -> HttpResponse {
    let auth_env = AuthEnv::from_env();
    let connection = match open_db(&auth_env.db_path) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    let actor = match require_jwt_admin(&request, &connection, &auth_env) {
        Ok(actor) => actor,
        Err(response) => return response,
    };
    if !limiter.check(
        &format!("admin-mutate:{}", client_key(&request)),
        20,
        Duration::from_secs(60),
    ) {
        return json_error(StatusCode::TOO_MANY_REQUESTS, "Too many admin requests");
    }
    if body.confirmation.trim() != CONFIRM_DELETE_USER {
        return json_error(StatusCode::BAD_REQUEST, "Confirmation text mismatch");
    }
    let username = normalize_username(&path.into_inner());
    let row = connection
        .query_row(
            "SELECT token, is_admin FROM users WHERE username=?1",
            params![username],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()
        .ok()
        .flatten();
    let Some((token, is_admin)) = row else {
        return json_error(StatusCode::NOT_FOUND, "User not found");
    };
    if is_admin == 1 {
        let admin_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM users WHERE is_admin=1", [], |row| {
                row.get(0)
            })
            .unwrap_or(0);
        if admin_count <= 1 {
            return json_error(
                StatusCode::BAD_REQUEST,
                "Cannot delete the last administrator",
            );
        }
    }
    let root = match upload_root(&config) {
        Ok(root) => root,
        Err(response) => return response,
    };
    let users_before_delete = match db_users(&connection) {
        Ok(users) => users,
        Err(response) => return response,
    };
    let upload_dir = root.join(token_to_dir_name(&token));
    let _ = fs::remove_dir_all(upload_dir);
    // Remove any additional uploads attributed to this user outside the
    // per-token directory (identified via `.rpmeta` sidecar metadata rather
    // than directory layout) so deletion is not silently incomplete.
    let leftover: Vec<_> = collect_uploads(&root, &users_before_delete)
        .into_iter()
        .filter(|upload| upload.owner.as_deref() == Some(username.as_str()))
        .collect();
    for upload in leftover {
        let _ = remove_upload_file(&root, &upload.path);
    }
    if let Err(error) = connection.execute("DELETE FROM users WHERE username=?1", params![username])
    {
        error!("cannot delete user: {}", error);
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, "Could not delete user");
    }
    let _ = connection.execute(
        "INSERT OR REPLACE INTO revoked_tokens (token, revoked_at) VALUES (?1, ?2)",
        params![token, now_seconds()],
    );
    audit(
        &connection,
        Some(&actor),
        "admin.user.delete",
        Some(&username),
        "success",
        None,
    );
    dispatch_webhook("user.deleted", json!({ "username": username }));
    HttpResponse::Ok().json(json!({ "detail": "User deleted" }))
}

#[post("/users/{username}/purge")]
async fn purge_user_uploads(
    request: HttpRequest,
    limiter: web::Data<RateLimiter>,
    config: web::Data<RwLock<Config>>,
    path: web::Path<String>,
    body: web::Json<ConfirmRequest>,
) -> HttpResponse {
    let auth_env = AuthEnv::from_env();
    let connection = match open_db(&auth_env.db_path) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    let actor = match require_jwt_admin(&request, &connection, &auth_env) {
        Ok(actor) => actor,
        Err(response) => return response,
    };
    if !limiter.check(
        &format!("admin-mutate:{}", client_key(&request)),
        20,
        Duration::from_secs(60),
    ) {
        return json_error(StatusCode::TOO_MANY_REQUESTS, "Too many admin requests");
    }
    if body.confirmation.trim() != CONFIRM_PURGE_UPLOADS {
        return json_error(StatusCode::BAD_REQUEST, "Confirmation text mismatch");
    }
    let username = normalize_username(&path.into_inner());
    let token = connection
        .query_row(
            "SELECT token FROM users WHERE username=?1",
            params![username],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .ok()
        .flatten();
    let Some(token) = token else {
        return json_error(StatusCode::NOT_FOUND, "User not found");
    };
    let root = match upload_root(&config) {
        Ok(root) => root,
        Err(response) => return response,
    };
    let users = match db_users(&connection) {
        Ok(users) => users,
        Err(response) => return response,
    };
    let upload_dir = root.join(token_to_dir_name(&token));
    let mut size = util::get_dir_size(&upload_dir).unwrap_or(0);
    let _ = fs::remove_dir_all(&upload_dir);
    if let Err(error) = fs::create_dir_all(&upload_dir) {
        error!(
            "cannot recreate user upload directory after purge: {}",
            error
        );
    }
    // Remove any additional uploads attributed to this user outside the
    // per-token directory (identified via `.rpmeta` sidecar metadata rather
    // than directory layout) so the purge is not silently incomplete.
    let leftover: Vec<_> = collect_uploads(&root, &users)
        .into_iter()
        .filter(|upload| upload.owner.as_deref() == Some(username.as_str()))
        .collect();
    for upload in leftover {
        if let Ok(removed) = remove_upload_file(&root, &upload.path) {
            size += removed;
        }
    }
    audit(
        &connection,
        Some(&actor),
        "admin.uploads.purge_user",
        Some(&username),
        "success",
        None,
    );
    dispatch_webhook(
        "admin.purge.completed",
        json!({ "username": username, "bytes_removed": size }),
    );
    HttpResponse::Ok().json(json!({ "detail": "User uploads purged", "bytes_removed": size }))
}

#[get("/users/{username}/uploads")]
async fn user_uploads(
    request: HttpRequest,
    config: web::Data<RwLock<Config>>,
    path: web::Path<String>,
) -> HttpResponse {
    let auth_env = AuthEnv::from_env();
    let connection = match open_db(&auth_env.db_path) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    if let Err(response) = require_jwt_admin(&request, &connection, &auth_env) {
        return response;
    }
    let username = normalize_username(&path.into_inner());
    let users = match db_users(&connection) {
        Ok(users) => users,
        Err(response) => return response,
    };
    let root = match upload_root(&config) {
        Ok(root) => root,
        Err(response) => return response,
    };
    let uploads: Vec<_> = collect_uploads(&root, &users)
        .into_iter()
        .filter(|upload| upload.owner.as_deref() == Some(username.as_str()))
        .collect();
    HttpResponse::Ok().json(uploads)
}

#[get("/uploads")]
async fn list_uploads(request: HttpRequest, config: web::Data<RwLock<Config>>) -> HttpResponse {
    let auth_env = AuthEnv::from_env();
    let connection = match open_db(&auth_env.db_path) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    if let Err(response) = require_jwt_admin(&request, &connection, &auth_env) {
        return response;
    }
    let users = match db_users(&connection) {
        Ok(users) => users,
        Err(response) => return response,
    };
    let root = match upload_root(&config) {
        Ok(root) => root,
        Err(response) => return response,
    };
    HttpResponse::Ok().json(collect_uploads(&root, &users))
}

#[get("/uploads/content")]
async fn upload_content(
    request: HttpRequest,
    config: web::Data<RwLock<Config>>,
    query: web::Query<HashMap<String, String>>,
) -> HttpResponse {
    let auth_env = AuthEnv::from_env();
    let connection = match open_db(&auth_env.db_path) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    if let Err(response) = require_jwt_admin(&request, &connection, &auth_env) {
        return response;
    }
    let Some(path) = query.get("path") else {
        return json_error(StatusCode::BAD_REQUEST, "path is required");
    };
    let root = match upload_root(&config) {
        Ok(root) => root,
        Err(response) => return response,
    };
    let file = match safe_path_join(&root, path) {
        Ok(file) => file,
        Err(_) => return json_error(StatusCode::BAD_REQUEST, "invalid upload path"),
    };
    match fs::metadata(&file) {
        Ok(metadata) if metadata.is_file() => {}
        _ => return json_error(StatusCode::NOT_FOUND, "File not found"),
    }
    match NamedFile::open(file) {
        Ok(file) => file.into_response(&request),
        Err(_) => json_error(StatusCode::NOT_FOUND, "File not found"),
    }
}

#[delete("/uploads")]
async fn delete_upload(
    request: HttpRequest,
    limiter: web::Data<RateLimiter>,
    config: web::Data<RwLock<Config>>,
    query: web::Query<HashMap<String, String>>,
) -> HttpResponse {
    let auth_env = AuthEnv::from_env();
    let connection = match open_db(&auth_env.db_path) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    let actor = match require_jwt_admin(&request, &connection, &auth_env) {
        Ok(actor) => actor,
        Err(response) => return response,
    };
    if !limiter.check(
        &format!("admin-mutate:{}", client_key(&request)),
        20,
        Duration::from_secs(60),
    ) {
        return json_error(StatusCode::TOO_MANY_REQUESTS, "Too many admin requests");
    }
    let Some(path) = query.get("path") else {
        return json_error(StatusCode::BAD_REQUEST, "path is required");
    };
    let root = match upload_root(&config) {
        Ok(root) => root,
        Err(response) => return response,
    };
    match remove_upload_file(&root, path) {
        Ok(size) => {
            audit(
                &connection,
                Some(&actor),
                "admin.upload.delete",
                Some(path),
                "success",
                None,
            );
            dispatch_webhook(
                "file.deleted",
                json!({ "path": path, "bytes_removed": size, "actor": actor }),
            );
            HttpResponse::Ok().json(json!({ "detail": "Upload deleted", "bytes_removed": size }))
        }
        Err(error) => {
            error!("cannot delete upload {}: {}", path, error);
            audit(
                &connection,
                Some(&actor),
                "admin.upload.delete",
                Some(path),
                "failed",
                Some("invalid path"),
            );
            json_error(StatusCode::BAD_REQUEST, "Invalid upload path")
        }
    }
}

#[post("/uploads/bulk-delete")]
async fn bulk_delete_uploads(
    request: HttpRequest,
    limiter: web::Data<RateLimiter>,
    config: web::Data<RwLock<Config>>,
    body: web::Json<BulkDeleteRequest>,
) -> HttpResponse {
    let auth_env = AuthEnv::from_env();
    let connection = match open_db(&auth_env.db_path) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    let actor = match require_jwt_admin(&request, &connection, &auth_env) {
        Ok(actor) => actor,
        Err(response) => return response,
    };
    if !limiter.check(
        &format!("admin-mutate:{}", client_key(&request)),
        20,
        Duration::from_secs(60),
    ) {
        return json_error(StatusCode::TOO_MANY_REQUESTS, "Too many admin requests");
    }
    if body.confirmation.trim() != CONFIRM_PURGE_UPLOADS {
        return json_error(StatusCode::BAD_REQUEST, "Confirmation text mismatch");
    }
    let root = match upload_root(&config) {
        Ok(root) => root,
        Err(response) => return response,
    };
    let mut deleted = 0usize;
    let mut bytes_removed = 0u64;
    let mut errors = Vec::new();
    for path in &body.paths {
        match remove_upload_file(&root, path) {
            Ok(size) => {
                deleted += 1;
                bytes_removed += size;
            }
            Err(error) => {
                error!(
                    "cannot delete upload {} during bulk delete: {}",
                    path, error
                );
                errors.push(json!({ "path": path, "error": "Invalid upload path" }));
            }
        }
    }
    audit(
        &connection,
        Some(&actor),
        "admin.upload.bulk_delete",
        None,
        if errors.is_empty() {
            "success"
        } else {
            "partial"
        },
        Some(&format!("{} deleted", deleted)),
    );
    dispatch_webhook(
        "admin.purge.completed",
        json!({ "deleted": deleted, "bytes_removed": bytes_removed, "errors": errors }),
    );
    HttpResponse::Ok()
        .json(json!({ "deleted": deleted, "bytes_removed": bytes_removed, "errors": errors }))
}

#[post("/uploads/purge-expired")]
async fn purge_expired(
    request: HttpRequest,
    limiter: web::Data<RateLimiter>,
    config: web::Data<RwLock<Config>>,
    body: web::Json<ConfirmRequest>,
) -> HttpResponse {
    let auth_env = AuthEnv::from_env();
    let connection = match open_db(&auth_env.db_path) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    let actor = match require_jwt_admin(&request, &connection, &auth_env) {
        Ok(actor) => actor,
        Err(response) => return response,
    };
    if !limiter.check(
        &format!("admin-mutate:{}", client_key(&request)),
        20,
        Duration::from_secs(60),
    ) {
        return json_error(StatusCode::TOO_MANY_REQUESTS, "Too many admin requests");
    }
    if body.confirmation.trim() != CONFIRM_PURGE_EXPIRED {
        return json_error(StatusCode::BAD_REQUEST, "Confirmation text mismatch");
    }
    let root = match upload_root(&config) {
        Ok(root) => root,
        Err(response) => return response,
    };
    let expired = util::get_expired_files(&root);
    let mut deleted = 0usize;
    let mut bytes_removed = 0u64;
    for file in expired {
        if let Ok(metadata) = fs::metadata(&file) {
            bytes_removed += metadata.len();
        }
        if fs::remove_file(&file).is_ok() {
            deleted += 1;
        }
    }
    audit(
        &connection,
        Some(&actor),
        "admin.upload.purge_expired",
        None,
        "success",
        Some(&format!("{} deleted", deleted)),
    );
    dispatch_webhook(
        "admin.purge.completed",
        json!({ "expired_deleted": deleted, "bytes_removed": bytes_removed }),
    );
    HttpResponse::Ok().json(json!({ "deleted": deleted, "bytes_removed": bytes_removed }))
}

#[get("/settings")]
async fn get_settings(request: HttpRequest) -> HttpResponse {
    let auth_env = AuthEnv::from_env();
    let connection = match open_db(&auth_env.db_path) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    if let Err(response) = require_jwt_admin(&request, &connection, &auth_env) {
        return response;
    }
    match setting_map(&connection) {
        Ok(mut settings) => {
            settings.remove("turnstile_secret_key");
            HttpResponse::Ok().json(settings)
        }
        Err(error) => {
            error!("cannot read admin settings: {}", error);
            json_error(StatusCode::INTERNAL_SERVER_ERROR, "Could not read settings")
        }
    }
}

#[put("/settings")]
async fn put_settings(request: HttpRequest, body: web::Json<SettingsRequest>) -> HttpResponse {
    let auth_env = AuthEnv::from_env();
    let connection = match open_db(&auth_env.db_path) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    let actor = match require_jwt_admin(&request, &connection, &auth_env) {
        Ok(actor) => actor,
        Err(response) => return response,
    };
    let mut updates = Vec::new();
    if let Some(value) = body
        .app_name
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        updates.push(("app_name", value.to_string()));
    }
    if let Some(value) = body
        .public_title
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        updates.push(("public_title", value.to_string()));
    }
    if let Some(value) = body
        .base_api_url
        .as_ref()
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty())
    {
        if !validate_url(&value) {
            return json_error(
                StatusCode::BAD_REQUEST,
                "Base API URL must be http(s) without credentials",
            );
        }
        updates.push(("base_api_url", value));
    }
    if let Some(value) = body.registration_enabled {
        updates.push(("registration_enabled", value.to_string()));
    }
    if let Some(value) = body.file_size_limit_bytes {
        updates.push(("file_size_limit_bytes", value.to_string()));
    }
    if let Some(value) = body.file_size_limit_unlimited {
        updates.push(("file_size_limit_unlimited", value.to_string()));
    }
    if let Some(value) = body.upload_access_mode.as_deref() {
        if !matches!(value, "private" | "public") {
            return json_error(
                StatusCode::BAD_REQUEST,
                "Upload access mode must be private or public",
            );
        }
        updates.push(("upload_access_mode", value.to_string()));
    }
    if let Some(value) = body.turnstile_enabled {
        updates.push(("turnstile_enabled", value.to_string()));
    }
    if let Some(value) = body.turnstile_site_key.as_ref() {
        updates.push(("turnstile_site_key", value.trim().to_string()));
    }
    if let Some(value) = body.turnstile_secret_key.as_ref() {
        updates.push(("turnstile_secret_key", value.trim().to_string()));
    }
    for (key, value) in updates {
        if let Err(error) = connection.execute(
            "INSERT INTO admin_settings (key, value, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by",
            params![key, value, now_seconds(), actor],
        ) {
            error!("cannot update setting {}: {}", key, error);
            return json_error(StatusCode::INTERNAL_SERVER_ERROR, "Could not update settings");
        }
        audit(
            &connection,
            Some(&actor),
            "admin.settings.update",
            Some(key),
            "success",
            None,
        );
    }
    match setting_map(&connection) {
        Ok(mut settings) => {
            settings.remove("turnstile_secret_key");
            HttpResponse::Ok().json(settings)
        }
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "Could not read settings"),
    }
}

#[post("/settings/turnstile/test")]
async fn test_turnstile(request: HttpRequest, body: web::Json<TurnstileTestRequest>, client: web::Data<Client>) -> HttpResponse {
    let auth_env = AuthEnv::from_env();
    let connection = match open_db(&auth_env.db_path) { Ok(value) => value, Err(response) => return response };
    if let Err(response) = require_jwt_admin(&request, &connection, &auth_env) { return response; }
    if body.secret_key.trim().is_empty() || body.token.trim().is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "Turnstile secret key and verification token are required");
    }
    if verify_turnstile(&client, &body.secret_key, &body.token).await {
        HttpResponse::Ok().json(json!({ "success": true }))
    } else {
        json_error(StatusCode::BAD_REQUEST, "Turnstile verification failed. Check the keys and domain.")
    }
}

#[get("/webhooks")]
async fn list_webhooks(request: HttpRequest) -> HttpResponse {
    let auth_env = AuthEnv::from_env();
    let connection = match open_db(&auth_env.db_path) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    if let Err(response) = require_jwt_admin(&request, &connection, &auth_env) {
        return response;
    }
    let mut statement = match connection.prepare("SELECT id, url, events, secret_hash, enabled, secret_preview, created_at, updated_at, updated_by FROM webhooks ORDER BY id") {
        Ok(statement) => statement,
        Err(error) => {
            error!("cannot prepare webhooks query: {}", error);
            return json_error(StatusCode::INTERNAL_SERVER_ERROR, "Could not list webhooks");
        }
    };
    let hooks: Vec<_> = statement
        .query_map([], webhook_summary_from_row)
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default();
    HttpResponse::Ok().json(hooks)
}

#[post("/webhooks")]
async fn create_webhook(request: HttpRequest, body: web::Json<WebhookRequest>) -> HttpResponse {
    let auth_env = AuthEnv::from_env();
    let connection = match open_db(&auth_env.db_path) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    let actor = match require_jwt_admin(&request, &connection, &auth_env) {
        Ok(actor) => actor,
        Err(response) => return response,
    };
    if !validate_webhook_url(&body.url) {
        return json_error(
            StatusCode::BAD_REQUEST,
            "Webhook URL must use a public HTTPS origin",
        );
    }
    let events = normalized_events(&body.events);
    if events.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "At least one event is required");
    }
    let (secret_hash, secret_preview) = match body
        .secret
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        Some(secret) => match hash(secret, DEFAULT_COST) {
            Ok(hash) => (Some(hash), Some(token_preview(secret))),
            Err(error) => {
                error!("cannot hash webhook secret: {}", error);
                return json_error(StatusCode::INTERNAL_SERVER_ERROR, "Could not store webhook");
            }
        },
        None => (None, None),
    };
    if let Err(error) = connection.execute(
        "INSERT INTO webhooks (url, events, secret_hash, secret_preview, enabled, created_at, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7)",
        params![body.url.trim(), events.join(","), secret_hash, secret_preview, if body.enabled.unwrap_or(true) { 1 } else { 0 }, now_seconds(), actor],
    ) {
        error!("cannot create webhook: {}", error);
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, "Could not create webhook");
    }
    audit(
        &connection,
        Some(&actor),
        "admin.webhook.create",
        Some(body.url.trim()),
        "success",
        None,
    );
    HttpResponse::Ok()
        .json(json!({ "detail": "Webhook created", "id": connection.last_insert_rowid() }))
}

#[patch("/webhooks/{id}")]
async fn update_webhook(
    request: HttpRequest,
    id: web::Path<i64>,
    body: web::Json<WebhookUpdateRequest>,
) -> HttpResponse {
    let auth_env = AuthEnv::from_env();
    let connection = match open_db(&auth_env.db_path) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    let actor = match require_jwt_admin(&request, &connection, &auth_env) {
        Ok(actor) => actor,
        Err(response) => return response,
    };
    let id = id.into_inner();
    if connection
        .query_row("SELECT 1 FROM webhooks WHERE id=?1", params![id], |_row| {
            Ok(true)
        })
        .ok()
        .unwrap_or(false)
        == false
    {
        return json_error(StatusCode::NOT_FOUND, "Webhook not found");
    }
    if let Some(url) = body
        .url
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        if !validate_webhook_url(url) {
            return json_error(
                StatusCode::BAD_REQUEST,
                "Webhook URL must use a public HTTPS origin",
            );
        }
        let _ = connection.execute(
            "UPDATE webhooks SET url=?1, updated_at=?2, updated_by=?3 WHERE id=?4",
            params![url, now_seconds(), actor, id],
        );
    }
    if let Some(events) = body.events.as_ref() {
        let events = normalized_events(events);
        if events.is_empty() {
            return json_error(StatusCode::BAD_REQUEST, "At least one event is required");
        }
        let _ = connection.execute(
            "UPDATE webhooks SET events=?1, updated_at=?2, updated_by=?3 WHERE id=?4",
            params![events.join(","), now_seconds(), actor, id],
        );
    }
    if let Some(enabled) = body.enabled {
        let _ = connection.execute(
            "UPDATE webhooks SET enabled=?1, updated_at=?2, updated_by=?3 WHERE id=?4",
            params![if enabled { 1 } else { 0 }, now_seconds(), actor, id],
        );
    }
    if let Some(secret) = body.secret.as_ref() {
        let secret = secret.trim();
        if secret.is_empty() {
            let _ = connection.execute("UPDATE webhooks SET secret_hash=NULL, secret_preview=NULL, updated_at=?1, updated_by=?2 WHERE id=?3", params![now_seconds(), actor, id]);
        } else {
            match hash(secret, DEFAULT_COST) {
                Ok(secret_hash) => {
                    let _ = connection.execute("UPDATE webhooks SET secret_hash=?1, secret_preview=?2, updated_at=?3, updated_by=?4 WHERE id=?5", params![secret_hash, token_preview(secret), now_seconds(), actor, id]);
                }
                Err(error) => {
                    error!("cannot hash webhook secret: {}", error);
                    return json_error(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "Could not update webhook secret",
                    );
                }
            }
        }
    }
    audit(
        &connection,
        Some(&actor),
        "admin.webhook.update",
        Some(&id.to_string()),
        "success",
        None,
    );
    HttpResponse::Ok().json(json!({ "detail": "Webhook updated" }))
}

#[delete("/webhooks/{id}")]
async fn delete_webhook(request: HttpRequest, id: web::Path<i64>) -> HttpResponse {
    let auth_env = AuthEnv::from_env();
    let connection = match open_db(&auth_env.db_path) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    let actor = match require_jwt_admin(&request, &connection, &auth_env) {
        Ok(actor) => actor,
        Err(response) => return response,
    };
    let id = id.into_inner();
    if let Err(error) = connection.execute("DELETE FROM webhooks WHERE id=?1", params![id]) {
        error!("cannot delete webhook: {}", error);
        return json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Could not delete webhook",
        );
    }
    audit(
        &connection,
        Some(&actor),
        "admin.webhook.delete",
        Some(&id.to_string()),
        "success",
        None,
    );
    HttpResponse::Ok().json(json!({ "detail": "Webhook deleted" }))
}

#[post("/webhooks/{id}/test")]
async fn test_webhook(request: HttpRequest, id: web::Path<i64>) -> HttpResponse {
    let auth_env = AuthEnv::from_env();
    let connection = match open_db(&auth_env.db_path) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    let actor = match require_jwt_admin(&request, &connection, &auth_env) {
        Ok(actor) => actor,
        Err(response) => return response,
    };
    let id = id.into_inner();
    let exists = connection
        .query_row("SELECT 1 FROM webhooks WHERE id=?1", params![id], |_row| {
            Ok(true)
        })
        .ok()
        .unwrap_or(false);
    if !exists {
        return json_error(StatusCode::NOT_FOUND, "Webhook not found");
    }
    audit(
        &connection,
        Some(&actor),
        "admin.webhook.test",
        Some(&id.to_string()),
        "queued",
        None,
    );
    dispatch_webhook(
        "admin.webhook.test",
        json!({ "webhook_id": id, "actor": actor }),
    );
    HttpResponse::Ok().json(json!({ "detail": "Webhook test queued" }))
}

#[get("/webhooks/deliveries")]
async fn webhook_deliveries(request: HttpRequest) -> HttpResponse {
    let auth_env = AuthEnv::from_env();
    let connection = match open_db(&auth_env.db_path) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    if let Err(response) = require_jwt_admin(&request, &connection, &auth_env) {
        return response;
    }
    HttpResponse::Ok().json(webhook_rows(&connection, false, 100))
}

#[get("/audit")]
async fn audit_log(request: HttpRequest) -> HttpResponse {
    let auth_env = AuthEnv::from_env();
    let connection = match open_db(&auth_env.db_path) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    if let Err(response) = require_jwt_admin(&request, &connection, &auth_env) {
        return response;
    }
    HttpResponse::Ok().json(to_json_rows(&connection, "SELECT id, created_at, actor, action, target, status, reason FROM audit_log ORDER BY created_at DESC LIMIT ?1", 200))
}

#[get("/public-settings")]
async fn public_settings() -> HttpResponse {
    let auth_env = AuthEnv::from_env();
    let connection = match open_db(&auth_env.db_path) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    let settings = setting_map(&connection).unwrap_or_default();
    // Despite the VITE_ prefix (kept for .env naming continuity), the
    // frontend no longer reads VITE_TURNSTILE_SITE_KEY at build time at
    // all - it fetches the live value from this endpoint on every page
    // load, and the login page gates on `turnstile_required` (derived from
    // TURNSTILE_SECRET_KEY below), never a build-time-baked value. This
    // means both keys can be set/changed/cleared via `.env` + `docker
    // compose up -d` alone, no rebuild, and the two can never drift out of
    // sync and silently lock login out.
    let turnstile_site_key = env::var("VITE_TURNSTILE_SITE_KEY")
        .unwrap_or_default()
        .trim()
        .to_string();
    HttpResponse::Ok().json(json!({
        "app_name": settings.get("app_name").cloned().unwrap_or_else(|| "yaemipaste".to_string()),
        "public_title": settings.get("public_title").cloned().unwrap_or_else(|| "yaemipaste".to_string()),
        "base_api_url": settings.get("base_api_url").cloned().unwrap_or_default(),
        "registration_enabled": registration_enabled(&connection),
        "upload_access_mode": settings
            .get("upload_access_mode")
            .cloned()
            .unwrap_or_else(|| "private".to_string()),
        "file_size_limit_bytes": settings.get("file_size_limit_bytes").and_then(|value| value.parse::<u64>().ok()).unwrap_or(0),
        "file_size_limit_unlimited": settings.get("file_size_limit_unlimited").map(|value| value == "true").unwrap_or(false),
        "turnstile_site_key": turnstile_site_key,
        "turnstile_required": !auth_env.turnstile_secret_key.trim().is_empty(),
    }))
}

/// Configures `/auth/admin` routes.
pub fn configure_routes(cfg: &mut web::ServiceConfig) {
    cfg.service(claim_status)
        .service(claim_init)
        .service(claim_admin)
        .service(dashboard)
        .service(list_users)
        .service(create_user)
        .service(update_user)
        .service(rotate_user_token)
        .service(delete_user)
        .service(purge_user_uploads)
        .service(user_uploads)
        .service(list_uploads)
        .service(upload_content)
        .service(delete_upload)
        .service(bulk_delete_uploads)
        .service(purge_expired)
        .service(get_settings)
        .service(put_settings)
        .service(test_turnstile)
        .service(list_webhooks)
        .service(create_webhook)
        .service(update_webhook)
        .service(delete_webhook)
        .service(test_webhook)
        .service(webhook_deliveries)
        .service(audit_log)
        .service(public_settings);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account_auth::configure_routes as configure_auth_routes;
    use actix_web::http::header::AUTHORIZATION;
    use actix_web::test;
    use actix_web::web::Data;
    use actix_web::App;
    use serde_json::json;
    use std::env;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_test_path(name: &str, suffix: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        env::temp_dir().join(format!("rustypaste-admin-test-{name}-{nanos}{suffix}"))
    }

    fn test_config(upload_path: PathBuf) -> Config {
        let mut config = Config::default();
        config.server.tokens = Some(["seed-token".to_string(), "spare-token".to_string()].into());
        config.server.upload_path = upload_path;
        config
    }

    fn set_auth_test_env(path: &Path) {
        unsafe {
            env::set_var("DB_PATH", path);
            env::set_var("JWT_SECRET", "test-secret");
            env::set_var("AUTH_ADMIN_BEARER", "admin-token");
            env::set_var("TURNSTILE_SECRET_KEY", "");
            env::set_var("PASTE_API", "http://localhost:8080/api");
            env::set_var("VITE_ENABLE_SHAREX", "1");
            env::set_var("PASSKEYS_ENABLED", "1");
            env::remove_var("PASSKEY_RP_ID");
            env::remove_var("PASSKEY_ORIGINS");
            env::remove_var("VITE_TURNSTILE_SITE_KEY");
        }
    }

    fn clear_auth_test_env() {
        unsafe {
            env::remove_var("DB_PATH");
            env::remove_var("JWT_SECRET");
            env::remove_var("AUTH_ADMIN_BEARER");
            env::remove_var("TURNSTILE_SECRET_KEY");
            env::remove_var("PASTE_API");
            env::remove_var("VITE_ENABLE_SHAREX");
            env::remove_var("PASSKEYS_ENABLED");
            env::remove_var("PASSKEY_RP_ID");
            env::remove_var("PASSKEY_ORIGINS");
            env::remove_var("VITE_TURNSTILE_SITE_KEY");
        }
    }

    fn write_sidecar(upload_dir: &Path, file_name: &str, username: &str) -> PathBuf {
        let sidecar = metadata_path(upload_dir, file_name);
        fs::create_dir_all(sidecar.parent().expect("sidecar should have parent"))
            .expect("sidecar dir should be created");
        fs::write(
            &sidecar,
            json!({
                "display_name": file_name,
                "uploader": username,
                "source": "WebUI",
            })
            .to_string(),
        )
        .expect("sidecar should be written");
        sidecar
    }

    macro_rules! claim_admin {
        ($app:expr) => {{
            let claim_init_request = test::TestRequest::post()
                .uri("/auth/admin/claim/init")
                .insert_header((AUTHORIZATION, "Bearer admin-token"))
                .set_json(json!({}))
                .to_request();
            let claim_init_response = test::call_service($app, claim_init_request).await;
            assert_eq!(StatusCode::OK, claim_init_response.status());
            let claim_init_json: Value = test::read_body_json(claim_init_response).await;
            let claim_token = claim_init_json["token"]
                .as_str()
                .expect("claim token should exist")
                .to_string();

            let claim_request = test::TestRequest::post()
                .uri("/auth/admin/claim")
                .set_json(json!({
                    "claim_token": claim_token,
                    "username": "admin",
                    "password": "password123",
                    "upload_token": "seed-token",
                }))
                .to_request();
            let claim_response = test::call_service($app, claim_request).await;
            assert_eq!(StatusCode::OK, claim_response.status());
            let claim_json: Value = test::read_body_json(claim_response).await;
            claim_json["access_token"]
                .as_str()
                .expect("admin jwt should exist")
                .to_string()
        }};
    }

    macro_rules! create_managed_user {
        ($app:expr, $admin_jwt:expr) => {{
            let create_user_request = test::TestRequest::post()
                .uri("/auth/admin/users")
                .insert_header((AUTHORIZATION, format!("Bearer {}", $admin_jwt)))
                .set_json(json!({
                    "username": "managed",
                    "password": "password123",
                    "upload_token": "spare-token",
                }))
                .to_request();
            let create_user_response = test::call_service($app, create_user_request).await;
            assert_eq!(StatusCode::OK, create_user_response.status());
            let create_user_json: Value = test::read_body_json(create_user_response).await;
            create_user_json["upload_token"]
                .as_str()
                .expect("created user should have upload token")
                .to_string()
        }};
    }

    fn write_upload_fixture(upload_root: &Path, username: &str, token: &str) -> (PathBuf, PathBuf) {
        fs::create_dir_all(upload_root).expect("upload root should be created");
        let flat_file = upload_root.join("flat-owned.txt");
        fs::write(&flat_file, "metadata-owned").expect("flat upload should be written");
        write_sidecar(upload_root, "flat-owned.txt", username);

        let token_dir = upload_root.join(token_to_dir_name(token));
        fs::create_dir_all(&token_dir).expect("token dir should be created");
        let sharded_file = token_dir.join("dir-owned.txt");
        fs::write(&sharded_file, "directory-owned").expect("sharded upload should be written");
        (flat_file, sharded_file)
    }

    #[actix_web::test]
    async fn upload_content_allows_an_admin_to_preview_anonymous_uploads() {
        let db_path = unique_test_path("upload-content", ".sqlite");
        let upload_root = unique_test_path("upload-content-uploads", "");
        set_auth_test_env(&db_path);
        fs::create_dir_all(&upload_root).expect("upload root should be created");
        fs::write(upload_root.join("anonymous.txt"), "anonymous content")
            .expect("anonymous upload should be written");

        let app = test::init_service(
            App::new()
                .app_data(Data::new(RwLock::new(test_config(upload_root.clone()))))
                .app_data(Data::new(Client::default()))
                .app_data(Data::new(RateLimiter::new()))
                .service(web::scope("/auth/admin").configure(configure_routes)),
        )
        .await;
        let admin_jwt = claim_admin!(&app);
        let request = test::TestRequest::get()
            .uri("/auth/admin/uploads/content?path=anonymous.txt")
            .insert_header((AUTHORIZATION, format!("Bearer {admin_jwt}")))
            .to_request();
        let response = test::call_service(&app, request).await;

        assert_eq!(StatusCode::OK, response.status());
        assert_eq!(
            String::from_utf8(test::read_body(response).await.to_vec()).unwrap(),
            "anonymous content"
        );

        let _ = fs::remove_dir_all(upload_root);
        let _ = fs::remove_file(db_path);
        clear_auth_test_env();
    }


    #[actix_web::test]
    async fn public_settings_reports_turnstile_runtime_configuration() {
        let db_path = unique_test_path("public-settings", ".sqlite");
        let upload_root = unique_test_path("public-settings-uploads", "");
        set_auth_test_env(&db_path);

        let app = test::init_service(
            App::new()
                .app_data(Data::new(RwLock::new(test_config(upload_root.clone()))))
                .app_data(Data::new(Client::default()))
                .app_data(Data::new(RateLimiter::new()))
                .service(web::scope("/auth/admin").configure(configure_routes)),
        )
        .await;

        macro_rules! read_public_settings {
            () => {{
                let request = test::TestRequest::get()
                    .uri("/auth/admin/public-settings")
                    .to_request();
                let response = test::call_service(&app, request).await;
                assert_eq!(StatusCode::OK, response.status());
                test::read_body_json::<Value, _>(response).await
            }};
        }

        unsafe {
            env::remove_var("TURNSTILE_SECRET_KEY");
            env::remove_var("VITE_TURNSTILE_SITE_KEY");
        }
        let settings = read_public_settings!();
        assert_eq!("", settings["turnstile_site_key"]);
        assert_eq!(false, settings["turnstile_required"]);
        assert!(matches!(
            settings["upload_access_mode"].as_str(),
            Some("private" | "public")
        ));

        unsafe {
            env::set_var("TURNSTILE_SECRET_KEY", "runtime-secret");
            env::remove_var("VITE_TURNSTILE_SITE_KEY");
        }
        // Regression: setting only the runtime backend secret used to require
        // a matching frontend rebuild, otherwise login showed no site key.
        let settings = read_public_settings!();
        assert_eq!("", settings["turnstile_site_key"]);
        assert_eq!(true, settings["turnstile_required"]);

        unsafe {
            env::set_var("TURNSTILE_SECRET_KEY", "runtime-secret");
            env::set_var("VITE_TURNSTILE_SITE_KEY", "site-key");
        }
        let settings = read_public_settings!();
        assert_eq!("site-key", settings["turnstile_site_key"]);
        assert_eq!(true, settings["turnstile_required"]);

        unsafe {
            env::set_var("TURNSTILE_SECRET_KEY", " runtime-secret ");
            env::set_var("VITE_TURNSTILE_SITE_KEY", " abc ");
        }
        let settings = read_public_settings!();
        assert_eq!("abc", settings["turnstile_site_key"]);
        assert_eq!(true, settings["turnstile_required"]);

        let _ = fs::remove_file(db_path);
        let _ = fs::remove_dir_all(upload_root);
        clear_auth_test_env();
    }

    #[actix_web::test]
    async fn uploads_listing_resolves_sidecar_metadata_before_directory_fallback() {
        let db_path = unique_test_path("listing", ".sqlite");
        let upload_root = unique_test_path("listing-uploads", "");
        set_auth_test_env(&db_path);

        let app = test::init_service(
            App::new()
                .app_data(Data::new(RwLock::new(test_config(upload_root.clone()))))
                .app_data(Data::new(Client::default()))
                .app_data(Data::new(RateLimiter::new()))
                .service(web::scope("/auth").configure(configure_auth_routes)),
        )
        .await;
        let admin_jwt = claim_admin!(&app);
        let managed_token = create_managed_user!(&app, &admin_jwt);
        let (_flat_file, _sharded_file) =
            write_upload_fixture(&upload_root, "managed", &managed_token);

        let list_uploads_request = test::TestRequest::get()
            .uri("/auth/admin/uploads")
            .insert_header((AUTHORIZATION, format!("Bearer {admin_jwt}")))
            .to_request();
        let list_response = test::call_service(&app, list_uploads_request).await;
        assert_eq!(StatusCode::OK, list_response.status());
        let uploads: Value = test::read_body_json(list_response).await;
        let uploads = uploads.as_array().expect("uploads should be an array");
        assert_eq!(
            Some("managed"),
            uploads
                .iter()
                .find(|upload| upload["path"] == "flat-owned.txt")
                .and_then(|upload| upload["owner"].as_str())
        );
        assert_eq!(
            Some("managed"),
            uploads
                .iter()
                .find(|upload| upload["path"].as_str().is_some_and(|path| path.ends_with("/dir-owned.txt")))
                .and_then(|upload| upload["owner"].as_str())
        );

        let _ = fs::remove_file(db_path);
        let _ = fs::remove_dir_all(upload_root);
        clear_auth_test_env();
    }

    #[actix_web::test]
    async fn strip_expiry_suffix_recovers_pre_suffix_name() {
        assert_eq!(
            Some("ZSlZjhsX.jpg"),
            strip_expiry_suffix("ZSlZjhsX.jpg.1784356059807")
        );
        assert_eq!(None, strip_expiry_suffix("ZSlZjhsX.jpg"));
        assert_eq!(None, strip_expiry_suffix("no-dot-here"));
    }

    #[actix_web::test]
    async fn uploads_listing_resolves_legacy_pre_suffix_sidecar_metadata() {
        // Simulates an upload made before the metadata sidecar was keyed by
        // the on-disk (expiry-suffixed) file name: the file itself carries
        // the `.<millis>` expiry suffix `stored_file_name` appends, but its
        // `.rpmeta` sidecar was written under the pre-suffix name.
        let db_path = unique_test_path("legacy-listing", ".sqlite");
        let upload_root = unique_test_path("legacy-listing-uploads", "");
        set_auth_test_env(&db_path);

        let app = test::init_service(
            App::new()
                .app_data(Data::new(RwLock::new(test_config(upload_root.clone()))))
                .app_data(Data::new(Client::default()))
                .app_data(Data::new(RateLimiter::new()))
                .service(web::scope("/auth").configure(configure_auth_routes)),
        )
        .await;
        let admin_jwt = claim_admin!(&app);
        let _managed_token = create_managed_user!(&app, &admin_jwt);

        fs::create_dir_all(&upload_root).expect("upload root should be created");
        let on_disk_name = "legacy-expiring.txt.1784356059807";
        fs::write(upload_root.join(on_disk_name), "legacy").expect("legacy upload should be written");
        write_sidecar(&upload_root, "legacy-expiring.txt", "managed");

        let list_uploads_request = test::TestRequest::get()
            .uri("/auth/admin/uploads")
            .insert_header((AUTHORIZATION, format!("Bearer {admin_jwt}")))
            .to_request();
        let list_response = test::call_service(&app, list_uploads_request).await;
        assert_eq!(StatusCode::OK, list_response.status());
        let uploads: Value = test::read_body_json(list_response).await;
        let uploads = uploads.as_array().expect("uploads should be an array");
        assert_eq!(
            Some("managed"),
            uploads
                .iter()
                .find(|upload| upload["path"] == on_disk_name)
                .and_then(|upload| upload["owner"].as_str())
        );

        let _ = fs::remove_file(db_path);
        let _ = fs::remove_dir_all(upload_root);
        clear_auth_test_env();
    }

    #[actix_web::test]
    async fn purge_user_uploads_removes_flat_sidecar_attributed_uploads() {
        let db_path = unique_test_path("purge", ".sqlite");
        let upload_root = unique_test_path("purge-uploads", "");
        set_auth_test_env(&db_path);

        let app = test::init_service(
            App::new()
                .app_data(Data::new(RwLock::new(test_config(upload_root.clone()))))
                .app_data(Data::new(Client::default()))
                .app_data(Data::new(RateLimiter::new()))
                .service(web::scope("/auth").configure(configure_auth_routes)),
        )
        .await;
        let admin_jwt = claim_admin!(&app);
        let managed_token = create_managed_user!(&app, &admin_jwt);
        let (flat_file, _sharded_file) = write_upload_fixture(&upload_root, "managed", &managed_token);
        let flat_sidecar = metadata_path(&upload_root, "flat-owned.txt");

        let purge = test::TestRequest::post()
            .uri("/auth/admin/users/managed/purge")
            .insert_header((AUTHORIZATION, format!("Bearer {admin_jwt}")))
            .set_json(json!({ "confirmation": CONFIRM_PURGE_UPLOADS }))
            .to_request();
        let purge_response = test::call_service(&app, purge).await;
        assert_eq!(StatusCode::OK, purge_response.status());
        assert!(!flat_file.exists());
        assert!(!flat_sidecar.exists());

        let list_uploads_request = test::TestRequest::get()
            .uri("/auth/admin/uploads")
            .insert_header((AUTHORIZATION, format!("Bearer {admin_jwt}")))
            .to_request();
        let list_response = test::call_service(&app, list_uploads_request).await;
        assert_eq!(StatusCode::OK, list_response.status());
        let uploads: Value = test::read_body_json(list_response).await;
        assert!(!uploads
            .as_array()
            .expect("uploads should be an array")
            .iter()
            .any(|upload| upload["path"] == "flat-owned.txt"));

        let _ = fs::remove_file(db_path);
        let _ = fs::remove_dir_all(upload_root);
        clear_auth_test_env();
    }

    #[actix_web::test]
    async fn delete_user_removes_flat_sidecar_attributed_uploads() {
        let db_path = unique_test_path("delete", ".sqlite");
        let upload_root = unique_test_path("delete-uploads", "");
        set_auth_test_env(&db_path);

        let app = test::init_service(
            App::new()
                .app_data(Data::new(RwLock::new(test_config(upload_root.clone()))))
                .app_data(Data::new(Client::default()))
                .app_data(Data::new(RateLimiter::new()))
                .service(web::scope("/auth").configure(configure_auth_routes)),
        )
        .await;
        let admin_jwt = claim_admin!(&app);
        let managed_token = create_managed_user!(&app, &admin_jwt);
        let (flat_file, _sharded_file) = write_upload_fixture(&upload_root, "managed", &managed_token);

        let delete_user_request = test::TestRequest::delete()
            .uri("/auth/admin/users/managed")
            .insert_header((AUTHORIZATION, format!("Bearer {admin_jwt}")))
            .set_json(json!({ "confirmation": CONFIRM_DELETE_USER }))
            .to_request();
        let delete_response = test::call_service(&app, delete_user_request).await;
        assert_eq!(StatusCode::OK, delete_response.status());
        assert!(!flat_file.exists());

        let _ = fs::remove_file(db_path);
        let _ = fs::remove_dir_all(upload_root);
        clear_auth_test_env();
    }

    #[actix_web::test]
    async fn db_users_returns_error_when_schema_is_missing() {
        let connection = Connection::open_in_memory().expect("in-memory db should open");
        assert!(db_users(&connection).is_err());
    }
}
