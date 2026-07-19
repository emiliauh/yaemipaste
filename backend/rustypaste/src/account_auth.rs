use crate::config::{Config, TokenType};
use crate::ratelimit::{client_key, RateLimiter};
use actix_web::http::header::{AUTHORIZATION, CONTENT_DISPOSITION};
use actix_web::{delete, get, post, web, HttpRequest, HttpResponse};
use awc::Client;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use bcrypt::{hash, verify, DEFAULT_COST};
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use rand::{distr::Alphanumeric, Rng};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::env;
use std::path::PathBuf;
use std::sync::RwLock;
use std::time::{SystemTime, UNIX_EPOCH};
use webauthn_rs::prelude::{
    Passkey, PasskeyAuthentication, PasskeyRegistration, PublicKeyCredential,
    RegisterPublicKeyCredential, Url, Uuid, Webauthn, WebauthnBuilder,
};

const TURNSTILE_VERIFY_URL: &str = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

#[derive(Debug, Clone)]
pub(crate) struct AuthEnv {
    pub(crate) db_path: PathBuf,
    pub(crate) jwt_secret: String,
    pub(crate) jwt_ttl_seconds: i64,
    pub(crate) paste_api: String,
    pub(crate) turnstile_secret_key: String,
    pub(crate) admin_bearers: HashSet<String>,
}

impl AuthEnv {
    pub(crate) fn from_env() -> Self {
        let db_path = PathBuf::from(
            env::var("DB_PATH").unwrap_or_else(|_| "/var/lib/rustypaste-auth/users.db".to_string()),
        );
        let jwt_secret =
            env::var("JWT_SECRET").unwrap_or_else(|_| "change-me-in-production".to_string());
        let jwt_ttl_seconds = env::var("JWT_TTL_SECONDS")
            .ok()
            .and_then(|value| value.parse::<i64>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(60 * 60 * 24 * 30);
        let paste_api =
            env::var("PASTE_API").unwrap_or_else(|_| "http://localhost:8000".to_string());
        let turnstile_secret_key = env::var("TURNSTILE_SECRET_KEY").unwrap_or_default();
        let admin_bearers = env::var("AUTH_ADMIN_BEARER")
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .collect();
        Self {
            db_path,
            jwt_secret,
            jwt_ttl_seconds,
            paste_api,
            turnstile_secret_key,
            admin_bearers,
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct Claims {
    sub: String,
    exp: usize,
}

#[derive(Debug, Deserialize)]
struct RegisterRequest {
    username: String,
    password: String,
    token: String,
}

#[derive(Debug, Deserialize)]
struct LoginRequest {
    username: String,
    password: String,
    #[serde(default)]
    turnstile_token: String,
}

#[derive(Debug, Deserialize)]
struct TokenStatusRequest {
    token: String,
}

#[derive(Debug, Deserialize)]
struct PasskeyCredentialBody {
    credential: Value,
}

#[derive(Debug, Deserialize)]
struct PasskeyAuthBeginRequest {
    username: String,
}

#[derive(Debug, Deserialize)]
struct PasskeyAuthFinishRequest {
    username: String,
    credential: Value,
}

#[derive(Debug, Deserialize)]
struct AdminBootstrapRequest {
    username: String,
    password: String,
    #[serde(default)]
    token: String,
}

#[derive(Debug, Deserialize)]
struct AdminCreateTokenRequest {
    #[serde(default)]
    label: String,
    ttl_seconds: Option<i64>,
}

#[derive(Serialize)]
struct TurnstileRequest<'a> {
    secret: &'a str,
    response: &'a str,
}

#[derive(Debug, Deserialize)]
struct TurnstileResponse {
    success: bool,
}

#[derive(Debug)]
struct StoredPasskey {
    id: i64,
    passkey: Passkey,
}

pub(crate) fn now_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs() as i64)
        .unwrap_or(0)
}

pub(crate) fn normalize_username(value: &str) -> String {
    value.trim().to_lowercase()
}

pub(crate) fn json_error(status: actix_web::http::StatusCode, detail: &str) -> HttpResponse {
    let code = match status {
        actix_web::http::StatusCode::BAD_REQUEST => "bad_request",
        actix_web::http::StatusCode::UNAUTHORIZED => "unauthorized",
        actix_web::http::StatusCode::FORBIDDEN => "forbidden",
        actix_web::http::StatusCode::NOT_FOUND => "not_found",
        actix_web::http::StatusCode::CONFLICT => "conflict",
        actix_web::http::StatusCode::TOO_MANY_REQUESTS => "rate_limited",
        _ if status.is_server_error() => "server_error",
        _ => "request_failed",
    };
    HttpResponse::build(status).json(json!({ "code": code, "detail": detail }))
}

fn ensure_column(
    connection: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> rusqlite::Result<()> {
    let pragma = format!("PRAGMA table_info({table})");
    let mut statement = connection.prepare(&pragma)?;
    let rows = statement.query_map([], |row| row.get::<_, String>(1))?;
    let mut exists = false;
    for row in rows {
        if row.as_deref().ok() == Some(column) {
            exists = true;
            break;
        }
    }
    if !exists {
        let alter = format!("ALTER TABLE {table} ADD COLUMN {column} {definition}");
        connection.execute(&alter, [])?;
    }
    Ok(())
}

pub(crate) fn init_db(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            token TEXT UNIQUE NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS passkeys (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            credential_id TEXT UNIQUE NOT NULL,
            public_key BLOB NOT NULL,
            sign_count INTEGER NOT NULL DEFAULT 0,
            transports TEXT,
            created_at INTEGER NOT NULL,
            last_used_at INTEGER,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_passkeys_user_id ON passkeys(user_id);
        CREATE TABLE IF NOT EXISTS registration_tokens (
            token TEXT PRIMARY KEY,
            label TEXT,
            created_at INTEGER NOT NULL,
            expires_at INTEGER,
            revoked_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS revoked_tokens (
            token TEXT PRIMARY KEY,
            revoked_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS admin_claims (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            token_hash TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            expires_at INTEGER,
            used_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at INTEGER NOT NULL,
            actor TEXT,
            action TEXT NOT NULL,
            target TEXT,
            status TEXT NOT NULL,
            reason TEXT
        );
        CREATE TABLE IF NOT EXISTS admin_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            updated_by TEXT
        );
        CREATE TABLE IF NOT EXISTS webhooks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            url TEXT NOT NULL,
            events TEXT NOT NULL,
            secret_hash TEXT,
            secret_preview TEXT,
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            updated_by TEXT
        );
        CREATE TABLE IF NOT EXISTS webhook_deliveries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            webhook_id INTEGER,
            event TEXT NOT NULL,
            payload TEXT NOT NULL,
            status TEXT NOT NULL,
            status_code INTEGER,
            error TEXT,
            created_at INTEGER NOT NULL,
            delivered_at INTEGER,
            FOREIGN KEY(webhook_id) REFERENCES webhooks(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);
        CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_created_at ON webhook_deliveries(created_at);
        "#,
    )?;
    ensure_column(connection, "users", "passkey_user_uuid", "TEXT")?;
    ensure_column(connection, "users", "passkey_reg_state", "TEXT")?;
    ensure_column(connection, "users", "passkey_auth_state", "TEXT")?;
    ensure_column(
        connection,
        "users",
        "is_admin",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(connection, "users", "suspended_at", "INTEGER")?;
    ensure_column(connection, "users", "suspended_reason", "TEXT")?;
    ensure_column(connection, "passkeys", "passkey_data", "TEXT")?;
    Ok(())
}

pub(crate) fn open_db(path: &PathBuf) -> Result<Connection, HttpResponse> {
    if let Some(parent) = path.parent() {
        if let Err(error) = std::fs::create_dir_all(parent) {
            error!("cannot create auth db directory: {}", error);
            return Err(json_error(
                actix_web::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Auth storage unavailable",
            ));
        }
    }
    let connection = Connection::open(path).map_err(|error| {
        error!("cannot open auth db: {}", error);
        json_error(
            actix_web::http::StatusCode::INTERNAL_SERVER_ERROR,
            "Auth storage unavailable",
        )
    })?;
    init_db(&connection).map_err(|error| {
        error!("cannot initialize auth db: {}", error);
        json_error(
            actix_web::http::StatusCode::INTERNAL_SERVER_ERROR,
            "Auth storage unavailable",
        )
    })?;
    Ok(connection)
}

pub(crate) fn configured_tokens(config: &Config) -> Option<HashSet<String>> {
    config.get_tokens(TokenType::Auth)
}

pub(crate) fn create_jwt(
    secret: &str,
    ttl_seconds: i64,
    username: &str,
) -> Result<String, HttpResponse> {
    let exp = now_seconds()
        .checked_add(ttl_seconds)
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| {
            json_error(
                actix_web::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Could not create session token",
            )
        })?;
    encode(
        &Header::new(Algorithm::HS256),
        &Claims {
            sub: username.to_string(),
            exp,
        },
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|error| {
        error!("cannot sign jwt: {}", error);
        json_error(
            actix_web::http::StatusCode::INTERNAL_SERVER_ERROR,
            "Could not create session token",
        )
    })
}

pub(crate) fn bearer_token(request: &HttpRequest) -> Option<String> {
    request
        .headers()
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

pub(crate) fn current_user(request: &HttpRequest, secret: &str) -> Result<String, HttpResponse> {
    let bearer = bearer_token(request)
        .ok_or_else(|| json_error(actix_web::http::StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let mut validation = Validation::new(Algorithm::HS256);
    validation.validate_exp = true;

    decode::<Claims>(
        &bearer,
        &DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )
    .map(|value| value.claims.sub)
    .map_err(|error| {
        use jsonwebtoken::errors::ErrorKind;
        let detail = if matches!(error.kind(), ErrorKind::ExpiredSignature) {
            "Token expired"
        } else {
            "Invalid token"
        };
        json_error(actix_web::http::StatusCode::UNAUTHORIZED, detail)
    })
}

pub(crate) fn require_admin(request: &HttpRequest, auth_env: &AuthEnv) -> Result<(), HttpResponse> {
    if auth_env.admin_bearers.is_empty() {
        return Err(json_error(
            actix_web::http::StatusCode::FORBIDDEN,
            "Admin operations are disabled",
        ));
    }
    let Some(token) = bearer_token(request) else {
        return Err(json_error(
            actix_web::http::StatusCode::UNAUTHORIZED,
            "Missing admin token",
        ));
    };
    if !auth_env.admin_bearers.contains(&token) {
        return Err(json_error(
            actix_web::http::StatusCode::UNAUTHORIZED,
            "Invalid admin token",
        ));
    }
    Ok(())
}

fn is_token_used(connection: &Connection, token: &str) -> bool {
    connection
        .query_row(
            "SELECT 1 FROM users WHERE token=?1",
            params![token],
            |_row| Ok(true),
        )
        .ok()
        .unwrap_or(false)
}

fn is_token_revoked(connection: &Connection, token: &str) -> bool {
    connection
        .query_row(
            "SELECT 1 FROM revoked_tokens WHERE token=?1",
            params![token],
            |_row| Ok(true),
        )
        .ok()
        .unwrap_or(false)
}

fn is_registration_token_valid(connection: &Connection, token: &str) -> bool {
    let now = now_seconds();
    connection
        .query_row(
            "SELECT expires_at, revoked_at FROM registration_tokens WHERE token=?1",
            params![token],
            |row| Ok((row.get::<_, Option<i64>>(0)?, row.get::<_, Option<i64>>(1)?)),
        )
        .optional()
        .ok()
        .flatten()
        .is_some_and(|(expires_at, revoked_at)| {
            revoked_at.is_none() && expires_at.is_none_or(|value| value > now)
        })
}

fn is_registration_token_known(connection: &Connection, token: &str) -> bool {
    connection
        .query_row(
            "SELECT 1 FROM registration_tokens WHERE token=?1",
            params![token],
            |_row| Ok(true),
        )
        .ok()
        .unwrap_or(false)
}

fn token_allowed_for_register(
    connection: &Connection,
    configured: Option<&HashSet<String>>,
    token: &str,
) -> bool {
    if token.trim().is_empty() {
        return false;
    }
    if is_token_revoked(connection, token) {
        return false;
    }
    if let Some(tokens) = configured {
        return tokens.contains(token);
    }
    if is_registration_token_known(connection, token) {
        return is_registration_token_valid(connection, token);
    }
    true
}

fn token_status_value(
    connection: &Connection,
    configured: Option<&HashSet<String>>,
    token: &str,
) -> &'static str {
    if is_token_used(connection, token) {
        return "used";
    }
    if is_token_revoked(connection, token) {
        return "invalid";
    }
    if let Some(tokens) = configured {
        if !tokens.contains(token) {
            return "invalid";
        }
        return "available";
    }
    if is_registration_token_known(connection, token)
        && !is_registration_token_valid(connection, token)
    {
        return "invalid";
    }
    "available"
}

fn insert_user(
    connection: &Connection,
    username: &str,
    password: &str,
    token: &str,
) -> Result<(), HttpResponse> {
    let password_hash = hash(password, DEFAULT_COST).map_err(|error| {
        error!("cannot hash password: {}", error);
        json_error(
            actix_web::http::StatusCode::INTERNAL_SERVER_ERROR,
            "Could not create account",
        )
    })?;
    let created_at = now_seconds();
    connection
        .execute(
            "INSERT INTO users (username, password, token, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![username, password_hash, token, created_at],
        )
        .map_err(|error| {
            let detail = match error {
                rusqlite::Error::SqliteFailure(_, Some(message))
                    if message.contains("username") =>
                {
                    "Username already taken"
                }
                rusqlite::Error::SqliteFailure(_, Some(message)) if message.contains("token") => {
                    "Token already used"
                }
                _ => {
                    error!("cannot insert user: {}", error);
                    "Could not create account"
                }
            };
            json_error(actix_web::http::StatusCode::BAD_REQUEST, detail)
        })?;
    Ok(())
}

fn generate_registration_token() -> String {
    rand::rng()
        .sample_iter(&Alphanumeric)
        .take(48)
        .map(char::from)
        .collect()
}

fn store_registration_token(
    connection: &Connection,
    token: &str,
    label: &str,
    ttl_seconds: Option<i64>,
) -> Result<(), HttpResponse> {
    let now = now_seconds();
    let expires_at = ttl_seconds
        .filter(|value| *value > 0)
        .and_then(|value| now.checked_add(value));
    connection
        .execute(
            "INSERT OR REPLACE INTO registration_tokens (token, label, created_at, expires_at, revoked_at) VALUES (?1, ?2, ?3, ?4, NULL)",
            params![token, label, now, expires_at],
        )
        .map_err(|error| {
            error!("cannot store registration token: {}", error);
            json_error(
                actix_web::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Could not store token",
            )
        })?;
    Ok(())
}

fn next_available_configured_token(
    connection: &Connection,
    configured: &HashSet<String>,
) -> Option<String> {
    let mut candidates: Vec<String> = configured.iter().cloned().collect();
    candidates.sort();
    candidates
        .into_iter()
        .find(|token| !is_token_used(connection, token) && !is_token_revoked(connection, token))
}

fn parse_bool_env(key: &str, default: bool) -> bool {
    env::var(key)
        .ok()
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(default)
}

fn passkeys_enabled() -> bool {
    parse_bool_env("PASSKEYS_ENABLED", false)
}

fn sharex_enabled() -> bool {
    env::var("SHAREX_ENABLED")
        .ok()
        .or_else(|| env::var("VITE_ENABLE_SHAREX").ok())
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(true)
}

fn passkeys_disabled_response() -> HttpResponse {
    json_error(
        actix_web::http::StatusCode::BAD_REQUEST,
        "Passkeys are disabled",
    )
}

fn sharex_disabled_response() -> HttpResponse {
    json_error(
        actix_web::http::StatusCode::BAD_REQUEST,
        "ShareX support is disabled",
    )
}

fn build_webauthn() -> Result<Webauthn, HttpResponse> {
    let fallback_origin =
        env::var("PASTE_URL").unwrap_or_else(|_| "http://localhost:8080".to_string());
    let origins_value = env::var("PASSKEY_ORIGINS")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| {
            format!("{fallback_origin},http://localhost:5173,http://127.0.0.1:5173")
        });

    let mut origins = origins_value
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(Url::parse)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| {
            json_error(
                actix_web::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Invalid passkey origin configuration",
            )
        })?;

    if origins.is_empty() {
        origins.push(Url::parse("http://localhost:8080").map_err(|_| {
            json_error(
                actix_web::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Invalid passkey origin configuration",
            )
        })?);
    }

    let default_rp_id = origins
        .first()
        .and_then(|origin| origin.host_str().map(str::to_string))
        .unwrap_or_else(|| "localhost".to_string());
    let rp_id = env::var("PASSKEY_RP_ID").unwrap_or(default_rp_id);
    let rp_name = env::var("PASSKEY_RP_NAME").unwrap_or_else(|_| "yaemipaste".to_string());

    let mut builder = WebauthnBuilder::new(&rp_id, &origins[0]).map_err(|_| {
        json_error(
            actix_web::http::StatusCode::INTERNAL_SERVER_ERROR,
            "Invalid passkey RP configuration",
        )
    })?;
    builder = builder.rp_name(&rp_name);
    builder = builder.allow_any_port(parse_bool_env("PASSKEY_ALLOW_ANY_PORT", false));
    builder = builder.allow_subdomains(parse_bool_env("PASSKEY_ALLOW_SUBDOMAINS", false));
    for origin in origins.iter().skip(1) {
        builder = builder.append_allowed_origin(origin);
    }
    builder.build().map_err(|_| {
        json_error(
            actix_web::http::StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to initialize passkey runtime",
        )
    })
}

fn load_user_passkeys(
    connection: &Connection,
    user_id: i64,
) -> Result<Vec<StoredPasskey>, HttpResponse> {
    let mut statement = connection
        .prepare("SELECT id, passkey_data FROM passkeys WHERE user_id=?1 ORDER BY created_at DESC")
        .map_err(|error| {
            error!("cannot load passkeys: {}", error);
            json_error(
                actix_web::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Could not load passkeys",
            )
        })?;
    let rows = statement
        .query_map(params![user_id], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .map_err(|error| {
            error!("cannot query passkeys: {}", error);
            json_error(
                actix_web::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Could not load passkeys",
            )
        })?;

    let mut passkeys = Vec::new();
    for row in rows {
        let (id, passkey_data) = row.map_err(|error| {
            error!("cannot decode passkey row: {}", error);
            json_error(
                actix_web::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Could not load passkeys",
            )
        })?;
        let Some(passkey_data) = passkey_data else {
            continue;
        };
        let passkey = serde_json::from_str::<Passkey>(&passkey_data).map_err(|error| {
            error!("cannot decode stored passkey: {}", error);
            json_error(
                actix_web::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Stored passkeys are malformed",
            )
        })?;
        passkeys.push(StoredPasskey { id, passkey });
    }
    Ok(passkeys)
}

fn count_legacy_passkeys(connection: &Connection, user_id: i64) -> i64 {
    connection
        .query_row(
            "SELECT COUNT(*) FROM passkeys WHERE user_id=?1 AND TRIM(COALESCE(passkey_data, ''))=''",
            params![user_id],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0)
}

fn extract_transports(credential: &Value) -> Option<String> {
    let transports = credential
        .get("response")
        .and_then(|value| value.get("transports"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<String>>()
        })
        .unwrap_or_default();
    if transports.is_empty() {
        None
    } else {
        serde_json::to_string(&transports).ok()
    }
}

pub(crate) async fn verify_turnstile(client: &Client, secret: &str, token: &str) -> bool {
    if secret.trim().is_empty() {
        return true;
    }
    if token.trim().is_empty() {
        return false;
    }
    let mut response = match client
        .post(TURNSTILE_VERIFY_URL)
        .send_form(&TurnstileRequest {
            secret,
            response: token,
        })
        .await
    {
        Ok(response) => response,
        Err(error) => {
            warn!("turnstile request failed: {}", error);
            return false;
        }
    };
    match response.json::<TurnstileResponse>().await {
        Ok(body) => body.success,
        Err(error) => {
            warn!("turnstile response decode failed: {}", error);
            false
        }
    }
}

#[post("/register")]
async fn register(
    body: web::Json<RegisterRequest>,
    config: web::Data<RwLock<Config>>,
) -> HttpResponse {
    let username = normalize_username(&body.username);
    if username.len() < 2 {
        return json_error(
            actix_web::http::StatusCode::BAD_REQUEST,
            "Username too short",
        );
    }
    if body.password.len() < 6 {
        return json_error(
            actix_web::http::StatusCode::BAD_REQUEST,
            "Password must be at least 6 characters",
        );
    }
    let token = body.token.trim();
    if token.is_empty() {
        return json_error(
            actix_web::http::StatusCode::BAD_REQUEST,
            "Token is required",
        );
    }
    let configured = match config.read() {
        Ok(config) => configured_tokens(&config),
        Err(_) => {
            return json_error(
                actix_web::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Configuration unavailable",
            );
        }
    };
    let auth_env = AuthEnv::from_env();
    let connection = match open_db(&auth_env.db_path) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    if !crate::admin::registration_enabled(&connection) {
        return json_error(
            actix_web::http::StatusCode::FORBIDDEN,
            "Registration is disabled",
        );
    }
    if !token_allowed_for_register(&connection, configured.as_ref(), token) {
        return json_error(
            actix_web::http::StatusCode::BAD_REQUEST,
            "Invalid or unrecognised token",
        );
    }
    match insert_user(&connection, &username, &body.password, token) {
        Ok(_) => HttpResponse::Ok().json(json!({ "detail": "Account created" })),
        Err(response) => response,
    }
}

#[post("/login")]
async fn login(
    request: HttpRequest,
    limiter: web::Data<RateLimiter>,
    body: web::Json<LoginRequest>,
    client: web::Data<Client>,
    auth_config: web::Data<RwLock<Config>>,
) -> HttpResponse {
    if !limiter.check(
        &format!("login:{}", client_key(&request)),
        10,
        std::time::Duration::from_secs(60),
    ) {
        return json_error(
            actix_web::http::StatusCode::TOO_MANY_REQUESTS,
            "Too many login attempts",
        );
    }
    let auth_env = AuthEnv::from_env();
    let connection = match open_db(&auth_env.db_path) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    let settings = crate::admin::setting_map(&connection).unwrap_or_default();
    let turnstile_enabled = settings.get("turnstile_enabled").map(String::as_str) == Some("true");
    let turnstile_secret = settings.get("turnstile_secret_key").map(String::as_str).unwrap_or(&auth_env.turnstile_secret_key);
    if turnstile_enabled && !verify_turnstile(&client, turnstile_secret, &body.turnstile_token).await {
        return json_error(actix_web::http::StatusCode::BAD_REQUEST, "Security check failed");
    }
    let username = normalize_username(&body.username);
    let row = connection
        .query_row(
            "SELECT username, password, token, is_admin, suspended_at FROM users WHERE username=?1",
            params![username],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, Option<i64>>(4)?,
                ))
            },
        )
        .ok();
    let Some((db_username, db_password, db_token, is_admin, suspended_at)) = row else {
        return json_error(
            actix_web::http::StatusCode::UNAUTHORIZED,
            "Invalid credentials",
        );
    };
    let password_ok = verify(&body.password, &db_password).unwrap_or(false);
    if !password_ok {
        return json_error(
            actix_web::http::StatusCode::UNAUTHORIZED,
            "Invalid credentials",
        );
    }
    if suspended_at.is_some() {
        return json_error(
            actix_web::http::StatusCode::FORBIDDEN,
            "Account is suspended",
        );
    }

    let configured = match auth_config.read() {
        Ok(config) => configured_tokens(&config),
        Err(_) => {
            return json_error(
                actix_web::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Configuration unavailable",
            );
        }
    };
    let token_valid_for_login = !is_token_revoked(&connection, &db_token)
        && configured
            .as_ref()
            .is_none_or(|tokens| tokens.contains(&db_token));
    if !token_valid_for_login {
        return json_error(
            actix_web::http::StatusCode::UNAUTHORIZED,
            "Invalid credentials",
        );
    }

    if is_admin == 1 {
        crate::admin::audit(
            &connection,
            Some(&db_username),
            "admin.login",
            None,
            "success",
            None,
        );
    }
    let jwt = match create_jwt(&auth_env.jwt_secret, auth_env.jwt_ttl_seconds, &db_username) {
        Ok(token) => token,
        Err(response) => return response,
    };
    HttpResponse::Ok().json(json!({
        "access_token": jwt,
        "paste_token": db_token,
        "username": db_username,
        "is_admin": is_admin == 1,
    }))
}

#[post("/token/status")]
async fn token_status(
    body: web::Json<TokenStatusRequest>,
    config: web::Data<RwLock<Config>>,
) -> HttpResponse {
    let token = body.token.trim();
    if token.is_empty() {
        return json_error(
            actix_web::http::StatusCode::BAD_REQUEST,
            "Token is required",
        );
    }
    let configured = match config.read() {
        Ok(config) => configured_tokens(&config),
        Err(_) => {
            return json_error(
                actix_web::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Configuration unavailable",
            );
        }
    };
    let auth_env = AuthEnv::from_env();
    let connection = match open_db(&auth_env.db_path) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    HttpResponse::Ok()
        .json(json!({ "status": token_status_value(&connection, configured.as_ref(), token) }))
}

#[get("/me")]
async fn me(request: HttpRequest) -> HttpResponse {
    let auth_env = AuthEnv::from_env();
    let username = match current_user(&request, &auth_env.jwt_secret) {
        Ok(username) => username,
        Err(response) => return response,
    };
    let connection = match open_db(&auth_env.db_path) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    let row = connection
        .query_row(
            "SELECT username, created_at, is_admin, suspended_at, suspended_reason FROM users WHERE username=?1",
            params![username],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?, row.get::<_, Option<i64>>(3)?, row.get::<_, Option<String>>(4)?)),
        )
        .optional()
        .ok()
        .flatten();
    match row {
        Some((username, created_at, is_admin, suspended_at, suspended_reason)) => {
            if suspended_at.is_some() {
                return json_error(
                    actix_web::http::StatusCode::FORBIDDEN,
                    "Account is suspended",
                );
            }
            HttpResponse::Ok().json(json!({ "username": username, "created_at": created_at, "is_admin": is_admin == 1, "suspended_at": suspended_at, "suspended_reason": suspended_reason }))
        }
        None => json_error(actix_web::http::StatusCode::NOT_FOUND, "User not found"),
    }
}

#[get("/sharex")]
async fn sharex(request: HttpRequest) -> HttpResponse {
    if !sharex_enabled() {
        return sharex_disabled_response();
    }
    let auth_env = AuthEnv::from_env();
    let username = match current_user(&request, &auth_env.jwt_secret) {
        Ok(username) => username,
        Err(response) => return response,
    };
    let connection = match open_db(&auth_env.db_path) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    let token = match connection
        .query_row(
            "SELECT token FROM users WHERE username=?1",
            params![username.clone()],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .ok()
        .flatten()
    {
        Some(value) => value,
        None => return json_error(actix_web::http::StatusCode::NOT_FOUND, "User not found"),
    };
    let request_url = if auth_env.paste_api.ends_with('/') {
        auth_env.paste_api
    } else {
        format!("{}/", auth_env.paste_api)
    };
    let body = json!({
        "Version": "15.0.0",
        "Name": format!("yaemipaste ({})", username),
        "DestinationType": "ImageUploader, FileUploader, TextUploader",
        "RequestMethod": "POST",
        "RequestURL": request_url,
        "Headers": { "Authorization": token },
        "Body": "MultipartFormData",
        "FileFormName": "file",
        "URL": "{regex:^(.+)$|1}",
        "ThumbnailURL": "",
        "DeletionURL": "",
        "ErrorMessage": "{response}",
    });
    HttpResponse::Ok()
        .append_header((
            CONTENT_DISPOSITION,
            "attachment; filename=\"yaemipaste.sxcu\"",
        ))
        .json(body)
}

#[get("/passkeys")]
async fn list_passkeys(request: HttpRequest) -> HttpResponse {
    if !passkeys_enabled() {
        return passkeys_disabled_response();
    }
    let auth_env = AuthEnv::from_env();
    let username = match current_user(&request, &auth_env.jwt_secret) {
        Ok(username) => username,
        Err(response) => return response,
    };
    let connection = match open_db(&auth_env.db_path) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    let user_id = match connection
        .query_row(
            "SELECT id FROM users WHERE username=?1",
            params![username],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .ok()
        .flatten()
    {
        Some(value) => value,
        None => return json_error(actix_web::http::StatusCode::NOT_FOUND, "User not found"),
    };
    let mut stmt = match connection.prepare(
        "SELECT id, credential_id, created_at, last_used_at, transports FROM passkeys WHERE user_id=?1 ORDER BY created_at DESC",
    ) {
        Ok(stmt) => stmt,
        Err(error) => {
            error!("cannot read passkeys: {}", error);
            return json_error(
                actix_web::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Could not load passkeys",
            );
        }
    };
    let rows = match stmt.query_map(params![user_id], |row| {
        let transports: Option<String> = row.get(4)?;
        let transports_json = transports
            .as_deref()
            .and_then(|value| serde_json::from_str::<Value>(value).ok())
            .unwrap_or_else(|| json!([]));
        Ok(json!({
            "id": row.get::<_, i64>(0)?,
            "credential_id": row.get::<_, String>(1)?,
            "created_at": row.get::<_, i64>(2)?,
            "last_used_at": row.get::<_, Option<i64>>(3)?,
            "transports": transports_json,
        }))
    }) {
        Ok(rows) => rows,
        Err(error) => {
            error!("cannot map passkeys: {}", error);
            return json_error(
                actix_web::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Could not load passkeys",
            );
        }
    };
    let mut items = Vec::new();
    for row in rows {
        if let Ok(item) = row {
            items.push(item);
        }
    }
    HttpResponse::Ok().json(items)
}

#[post("/passkeys/register/begin")]
async fn passkey_register_begin(request: HttpRequest) -> HttpResponse {
    if !passkeys_enabled() {
        return passkeys_disabled_response();
    }
    let auth_env = AuthEnv::from_env();
    let username = match current_user(&request, &auth_env.jwt_secret) {
        Ok(username) => username,
        Err(response) => return response,
    };
    let webauthn = match build_webauthn() {
        Ok(webauthn) => webauthn,
        Err(response) => return response,
    };
    let connection = match open_db(&auth_env.db_path) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    let user_row = connection
        .query_row(
            "SELECT id, passkey_user_uuid FROM users WHERE username=?1",
            params![username.clone()],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()
        .ok()
        .flatten();
    let Some((user_id, user_uuid_raw)) = user_row else {
        return json_error(actix_web::http::StatusCode::NOT_FOUND, "User not found");
    };
    let user_uuid = match user_uuid_raw.as_ref() {
        Some(value) if !value.trim().is_empty() => {
            Uuid::parse_str(value).unwrap_or_else(|_| Uuid::new_v4())
        }
        _ => Uuid::new_v4(),
    };
    if user_uuid_raw
        .as_ref()
        .is_none_or(|value| value.trim().is_empty() || Uuid::parse_str(value).is_err())
    {
        let _ = connection.execute(
            "UPDATE users SET passkey_user_uuid=?1 WHERE id=?2",
            params![user_uuid.to_string(), user_id],
        );
    }

    let stored_passkeys = match load_user_passkeys(&connection, user_id) {
        Ok(values) => values,
        Err(response) => return response,
    };
    let existing_ids = stored_passkeys
        .iter()
        .map(|value| value.passkey.cred_id().clone())
        .collect::<Vec<_>>();

    let (challenge, state) = match webauthn.start_passkey_registration(
        user_uuid,
        &username,
        &username,
        if existing_ids.is_empty() {
            None
        } else {
            Some(existing_ids)
        },
    ) {
        Ok(value) => value,
        Err(error) => {
            error!("cannot start passkey registration: {}", error);
            return json_error(
                actix_web::http::StatusCode::BAD_REQUEST,
                "Could not start passkey registration",
            );
        }
    };

    let state_json = match serde_json::to_string(&state) {
        Ok(value) => value,
        Err(error) => {
            error!("cannot serialize passkey registration state: {}", error);
            return json_error(
                actix_web::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Could not start passkey registration",
            );
        }
    };
    if connection
        .execute(
            "UPDATE users SET passkey_reg_state=?1 WHERE id=?2",
            params![state_json, user_id],
        )
        .is_err()
    {
        return json_error(
            actix_web::http::StatusCode::INTERNAL_SERVER_ERROR,
            "Could not start passkey registration",
        );
    }
    HttpResponse::Ok().json(challenge)
}

#[post("/passkeys/register/finish")]
async fn passkey_register_finish(
    request: HttpRequest,
    body: web::Json<PasskeyCredentialBody>,
) -> HttpResponse {
    if !passkeys_enabled() {
        return passkeys_disabled_response();
    }
    let auth_env = AuthEnv::from_env();
    let username = match current_user(&request, &auth_env.jwt_secret) {
        Ok(username) => username,
        Err(response) => return response,
    };
    let webauthn = match build_webauthn() {
        Ok(webauthn) => webauthn,
        Err(response) => return response,
    };
    let connection = match open_db(&auth_env.db_path) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    let user_row = connection
        .query_row(
            "SELECT id, passkey_reg_state FROM users WHERE username=?1",
            params![username],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()
        .ok()
        .flatten();
    let Some((user_id, passkey_reg_state)) = user_row else {
        return json_error(actix_web::http::StatusCode::NOT_FOUND, "User not found");
    };
    let Some(passkey_reg_state) = passkey_reg_state else {
        return json_error(
            actix_web::http::StatusCode::BAD_REQUEST,
            "Passkey registration was not started",
        );
    };
    let state = match serde_json::from_str::<PasskeyRegistration>(&passkey_reg_state) {
        Ok(state) => state,
        Err(error) => {
            error!("cannot decode passkey registration state: {}", error);
            return json_error(
                actix_web::http::StatusCode::BAD_REQUEST,
                "Passkey registration state expired",
            );
        }
    };
    let credential =
        match serde_json::from_value::<RegisterPublicKeyCredential>(body.credential.clone()) {
            Ok(credential) => credential,
            Err(error) => {
                error!("cannot decode registration credential: {}", error);
                return json_error(
                    actix_web::http::StatusCode::BAD_REQUEST,
                    "Invalid passkey registration payload",
                );
            }
        };
    let passkey = match webauthn.finish_passkey_registration(&credential, &state) {
        Ok(passkey) => passkey,
        Err(error) => {
            error!("cannot finish passkey registration: {}", error);
            return json_error(
                actix_web::http::StatusCode::BAD_REQUEST,
                "Passkey registration failed",
            );
        }
    };
    let passkey_json = match serde_json::to_string(&passkey) {
        Ok(value) => value,
        Err(error) => {
            error!("cannot serialize passkey: {}", error);
            return json_error(
                actix_web::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Could not register passkey",
            );
        }
    };
    let credential_id = URL_SAFE_NO_PAD.encode(passkey.cred_id().as_ref());
    let transports = extract_transports(&body.credential);
    let now = now_seconds();
    let insert_result = connection.execute(
        "INSERT INTO passkeys (user_id, credential_id, public_key, sign_count, transports, created_at, last_used_at, passkey_data) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7)",
        params![
            user_id,
            credential_id,
            Vec::<u8>::new(),
            0_i64,
            transports,
            now,
            passkey_json
        ],
    );
    if let Err(error) = insert_result {
        let detail = match error {
            rusqlite::Error::SqliteFailure(_, Some(message))
                if message.contains("credential_id") =>
            {
                "This passkey is already registered"
            }
            _ => {
                error!("cannot store passkey: {}", error);
                "Could not register passkey"
            }
        };
        return json_error(actix_web::http::StatusCode::BAD_REQUEST, detail);
    }
    let _ = connection.execute(
        "UPDATE users SET passkey_reg_state=NULL WHERE id=?1",
        params![user_id],
    );
    HttpResponse::Ok().json(json!({ "detail": "Passkey added" }))
}

#[delete("/passkeys/{passkey_id}")]
async fn passkey_delete(request: HttpRequest, passkey_id: web::Path<i64>) -> HttpResponse {
    if !passkeys_enabled() {
        return passkeys_disabled_response();
    }
    let auth_env = AuthEnv::from_env();
    let username = match current_user(&request, &auth_env.jwt_secret) {
        Ok(username) => username,
        Err(response) => return response,
    };
    let connection = match open_db(&auth_env.db_path) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    let user_id = match connection
        .query_row(
            "SELECT id FROM users WHERE username=?1",
            params![username],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .ok()
        .flatten()
    {
        Some(value) => value,
        None => return json_error(actix_web::http::StatusCode::NOT_FOUND, "User not found"),
    };
    let deleted = connection
        .execute(
            "DELETE FROM passkeys WHERE id=?1 AND user_id=?2",
            params![passkey_id.into_inner(), user_id],
        )
        .unwrap_or(0);
    if deleted == 0 {
        return json_error(actix_web::http::StatusCode::NOT_FOUND, "Passkey not found");
    }
    HttpResponse::Ok().json(json!({ "detail": "Passkey removed" }))
}

#[post("/passkeys/auth/begin")]
async fn passkey_auth_begin(body: web::Json<PasskeyAuthBeginRequest>) -> HttpResponse {
    if !passkeys_enabled() {
        return passkeys_disabled_response();
    }
    let username = normalize_username(&body.username);
    if username.is_empty() {
        return json_error(
            actix_web::http::StatusCode::BAD_REQUEST,
            "Username is required",
        );
    }
    let webauthn = match build_webauthn() {
        Ok(webauthn) => webauthn,
        Err(response) => return response,
    };
    let auth_env = AuthEnv::from_env();
    let connection = match open_db(&auth_env.db_path) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    let user_id = match connection
        .query_row(
            "SELECT id FROM users WHERE username=?1",
            params![username],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .ok()
        .flatten()
    {
        Some(value) => value,
        None => {
            return json_error(
                actix_web::http::StatusCode::UNAUTHORIZED,
                "Invalid credentials",
            )
        }
    };
    let stored_passkeys = match load_user_passkeys(&connection, user_id) {
        Ok(values) => values,
        Err(response) => return response,
    };
    if stored_passkeys.is_empty() {
        if count_legacy_passkeys(&connection, user_id) > 0 {
            return json_error(
                actix_web::http::StatusCode::BAD_REQUEST,
                "Existing passkeys from the previous auth service must be re-added from Settings",
            );
        }
        return json_error(
            actix_web::http::StatusCode::BAD_REQUEST,
            "No passkeys registered for this account",
        );
    }
    let passkeys = stored_passkeys
        .into_iter()
        .map(|value| value.passkey)
        .collect::<Vec<_>>();
    let (challenge, state) = match webauthn.start_passkey_authentication(&passkeys) {
        Ok(value) => value,
        Err(error) => {
            error!("cannot start passkey auth: {}", error);
            return json_error(
                actix_web::http::StatusCode::BAD_REQUEST,
                "Could not start passkey login",
            );
        }
    };
    let state_json = match serde_json::to_string(&state) {
        Ok(value) => value,
        Err(error) => {
            error!("cannot serialize passkey auth state: {}", error);
            return json_error(
                actix_web::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Could not start passkey login",
            );
        }
    };
    if connection
        .execute(
            "UPDATE users SET passkey_auth_state=?1 WHERE id=?2",
            params![state_json, user_id],
        )
        .is_err()
    {
        return json_error(
            actix_web::http::StatusCode::INTERNAL_SERVER_ERROR,
            "Could not start passkey login",
        );
    }
    HttpResponse::Ok().json(challenge)
}

#[post("/passkeys/auth/finish")]
async fn passkey_auth_finish(body: web::Json<PasskeyAuthFinishRequest>) -> HttpResponse {
    if !passkeys_enabled() {
        return passkeys_disabled_response();
    }
    let username = normalize_username(&body.username);
    if username.is_empty() {
        return json_error(
            actix_web::http::StatusCode::BAD_REQUEST,
            "Username is required",
        );
    }
    let webauthn = match build_webauthn() {
        Ok(webauthn) => webauthn,
        Err(response) => return response,
    };
    let auth_env = AuthEnv::from_env();
    let connection = match open_db(&auth_env.db_path) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    let user_row = connection
        .query_row(
            "SELECT id, token, passkey_auth_state FROM users WHERE username=?1",
            params![username.clone()],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()
        .ok()
        .flatten();
    let Some((user_id, paste_token, passkey_auth_state)) = user_row else {
        return json_error(
            actix_web::http::StatusCode::UNAUTHORIZED,
            "Invalid credentials",
        );
    };
    let Some(passkey_auth_state) = passkey_auth_state else {
        return json_error(
            actix_web::http::StatusCode::BAD_REQUEST,
            "Passkey login was not started",
        );
    };
    let state = match serde_json::from_str::<PasskeyAuthentication>(&passkey_auth_state) {
        Ok(state) => state,
        Err(error) => {
            error!("cannot decode passkey auth state: {}", error);
            return json_error(
                actix_web::http::StatusCode::BAD_REQUEST,
                "Passkey login state expired",
            );
        }
    };
    let credential = match serde_json::from_value::<PublicKeyCredential>(body.credential.clone()) {
        Ok(credential) => credential,
        Err(error) => {
            error!("cannot decode passkey auth credential: {}", error);
            return json_error(
                actix_web::http::StatusCode::BAD_REQUEST,
                "Invalid passkey login payload",
            );
        }
    };
    let auth_result = match webauthn.finish_passkey_authentication(&credential, &state) {
        Ok(result) => result,
        Err(error) => {
            error!("cannot finish passkey auth: {}", error);
            return json_error(
                actix_web::http::StatusCode::UNAUTHORIZED,
                "Invalid credentials",
            );
        }
    };
    let mut stored_passkeys = match load_user_passkeys(&connection, user_id) {
        Ok(values) => values,
        Err(response) => return response,
    };
    let mut matched = false;
    for stored in &mut stored_passkeys {
        if stored.passkey.cred_id() == auth_result.cred_id() {
            matched = true;
            let _ = stored.passkey.update_credential(&auth_result);
            let passkey_json = match serde_json::to_string(&stored.passkey) {
                Ok(value) => value,
                Err(error) => {
                    error!("cannot serialize updated passkey: {}", error);
                    return json_error(
                        actix_web::http::StatusCode::INTERNAL_SERVER_ERROR,
                        "Passkey login failed",
                    );
                }
            };
            let _ = connection.execute(
                "UPDATE passkeys SET passkey_data=?1, sign_count=?2, last_used_at=?3 WHERE id=?4",
                params![
                    passkey_json,
                    auth_result.counter() as i64,
                    now_seconds(),
                    stored.id
                ],
            );
            break;
        }
    }
    if !matched {
        return json_error(
            actix_web::http::StatusCode::UNAUTHORIZED,
            "Invalid credentials",
        );
    }
    let _ = connection.execute(
        "UPDATE users SET passkey_auth_state=NULL WHERE id=?1",
        params![user_id],
    );
    let access_token = match create_jwt(&auth_env.jwt_secret, auth_env.jwt_ttl_seconds, &username) {
        Ok(token) => token,
        Err(response) => return response,
    };
    HttpResponse::Ok().json(json!({
        "access_token": access_token,
        "paste_token": paste_token,
        "username": username,
    }))
}

#[post("/admin/bootstrap")]
async fn admin_bootstrap(
    request: HttpRequest,
    body: web::Json<AdminBootstrapRequest>,
    config: web::Data<RwLock<Config>>,
) -> HttpResponse {
    let auth_env = AuthEnv::from_env();
    if let Err(response) = require_admin(&request, &auth_env) {
        return response;
    }
    let username = normalize_username(&body.username);
    if username.len() < 2 {
        return json_error(
            actix_web::http::StatusCode::BAD_REQUEST,
            "Username too short",
        );
    }
    if body.password.len() < 6 {
        return json_error(
            actix_web::http::StatusCode::BAD_REQUEST,
            "Password must be at least 6 characters",
        );
    }
    let configured = match config.read() {
        Ok(config) => configured_tokens(&config),
        Err(_) => {
            return json_error(
                actix_web::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Configuration unavailable",
            );
        }
    };
    let connection = match open_db(&auth_env.db_path) {
        Ok(connection) => connection,
        Err(response) => return response,
    };

    let requested_token = body.token.trim().to_string();
    let token = if !requested_token.is_empty() {
        if token_status_value(&connection, configured.as_ref(), &requested_token) != "available" {
            return json_error(
                actix_web::http::StatusCode::BAD_REQUEST,
                "Token is not available",
            );
        }
        requested_token
    } else if let Some(configured) = configured.as_ref() {
        match next_available_configured_token(&connection, configured) {
            Some(token) => token,
            None => {
                return json_error(
                    actix_web::http::StatusCode::CONFLICT,
                    "No available configured tokens left",
                );
            }
        }
    } else {
        let generated = generate_registration_token();
        if let Err(response) = store_registration_token(&connection, &generated, "bootstrap", None)
        {
            return response;
        }
        generated
    };

    match insert_user(&connection, &username, &body.password, &token) {
        Ok(_) => {
            HttpResponse::Ok().json(json!({ "detail": "Initial user created", "token": token }))
        }
        Err(response) => response,
    }
}

#[post("/admin/tokens")]
async fn admin_create_token(
    request: HttpRequest,
    body: web::Json<AdminCreateTokenRequest>,
    config: web::Data<RwLock<Config>>,
) -> HttpResponse {
    let auth_env = AuthEnv::from_env();
    if let Err(response) = require_admin(&request, &auth_env) {
        return response;
    }
    let configured = match config.read() {
        Ok(config) => configured_tokens(&config),
        Err(_) => {
            return json_error(
                actix_web::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Configuration unavailable",
            );
        }
    };
    let connection = match open_db(&auth_env.db_path) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    let token = if let Some(configured) = configured.as_ref() {
        match next_available_configured_token(&connection, configured) {
            Some(token) => token,
            None => {
                return json_error(
                    actix_web::http::StatusCode::CONFLICT,
                    "No available configured tokens left",
                );
            }
        }
    } else {
        let token = generate_registration_token();
        let label = if body.label.trim().is_empty() {
            "generated"
        } else {
            body.label.trim()
        };
        if let Err(response) =
            store_registration_token(&connection, &token, label, body.ttl_seconds)
        {
            return response;
        }
        token
    };
    HttpResponse::Ok().json(json!({ "token": token }))
}

#[delete("/admin/tokens/{token}")]
async fn admin_revoke_token(
    request: HttpRequest,
    token: web::Path<String>,
    config: web::Data<RwLock<Config>>,
) -> HttpResponse {
    let auth_env = AuthEnv::from_env();
    if let Err(response) = require_admin(&request, &auth_env) {
        return response;
    }
    let token = token.into_inner();
    if token.trim().is_empty() {
        return json_error(
            actix_web::http::StatusCode::BAD_REQUEST,
            "Token is required",
        );
    }
    let connection = match open_db(&auth_env.db_path) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    let now = now_seconds();
    if let Err(error) = connection.execute(
        "INSERT OR REPLACE INTO revoked_tokens (token, revoked_at) VALUES (?1, ?2)",
        params![token, now],
    ) {
        error!("cannot revoke token: {}", error);
        return json_error(
            actix_web::http::StatusCode::INTERNAL_SERVER_ERROR,
            "Could not revoke token",
        );
    }
    let _ = connection.execute(
        "UPDATE registration_tokens SET revoked_at=?1 WHERE token=?2",
        params![now, token.as_str()],
    );

    if let Ok(config) = config.read() {
        if let Some(tokens) = configured_tokens(&config) {
            if !tokens.contains(&token) && !is_registration_token_known(&connection, &token) {
                return json_error(actix_web::http::StatusCode::NOT_FOUND, "Token not found");
            }
        }
    }

    HttpResponse::Ok().json(json!({ "detail": "Token revoked" }))
}

/// Configures account authentication routes under `/auth`.
pub fn configure_routes(cfg: &mut web::ServiceConfig) {
    cfg.service(register)
        .service(login)
        .service(token_status)
        .service(me)
        .service(sharex)
        .service(list_passkeys)
        .service(passkey_register_begin)
        .service(passkey_register_finish)
        .service(passkey_delete)
        .service(passkey_auth_begin)
        .service(passkey_auth_finish)
        .service(admin_bootstrap)
        .service(admin_create_token)
        .service(admin_revoke_token)
        .service(web::scope("/admin").configure(crate::admin::configure_routes));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ratelimit::RateLimiter;
    use actix_web::http::StatusCode;
    use actix_web::test;
    use actix_web::web::Data;
    use actix_web::App;
    use serde_json::json;
    use std::sync::RwLock;

    fn test_db_path(name: &str) -> String {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir()
            .join(format!("rustypaste-auth-test-{name}-{nanos}.sqlite"))
            .to_string_lossy()
            .to_string()
    }

    fn test_config() -> Config {
        let mut config = Config::default();
        config.server.tokens = Some(["seed-token".to_string(), "spare-token".to_string()].into());
        config
    }

    fn set_auth_test_env(path: &str) {
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
        }
    }

    #[actix_web::test]
    async fn register_login_me_and_token_status_flow() {
        let db_path = test_db_path("register-login");
        set_auth_test_env(&db_path);

        let app = test::init_service(
            App::new()
                .app_data(Data::new(RwLock::new(test_config())))
                .app_data(Data::new(Client::default()))
                .app_data(Data::new(RateLimiter::new()))
                .service(web::scope("/auth").configure(configure_routes)),
        )
        .await;

        let register_request = test::TestRequest::post()
            .uri("/auth/register")
            .set_json(json!({
                "username": "tester",
                "password": "password123",
                "token": "seed-token",
            }))
            .to_request();
        let register_response = test::call_service(&app, register_request).await;
        assert_eq!(StatusCode::OK, register_response.status());

        let login_request = test::TestRequest::post()
            .uri("/auth/login")
            .set_json(json!({
                "username": "tester",
                "password": "password123",
                "turnstile_token": "",
            }))
            .to_request();
        let login_response = test::call_service(&app, login_request).await;
        assert_eq!(StatusCode::OK, login_response.status());
        let login_json: Value = test::read_body_json(login_response).await;
        let access_token = login_json["access_token"]
            .as_str()
            .expect("access_token should exist")
            .to_string();
        assert_eq!(login_json["paste_token"], "seed-token");

        let me_request = test::TestRequest::get()
            .uri("/auth/me")
            .insert_header((AUTHORIZATION, format!("Bearer {access_token}")))
            .to_request();
        let me_response = test::call_service(&app, me_request).await;
        assert_eq!(StatusCode::OK, me_response.status());
        let me_json: Value = test::read_body_json(me_response).await;
        assert_eq!(me_json["username"], "tester");

        let status_request = test::TestRequest::post()
            .uri("/auth/token/status")
            .set_json(json!({ "token": "seed-token" }))
            .to_request();
        let status_response = test::call_service(&app, status_request).await;
        assert_eq!(StatusCode::OK, status_response.status());
        let status_json: Value = test::read_body_json(status_response).await;
        assert_eq!(status_json["status"], "used");

        let _ = std::fs::remove_file(db_path);
        clear_auth_test_env();
    }

    #[actix_web::test]
    async fn admin_token_create_and_revoke_flow() {
        let db_path = test_db_path("admin-token");
        set_auth_test_env(&db_path);

        let app = test::init_service(
            App::new()
                .app_data(Data::new(RwLock::new(test_config())))
                .app_data(Data::new(Client::default()))
                .service(web::scope("/auth").configure(configure_routes)),
        )
        .await;

        let create_request = test::TestRequest::post()
            .uri("/auth/admin/tokens")
            .insert_header((AUTHORIZATION, "Bearer admin-token"))
            .set_json(json!({ "label": "ci" }))
            .to_request();
        let create_response = test::call_service(&app, create_request).await;
        assert_eq!(StatusCode::OK, create_response.status());
        let create_json: Value = test::read_body_json(create_response).await;
        let created_token = create_json["token"]
            .as_str()
            .expect("token should exist")
            .to_string();

        let revoke_request = test::TestRequest::delete()
            .uri(&format!("/auth/admin/tokens/{created_token}"))
            .insert_header((AUTHORIZATION, "Bearer admin-token"))
            .to_request();
        let revoke_response = test::call_service(&app, revoke_request).await;
        assert_eq!(StatusCode::OK, revoke_response.status());

        let status_request = test::TestRequest::post()
            .uri("/auth/token/status")
            .set_json(json!({ "token": created_token }))
            .to_request();
        let status_response = test::call_service(&app, status_request).await;
        assert_eq!(StatusCode::OK, status_response.status());
        let status_json: Value = test::read_body_json(status_response).await;
        assert_eq!(status_json["status"], "invalid");

        let _ = std::fs::remove_file(db_path);
        clear_auth_test_env();
    }

    #[actix_web::test]
    async fn admin_claim_settings_and_destructive_user_flow() {
        let db_path = test_db_path("admin-claim");
        set_auth_test_env(&db_path);

        let app = test::init_service(
            App::new()
                .app_data(Data::new(RwLock::new(test_config())))
                .app_data(Data::new(Client::default()))
                .app_data(Data::new(RateLimiter::new()))
                .service(web::scope("/auth").configure(configure_routes)),
        )
        .await;

        let claim_init = test::TestRequest::post()
            .uri("/auth/admin/claim/init")
            .insert_header((AUTHORIZATION, "Bearer admin-token"))
            .set_json(json!({}))
            .to_request();
        let claim_init_response = test::call_service(&app, claim_init).await;
        assert_eq!(StatusCode::OK, claim_init_response.status());
        let claim_init_json: Value = test::read_body_json(claim_init_response).await;
        let claim_token = claim_init_json["token"]
            .as_str()
            .expect("claim token should exist")
            .to_string();

        let claim = test::TestRequest::post()
            .uri("/auth/admin/claim")
            .set_json(json!({
                "claim_token": claim_token,
                "username": "admin",
                "password": "password123",
                "upload_token": "seed-token",
            }))
            .to_request();
        let claim_response = test::call_service(&app, claim).await;
        assert_eq!(StatusCode::OK, claim_response.status());
        let claim_json: Value = test::read_body_json(claim_response).await;
        assert_eq!(claim_json["is_admin"], true);
        let admin_jwt = claim_json["access_token"]
            .as_str()
            .expect("admin jwt should exist")
            .to_string();

        let reused_claim = test::TestRequest::post()
            .uri("/auth/admin/claim")
            .set_json(json!({
                "claim_token": claim_init_json["token"],
                "username": "other-admin",
                "password": "password123",
            }))
            .to_request();
        let reused_claim_response = test::call_service(&app, reused_claim).await;
        assert_eq!(StatusCode::CONFLICT, reused_claim_response.status());
        let claim_connection = rusqlite::Connection::open(&db_path).expect("claim db should open");
        let (stored_claim_hash, used_at): (String, Option<i64>) = claim_connection
            .query_row(
                "SELECT token_hash, used_at FROM admin_claims ORDER BY id DESC LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("claim row should exist");
        assert_ne!(stored_claim_hash, claim_init_json["token"].as_str().unwrap());
        assert!(used_at.is_some());
        drop(claim_connection);
        let update_settings = test::TestRequest::put()
            .uri("/auth/admin/settings")
            .insert_header((AUTHORIZATION, format!("Bearer {admin_jwt}")))
            .set_json(json!({
                "app_name": "Test Paste",
                "public_title": "Test Title",
                "registration_enabled": false,
                "base_api_url": "https://paste.example.test/api/",
                "file_size_limit_bytes": 1024,
            }))
            .to_request();
        let update_settings_response = test::call_service(&app, update_settings).await;
        assert_eq!(StatusCode::OK, update_settings_response.status());
        let settings_json: Value = test::read_body_json(update_settings_response).await;
        assert_eq!(settings_json["registration_enabled"], "false");
        assert_eq!(settings_json["base_api_url"], "https://paste.example.test/api");
        assert_eq!(settings_json["file_size_limit_bytes"], "1024");

        let public_settings = test::TestRequest::get()
            .uri("/auth/admin/public-settings")
            .to_request();
        let public_settings_response = test::call_service(&app, public_settings).await;
        assert_eq!(StatusCode::OK, public_settings_response.status());
        let public_settings_json: Value = test::read_body_json(public_settings_response).await;
        assert_eq!(
            public_settings_json["base_api_url"],
            "https://paste.example.test/api"
        );
        let create_user = test::TestRequest::post()
            .uri("/auth/admin/users")
            .insert_header((AUTHORIZATION, format!("Bearer {admin_jwt}")))
            .set_json(json!({
                "username": "managed",
                "password": "password123",
                "upload_token": "spare-token",
            }))
            .to_request();
        let create_user_response = test::call_service(&app, create_user).await;
        assert_eq!(StatusCode::OK, create_user_response.status());
        let managed_login = test::TestRequest::post()
            .uri("/auth/login")
            .set_json(json!({
                "username": "managed",
                "password": "password123",
                "turnstile_token": "",
            }))
            .to_request();
        let managed_login_response = test::call_service(&app, managed_login).await;
        assert_eq!(StatusCode::OK, managed_login_response.status());
        let managed_login_json: Value = test::read_body_json(managed_login_response).await;
        let managed_jwt = managed_login_json["access_token"]
            .as_str()
            .expect("managed jwt should exist");
        let managed_dashboard = test::TestRequest::get()
            .uri("/auth/admin/dashboard")
            .insert_header((AUTHORIZATION, format!("Bearer {managed_jwt}")))
            .to_request();
        let managed_dashboard_response = test::call_service(&app, managed_dashboard).await;
        assert_eq!(StatusCode::FORBIDDEN, managed_dashboard_response.status());
        let bad_delete = test::TestRequest::delete()
            .uri("/auth/admin/users/managed")
            .insert_header((AUTHORIZATION, format!("Bearer {admin_jwt}")))
            .set_json(json!({ "confirmation": "wrong" }))
            .to_request();
        let bad_delete_response = test::call_service(&app, bad_delete).await;
        assert_eq!(StatusCode::BAD_REQUEST, bad_delete_response.status());

        let delete_user = test::TestRequest::delete()
            .uri("/auth/admin/users/managed")
            .insert_header((AUTHORIZATION, format!("Bearer {admin_jwt}")))
            .set_json(json!({ "confirmation": "DELETE USER" }))
            .to_request();
        let delete_user_response = test::call_service(&app, delete_user).await;
        assert_eq!(StatusCode::OK, delete_user_response.status());

        let _ = std::fs::remove_file(db_path);
        clear_auth_test_env();
    }

    #[actix_web::test]
    async fn passkey_routes_can_be_disabled() {
        let db_path = test_db_path("passkeys-disabled");
        set_auth_test_env(&db_path);
        unsafe {
            env::set_var("PASSKEYS_ENABLED", "0");
        }

        let app = test::init_service(
            App::new()
                .app_data(Data::new(RwLock::new(test_config())))
                .app_data(Data::new(Client::default()))
                .service(web::scope("/auth").configure(configure_routes)),
        )
        .await;

        let begin_request = test::TestRequest::post()
            .uri("/auth/passkeys/auth/begin")
            .set_json(json!({ "username": "tester" }))
            .to_request();
        let begin_response = test::call_service(&app, begin_request).await;
        assert_eq!(StatusCode::BAD_REQUEST, begin_response.status());
        let body: Value = test::read_body_json(begin_response).await;
        assert_eq!(body["detail"], "Passkeys are disabled");

        let _ = std::fs::remove_file(db_path);
        clear_auth_test_env();
    }

    #[actix_web::test]
    async fn sharex_route_can_be_disabled() {
        let db_path = test_db_path("sharex-disabled");
        set_auth_test_env(&db_path);
        unsafe {
            env::set_var("VITE_ENABLE_SHAREX", "0");
        }

        let app = test::init_service(
            App::new()
                .app_data(Data::new(RwLock::new(test_config())))
                .app_data(Data::new(Client::default()))
                .service(web::scope("/auth").configure(configure_routes)),
        )
        .await;

        let request = test::TestRequest::get().uri("/auth/sharex").to_request();
        let response = test::call_service(&app, request).await;
        assert_eq!(StatusCode::BAD_REQUEST, response.status());
        let body: Value = test::read_body_json(response).await;
        assert_eq!(body["detail"], "ShareX support is disabled");

        let _ = std::fs::remove_file(db_path);
        clear_auth_test_env();
    }
}
