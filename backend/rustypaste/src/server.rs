use crate::auth::{extract_tokens, get_auth_token, handle_unauthorized_error, unauthorized_error};
use crate::config::{Config, LandingPageConfig, TokenType};
use crate::file::Directory;
use crate::header::{self, ContentDisposition};
use crate::mime as mime_util;
use crate::paste::{Paste, PasteType};
use crate::util::{self, safe_path_join, token_to_dir_name};
use actix_files::NamedFile;
use actix_multipart::{Field, Multipart};
use actix_web::http::header::{
    ContentDisposition as ActixContentDisposition, DispositionParam, DispositionType, ACCEPT,
    AUTHORIZATION,
};
use actix_web::http::StatusCode;
use actix_web::middleware::ErrorHandlers;
use actix_web::{delete, error, get, post, web, Error, HttpRequest, HttpResponse};
use actix_web_grants::GrantsMiddleware;
use awc::Client;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use byte_unit::{Byte, UnitType};
use futures_util::stream::StreamExt;
use mime::TEXT_PLAIN_UTF_8;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::convert::TryFrom;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use std::time::{Duration, UNIX_EPOCH};
use uts2ts;

/// Returns the upload path for a given token.
///
/// If a valid token is provided, returns a token-specific directory. Otherwise,
/// returns the base upload path used for anonymous uploads.
fn get_upload_path_for_token(request: &HttpRequest, config: &Config) -> PathBuf {
    // Integrated account tokens are validated from the auth database rather
    // than server.tokens. They must be isolated just like configured tokens.
    if let Some(token) = get_auth_token(request, config) {
        let token_dir = token_to_dir_name(&token);
        return config.server.upload_path.join(token_dir);
    }
    config.server.upload_path.clone()
}

/// Shows the landing page.
#[get("/")]
#[allow(deprecated)]
async fn index(config: web::Data<RwLock<Config>>) -> Result<HttpResponse, Error> {
    let mut config = config
        .read()
        .map_err(|_| error::ErrorInternalServerError("cannot acquire config"))?
        .clone();
    let redirect = HttpResponse::Found()
        .append_header(("Location", env!("CARGO_PKG_HOMEPAGE")))
        .finish();
    if config.server.landing_page.is_some() {
        if config.landing_page.is_none() {
            config.landing_page = Some(LandingPageConfig::default());
        }
        if let Some(ref mut landing_page) = config.landing_page {
            landing_page.text = config.server.landing_page;
        }
    }
    if config.server.landing_page_content_type.is_some() {
        if config.landing_page.is_none() {
            config.landing_page = Some(LandingPageConfig::default());
        }
        if let Some(ref mut landing_page) = config.landing_page {
            landing_page.content_type = config.server.landing_page_content_type;
        }
    }
    if let Some(mut landing_page) = config.landing_page {
        if let Some(file) = landing_page.file {
            landing_page.text = fs::read_to_string(file).ok();
        }
        match landing_page.text {
            Some(page) => Ok(HttpResponse::Ok()
                .content_type(
                    landing_page
                        .content_type
                        .unwrap_or(TEXT_PLAIN_UTF_8.to_string()),
                )
                .body(page)),
            None => Ok(redirect),
        }
    } else {
        Ok(redirect)
    }
}

/// File serving options (i.e. query parameters).
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct ServeOptions {
    /// If set to `true`, change the MIME type to `application/octet-stream` and force downloading
    /// the file.
    download: Option<String>,
    /// If set to `true`, always return the raw file bytes.
    raw: Option<String>,
}

fn query_flag(value: Option<&String>) -> bool {
    matches!(
        value.map(|item| item.trim().to_ascii_lowercase()).as_deref(),
        Some("1" | "true" | "yes")
    )
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct UploadMetaField {
    keep_file_name: bool,
    original_name: String,
    uploader: String,
    source: String,
    password_salt: String,
}

#[derive(Debug, Deserialize, Serialize)]
struct StoredUploadMeta {
    display_name: Option<String>,
    uploader: Option<String>,
    source: Option<String>,
    password_salt: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
struct PublicFileMeta {
    file_name: String,
    display_name: String,
    uploader: String,
    source: Option<String>,
    upload_date_utc: Option<String>,
    download_name: String,
    file_size: u64,
    mime_type: String,
}

#[derive(Debug, Serialize)]
struct ResolveItem {
    file_name: String,
    raw_path: String,
    uploader: Option<String>,
}

#[derive(Debug, Serialize)]
struct TokenOwnerItem {
    username: String,
}

#[derive(Debug, Clone)]
struct ResolveMatch {
    file_name: String,
    owner_token: Option<String>,
    path: PathBuf,
}

fn decode_dir_token(dir_name: &str) -> Option<String> {
    URL_SAFE_NO_PAD
        .decode(dir_name)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .filter(|value| !value.trim().is_empty())
}

fn db_path_from_env() -> String {
    env::var("DB_PATH").unwrap_or_else(|_| "/var/lib/rustypaste-auth/users.db".to_string())
}

fn lookup_username_for_token(token: &str) -> Option<String> {
    let connection = Connection::open(db_path_from_env()).ok()?;
    connection
        .query_row(
            "SELECT username FROM users WHERE token=?1 LIMIT 1",
            [token],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .filter(|value| !value.trim().is_empty())
}

fn resolve_matches_in_dir(
    path: &Path,
    token: &str,
    owner_token: Option<&str>,
) -> Result<Vec<ResolveMatch>, Error> {
    Ok(fs::read_dir(path)?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let kind = entry.file_type().ok()?;
            if !kind.is_file() && !kind.is_symlink() {
                return None;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if name == token || name.split('.').next() == Some(token) {
                Some(ResolveMatch {
                    file_name: name,
                    owner_token: owner_token.map(str::to_string),
                    path: entry.path(),
                })
            } else {
                None
            }
        })
        .collect())
}

fn resolve_token_to_file(token: &str, upload_path: &Path) -> Result<ResolveMatch, Error> {
    let token = token.trim().trim_start_matches('/');
    if token.is_empty() || token.contains('/') {
        return Err(error::ErrorNotFound("file is not found or expired :(\n"));
    }

    let mut matches = resolve_matches_in_dir(upload_path, token, None)?;
    for entry in fs::read_dir(upload_path)? {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let kind = match entry.file_type() {
            Ok(kind) => kind,
            Err(_) => continue,
        };
        if !kind.is_dir() {
            continue;
        }
        let dir_name = entry.file_name().to_string_lossy().to_string();
        if matches!(
            dir_name.as_str(),
            "oneshot" | "oneshot_url" | "url" | ".rpmeta"
        ) {
            continue;
        }
        let owner_token = decode_dir_token(&dir_name);
        let mut nested_matches =
            resolve_matches_in_dir(&entry.path(), token, owner_token.as_deref())?;
        matches.append(&mut nested_matches);
    }

    // Root-level compatibility symlinks and their account-scoped targets are
    // aliases for one upload, not two ambiguous matches.
    let mut unique_matches = Vec::with_capacity(matches.len());
    for candidate in matches {
        let duplicate_position = unique_matches.iter().position(|existing: &ResolveMatch| {
            match (
                fs::canonicalize(&existing.path),
                fs::canonicalize(&candidate.path),
            ) {
                (Ok(existing), Ok(candidate)) => existing == candidate,
                _ => existing.path == candidate.path,
            }
        });
        if let Some(position) = duplicate_position {
            let existing_is_symlink = fs::symlink_metadata(&unique_matches[position].path)
                .map(|metadata| metadata.file_type().is_symlink())
                .unwrap_or(false);
            let candidate_is_symlink = fs::symlink_metadata(&candidate.path)
                .map(|metadata| metadata.file_type().is_symlink())
                .unwrap_or(false);
            if existing_is_symlink && !candidate_is_symlink {
                unique_matches[position] = candidate;
            }
        } else {
            unique_matches.push(candidate);
        }
    }
    let mut matches = unique_matches;
    matches.sort_by(|left, right| left.file_name.cmp(&right.file_name));
    if matches.len() != 1 {
        return Err(error::ErrorNotFound("file is not found or expired :(\n"));
    }

    Ok(matches.remove(0))
}

#[allow(deprecated)]
fn resolve_file_location(
    request: &HttpRequest,
    file: &str,
    config: &Config,
) -> Result<(PathBuf, PasteType, PathBuf), Error> {
    let upload_path = get_upload_path_for_token(request, config);
    let mut resolved_root = upload_path.clone();
    let mut path = util::glob_match_file(safe_path_join(&upload_path, file)?)?;
    let mut paste_type = PasteType::File;

    if !path.exists() || path.is_dir() {
        for type_ in &[PasteType::Url, PasteType::Oneshot, PasteType::OneshotUrl] {
            let alt_path = safe_path_join(type_.get_path(&upload_path)?, file)?;
            let alt_path = util::glob_match_file(alt_path)?;
            if alt_path.exists()
                || path.file_name().and_then(|v| v.to_str()) == Some(&type_.get_dir())
            {
                path = alt_path;
                paste_type = *type_;
                resolved_root = upload_path.clone();
                break;
            }
        }
    }

    #[allow(deprecated)]
    let tokens_configured = config.server.tokens.is_some()
        || config.server.auth_tokens.is_some()
        || config.server.delete_tokens.is_some();
    if (!path.is_file() || !path.exists()) && tokens_configured {
        if let Some(tokens) = config.get_tokens(TokenType::Auth) {
            for token in tokens {
                let token_upload_path = config.server.upload_path.join(token_to_dir_name(&token));
                if let Ok(token_path) = safe_path_join(&token_upload_path, file) {
                    let token_path = util::glob_match_file(token_path)?;
                    if token_path.is_file() && token_path.exists() {
                        path = token_path;
                        paste_type = PasteType::File;
                        resolved_root = token_upload_path.clone();
                        break;
                    }
                }
                for type_ in &[PasteType::Url, PasteType::Oneshot, PasteType::OneshotUrl] {
                    if let Ok(type_path) = type_.get_path(&token_upload_path) {
                        if let Ok(alt_path) = safe_path_join(&type_path, file) {
                            let alt_path = util::glob_match_file(alt_path)?;
                            if alt_path.is_file() && alt_path.exists() {
                                path = alt_path;
                                paste_type = *type_;
                                resolved_root = token_upload_path.clone();
                                break;
                            }
                        }
                    }
                }
                if path.is_file() && path.exists() {
                    break;
                }
            }
        }
    }

    // Account tokens are persisted in the auth database, so they are not
    // necessarily present in the static Rustypaste token configuration above.
    // Public preview/raw links must still resolve files stored in those token
    // directories after the resolver has identified their stored filename.
    if !path.is_file() || !path.exists() {
        for entry in fs::read_dir(&config.server.upload_path)? {
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => continue,
            };
            let entry_path = entry.path();
            let is_storage_dir = entry
                .file_type()
                .map(|kind| kind.is_dir())
                .unwrap_or(false)
                && !matches!(
                    entry.file_name().to_string_lossy().as_ref(),
                    "oneshot" | "oneshot_url" | "url" | ".rpmeta"
                );
            if !is_storage_dir {
                continue;
            }
            if let Ok(candidate) = safe_path_join(&entry_path, file) {
                let candidate = util::glob_match_file(candidate)?;
                if candidate.is_file() && candidate.exists() {
                    path = candidate;
                    paste_type = PasteType::File;
                    resolved_root = entry_path;
                    break;
                }
            }
        }
    }

    if !path.is_file() || !path.exists() {
        return Err(error::ErrorNotFound("file is not found or expired :(\n"));
    }
    Ok((path, paste_type, resolved_root))
}

fn metadata_file_path(upload_path: &Path, file_name: &str) -> PathBuf {
    let safe_name = file_name.replace('/', "_");
    upload_path
        .join(".rpmeta")
        .join(format!("{safe_name}.json"))
}

async fn read_multipart_field_bytes(field: &mut Field) -> Result<Vec<u8>, Error> {
    let mut bytes = Vec::<u8>::new();
    while let Some(chunk) = field.next().await {
        bytes.append(&mut chunk?.to_vec());
    }
    Ok(bytes)
}

/// Computes the actual on-disk file name for a stored paste, including the
/// expiry timestamp suffix that `Paste::store_file` appends to the path it
/// writes (see its `if let Some(timestamp) = expiry_date` branch) while
/// still *returning* the pre-suffix name to its caller. Anything that keys
/// off the file's identity after upload - metadata sidecars, admin listing,
/// delete - must use this same suffixed form, since that's the name the
/// file actually exists under on disk.
fn stored_file_name(file_name: &str, expiry_date: Option<u128>) -> String {
    match expiry_date {
        Some(timestamp) => format!("{file_name}.{timestamp}"),
        None => file_name.to_string(),
    }
}

fn persist_upload_metadata(
    upload_path: &Path,
    file_name: &str,
    meta: &UploadMetaField,
) -> Result<(), Error> {
    if !meta.keep_file_name && meta.uploader.trim().is_empty() && meta.source.trim().is_empty() {
        return Ok(());
    }
    let metadata_dir = upload_path.join(".rpmeta");
    fs::create_dir_all(&metadata_dir)?;
    let body = StoredUploadMeta {
        display_name: if meta.keep_file_name && !meta.original_name.trim().is_empty() {
            Some(meta.original_name.trim().to_string())
        } else {
            None
        },
        uploader: if meta.uploader.trim().is_empty() {
            None
        } else {
            Some(meta.uploader.trim().to_string())
        },
        source: if meta.source.trim().is_empty() {
            None
        } else {
            Some(meta.source.trim().to_string())
        },
        password_salt: if meta.password_salt.len() == 22 && meta.password_salt.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_') {
            Some(meta.password_salt.clone())
        } else {
            None
        },
    };
    fs::write(
        metadata_file_path(upload_path, file_name),
        serde_json::to_vec(&body).map_err(error::ErrorInternalServerError)?,
    )?;
    Ok(())
}

fn load_upload_metadata(upload_path: &Path, file_name: &str) -> Option<StoredUploadMeta> {
    fs::read(metadata_file_path(upload_path, file_name))
        .ok()
        .and_then(|v| serde_json::from_slice::<StoredUploadMeta>(&v).ok())
}

fn strip_expiry_suffix(file_name: &str) -> Option<&str> {
    let dot = file_name.rfind('.')?;
    let digits = &file_name[dot + 1..];
    (!digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit()))
        .then(|| &file_name[..dot])
}

fn load_upload_metadata_for_path(
    path: &Path,
    resolved_root: &Path,
    file_name: &str,
) -> Option<StoredUploadMeta> {
    let stored_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(file_name);
    let load_for_name = |upload_path: &Path| {
        load_upload_metadata(upload_path, stored_name).or_else(|| {
            strip_expiry_suffix(stored_name)
                .and_then(|base_name| load_upload_metadata(upload_path, base_name))
        })
    };
    if let Some(meta) = load_for_name(resolved_root) {
        return Some(meta);
    }
    fs::canonicalize(path)
        .ok()
        .and_then(|target| target.parent().map(PathBuf::from))
        .filter(|parent| parent != resolved_root)
        .and_then(|parent| load_for_name(&parent))
}

fn public_path_from_file_name(file_name: &str) -> String {
    let mut parts = file_name.splitn(2, '.');
    let id = parts.next().unwrap_or(file_name);
    let tail = parts.next();
    if let Some(ext) = tail {
        format!("/{id}/file.{ext}")
    } else {
        format!("/{id}/file")
    }
}

fn preview_location(config: &Config, file_name: &str) -> String {
    let path = public_path_from_file_name(file_name);
    let configured_origin = config
        .server
        .url
        .clone()
        .or_else(|| env::var("PASTE_URL").ok());
    let origin = configured_origin
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.trim_end_matches('/'));
    match origin {
        Some(origin) => format!("{origin}/#/preview?p={path}"),
        None => format!("/#/preview?p={path}"),
    }
}

fn should_redirect_to_preview(
    request: &HttpRequest,
    file_name: &str,
    force_download: bool,
    force_raw: bool,
) -> bool {
    if force_download || force_raw || file_name.ends_with(".rpenc") {
        return false;
    }
    request
        .headers()
        .get(ACCEPT)
        .and_then(|v| v.to_str().ok())
        .map(|accept| accept.contains("text/html"))
        .unwrap_or(false)
}

async fn serve_impl(
    request: HttpRequest,
    file_name: String,
    options: Option<web::Query<ServeOptions>>,
    config: web::Data<RwLock<Config>>,
) -> Result<HttpResponse, Error> {
    let config = config
        .read()
        .map_err(|_| error::ErrorInternalServerError("cannot acquire config"))?;
    let force_download = options
        .as_ref()
        .map(|value| query_flag(value.download.as_ref()))
        .unwrap_or(false);
    let force_raw = options
        .as_ref()
        .map(|value| query_flag(value.raw.as_ref()))
        .unwrap_or(false);
    let (path, paste_type, resolved_root) = resolve_file_location(&request, &file_name, &config)?;
    match paste_type {
        PasteType::File | PasteType::RemoteFile | PasteType::Oneshot => {
            if should_redirect_to_preview(&request, &file_name, force_download, force_raw) {
                let location = preview_location(&config, &file_name);
                return Ok(HttpResponse::Found()
                    .append_header(("Location", location))
                    .append_header(("Cache-Control", "no-store"))
                    .append_header(("Vary", "Accept"))
                    .finish());
            }
            let metadata = load_upload_metadata_for_path(&path, &resolved_root, &file_name);
            let mime_file_name = metadata
                .as_ref()
                .and_then(|value| value.display_name.as_deref())
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(&file_name);
            let mime_type = if force_download {
                mime::APPLICATION_OCTET_STREAM
            } else {
                mime_util::get_mime_type(&config.paste.mime_override, mime_file_name.to_string())
                    .map_err(error::ErrorInternalServerError)?
            };
            let download_name = metadata
                .and_then(|value| value.display_name)
                .unwrap_or_else(|| file_name.clone());
            let unsafe_inline_type = matches!(
                mime_type.essence_str(),
                "text/html"
                    | "application/xhtml+xml"
                    | "image/svg+xml"
                    | "application/javascript"
                    | "text/javascript"
            );
            let disposition_type = if force_download || unsafe_inline_type {
                DispositionType::Attachment
            } else {
                DispositionType::Inline
            };
            let response = NamedFile::open(&path)?
                .set_content_disposition(ActixContentDisposition {
                    disposition: disposition_type,
                    parameters: vec![DispositionParam::Filename(download_name)],
                })
                .set_content_type(mime_type)
                .prefer_utf8(true)
                .into_response(&request);
            if paste_type.is_oneshot() {
                fs::rename(
                    &path,
                    path.with_file_name(format!(
                        "{}.{}",
                        file_name,
                        util::get_system_time()?.as_millis()
                    )),
                )?;
            }
            Ok(response)
        }
        PasteType::Url => Ok(HttpResponse::Found()
            .append_header(("Location", fs::read_to_string(&path)?))
            .finish()),
        PasteType::OneshotUrl => {
            let resp = HttpResponse::Found()
                .append_header(("Location", fs::read_to_string(&path)?))
                .finish();
            fs::rename(
                &path,
                path.with_file_name(format!(
                    "{}.{}",
                    file_name,
                    util::get_system_time()?.as_millis()
                )),
            )?;
            Ok(resp)
        }
    }
}

/// Serves a file from the upload directory.
#[get("/{file}")]
async fn serve(
    request: HttpRequest,
    file: web::Path<String>,
    options: Option<web::Query<ServeOptions>>,
    config: web::Data<RwLock<Config>>,
) -> Result<HttpResponse, Error> {
    serve_impl(request, file.to_string(), options, config).await
}

/// Serves a file from a short URL path (`/{id}/{name}`).
///
/// The `{name}` segment is cosmetic and used only for extension retention in shared links.
/// Actual storage continues to use rustypaste's flat file naming.
#[get("/{id}/{name}")]
async fn serve_short(
    request: HttpRequest,
    path: web::Path<(String, String)>,
    options: Option<web::Query<ServeOptions>>,
    config: web::Data<RwLock<Config>>,
) -> Result<HttpResponse, Error> {
    let (id, name) = path.into_inner();
    let resolved_name = if let Some(ext) = name.strip_prefix("file.") {
        format!("{id}.{ext}")
    } else if name == "file" {
        id
    } else {
        format!("{id}.{name}")
    };
    serve_impl(request, resolved_name, options, config).await
}

/// Returns public metadata for a file preview page.
#[get("/meta/{file}")]
async fn public_meta(
    request: HttpRequest,
    file: web::Path<String>,
    config: web::Data<RwLock<Config>>,
) -> Result<HttpResponse, Error> {
    let requested_file = file.to_string();
    let config = config
        .read()
        .map_err(|_| error::ErrorInternalServerError("cannot acquire config"))?;
    let (path, paste_type, resolved_root) =
        resolve_file_location(&request, &requested_file, &config)?;
    if !matches!(
        paste_type,
        PasteType::File | PasteType::RemoteFile | PasteType::Oneshot
    ) {
        return Err(error::ErrorNotFound("file is not found or expired :(\n"));
    }
    let meta = load_upload_metadata_for_path(&path, &resolved_root, &requested_file);
    let upload_date_utc = fs::metadata(&path)
        .ok()
        .and_then(|v| v.created().ok())
        .and_then(|v| v.duration_since(UNIX_EPOCH).ok())
        .map(|v| uts2ts::uts2ts((v.as_millis() as i64) / 1000).as_string());
    let item = PublicFileMeta {
        file_name: requested_file.clone(),
        display_name: meta
            .as_ref()
            .and_then(|v| v.display_name.clone())
            .unwrap_or_else(|| requested_file.clone()),
        uploader: meta
            .as_ref()
            .and_then(|v| v.uploader.clone())
            .unwrap_or_else(|| "Unknown (token user)".to_string()),
        source: meta.as_ref().and_then(|v| v.source.clone()),
        upload_date_utc,
        download_name: meta
            .and_then(|v| v.display_name)
            .unwrap_or_else(|| requested_file.clone()),
        file_size: fs::metadata(&path).map(|v| v.len()).unwrap_or(0),
        mime_type: mime_util::get_mime_type(&config.paste.mime_override, requested_file)
            .map_err(error::ErrorInternalServerError)?
            .to_string(),
    };
    Ok(HttpResponse::Ok().json(item))
}

#[get("/resolve/{token}")]
async fn resolve(
    token: web::Path<String>,
    config: web::Data<RwLock<Config>>,
) -> Result<HttpResponse, Error> {
    let config = config
        .read()
        .map_err(|_| error::ErrorInternalServerError("cannot acquire config"))?;
    let resolved = resolve_token_to_file(token.as_str(), &config.server.upload_path)?;
    let uploader = resolved
        .owner_token
        .as_deref()
        .and_then(lookup_username_for_token);

    Ok(HttpResponse::Ok().json(ResolveItem {
        file_name: resolved.file_name.clone(),
        raw_path: public_path_from_file_name(&resolved.file_name),
        uploader,
    }))
}

#[get("/token-owner")]
async fn token_owner(request: HttpRequest) -> Result<HttpResponse, Error> {
    let token = request
        .headers()
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split_whitespace().last())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| error::ErrorUnauthorized("missing token"))?;
    let username =
        lookup_username_for_token(token).ok_or_else(|| error::ErrorNotFound("token not found"))?;
    Ok(HttpResponse::Ok().json(TokenOwnerItem { username }))
}

#[get("/file/{token}/{mode}")]
async fn file_route_redirect(
    path: web::Path<(String, String)>,
    config: web::Data<RwLock<Config>>,
) -> Result<HttpResponse, Error> {
    let (token, mode) = path.into_inner();
    if !matches!(mode.as_str(), "preview" | "raw" | "download") {
        return Err(error::ErrorNotFound("file is not found or expired :(\n"));
    }
    let config = config
        .read()
        .map_err(|_| error::ErrorInternalServerError("cannot acquire config"))?;
    let clean_token = token.split('+').next().unwrap_or(token.as_str());
    let resolved = resolve_token_to_file(clean_token, &config.server.upload_path)?;
    if matches!(mode.as_str(), "raw" | "download") && resolved.file_name.ends_with(".rpenc") {
        return Ok(HttpResponse::Found()
            .append_header(("Location", format!("/file/{token}/preview")))
            .append_header(("Cache-Control", "no-store"))
            .finish());
    }
    Ok(HttpResponse::Found()
        .append_header(("Location", public_path_from_file_name(&resolved.file_name)))
        .append_header(("Cache-Control", "no-store"))
        .finish())
}

/// Remove a file from the upload directory.
#[delete("/{file}")]
#[actix_web_grants::protect("TokenType::Delete", ty = TokenType, error = unauthorized_error)]
async fn delete(
    request: HttpRequest,
    file: web::Path<String>,
    config: web::Data<RwLock<Config>>,
) -> Result<HttpResponse, Error> {
    let config = config
        .read()
        .map_err(|_| error::ErrorInternalServerError("cannot acquire config"))?;

    // Use token-specific upload path
    let upload_path = get_upload_path_for_token(&request, &config);
    let path = util::glob_match_file(safe_path_join(&upload_path, &*file)?)?;
    let metadata_path = metadata_file_path(&upload_path, &file);
    if !path.is_file() || !path.exists() {
        return Err(error::ErrorNotFound("file is not found or expired :(\n"));
    }
    let deleted_size = path.metadata().map(|metadata| metadata.len()).unwrap_or(0);
    match fs::remove_file(&path) {
        Ok(_) => info!("deleted file: {:?}", file.to_string()),
        Err(e) => {
            error!("cannot delete file: {}", e);
            return Err(error::ErrorInternalServerError("cannot delete file"));
        }
    }
    let _ = fs::remove_file(metadata_path);
    let owner =
        get_auth_token(&request, &config).and_then(|token| lookup_username_for_token(&token));
    crate::admin::dispatch_webhook(
        "file.deleted",
        json!({
            "file": file.to_string(),
            "owner": owner,
            "bytes_removed": deleted_size,
        }),
    );
    Ok(HttpResponse::Ok().body(String::from("file deleted\n")))
}

/// Expose version endpoint
#[get("/version")]
#[actix_web_grants::protect("TokenType::Auth", ty = TokenType, error = unauthorized_error)]
async fn version(config: web::Data<RwLock<Config>>) -> Result<HttpResponse, Error> {
    let config = config
        .read()
        .map_err(|_| error::ErrorInternalServerError("cannot acquire config"))?;
    if !config.server.expose_version.unwrap_or(false) {
        warn!("server is not configured to expose version endpoint");
        Err(error::ErrorNotFound(""))?;
    }

    let version = env!("CARGO_PKG_VERSION");
    Ok(HttpResponse::Ok().body(version.to_owned() + "\n"))
}

/// Handles file upload by processing `multipart/form-data`.
#[post("/")]
#[actix_web_grants::protect("TokenType::Auth", ty = TokenType, error = unauthorized_error)]
async fn upload(
    request: HttpRequest,
    mut payload: Multipart,
    client: web::Data<Client>,
    config: web::Data<RwLock<Config>>,
) -> Result<HttpResponse, Error> {
    let connection = request.connection_info().clone();
    let host = connection.realip_remote_addr().unwrap_or("unknown host");
    // Public file links always belong to the UI origin. The persisted admin
    // API setting may point at a separate API host in split deployments.
    let server_url = match config
        .read()
        .map_err(|_| error::ErrorInternalServerError("cannot acquire config"))
        .map(|config| config.server.url.clone())
    {
        Ok(Some(value)) if !value.trim().is_empty() => value.trim().trim_end_matches('/').to_string(),
        _ => env::var("PASTE_URL")
            .ok()
            .map(|value| value.trim().trim_end_matches('/').to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "http://localhost:8080".to_string()),
    };
    let time = util::get_system_time()?;
    let mut expiry_date = header::parse_expiry_date(request.headers(), time)?;
    if expiry_date.is_none() {
        expiry_date = config
            .read()
            .map_err(|_| error::ErrorInternalServerError("cannot acquire config"))?
            .paste
            .default_expiry
            .and_then(|v| time.checked_add(v).map(|t| t.as_millis()));
    }

    // Get the token-specific upload path
    let token_upload_path = {
        let config = config
            .read()
            .map_err(|_| error::ErrorInternalServerError("cannot acquire config"))?;
        get_upload_path_for_token(&request, &config)
    };

    // Create the token-specific directory if it doesn't exist
    fs::create_dir_all(&token_upload_path)?;
    for paste_type in &[PasteType::Url, PasteType::Oneshot, PasteType::OneshotUrl] {
        fs::create_dir_all(paste_type.get_path(&token_upload_path)?)?;
    }

    let header_filename = header::parse_header_filename(request.headers())?;
    let mut urls: Vec<String> = Vec::new();
    let mut upload_meta = UploadMetaField::default();
    let sharex_client = request
        .headers()
        .get("X-Upload-Client")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("ShareX"));
    if sharex_client {
        upload_meta.source = "ShareX".to_string();
        let config_snapshot = config
            .read()
            .map_err(|_| error::ErrorInternalServerError("cannot acquire config"))?
            .clone();
        if let Some(token) = get_auth_token(&request, &config_snapshot) {
            upload_meta.uploader = lookup_username_for_token(&token).unwrap_or_default();
        }
    }
    while let Some(item) = payload.next().await {
        let mut field = item?;
        let content = ContentDisposition::from(
            field
                .content_disposition()
                .ok_or_else(|| {
                    error::ErrorInternalServerError("payload must contain content disposition")
                })?
                .clone(),
        );
        if content.has_form_field("meta") {
            let bytes = read_multipart_field_bytes(&mut field).await?;
            if !bytes.is_empty() {
                match serde_json::from_slice::<UploadMetaField>(&bytes) {
                    Ok(value) => upload_meta = value,
                    Err(e) => warn!("{} sent invalid upload metadata: {}", host, e),
                }
            }
            continue;
        }
        if content.has_form_field("uploader") {
            let value = String::from_utf8_lossy(&read_multipart_field_bytes(&mut field).await?)
                .trim()
                .to_string();
            if !value.is_empty() {
                upload_meta.uploader = value;
            }
            continue;
        }
        if content.has_form_field("source") {
            let value = String::from_utf8_lossy(&read_multipart_field_bytes(&mut field).await?)
                .trim()
                .to_string();
            if !value.is_empty() {
                upload_meta.source = value;
            }
            continue;
        }
        if content.has_form_field("originalName") || content.has_form_field("original_name") {
            let value = String::from_utf8_lossy(&read_multipart_field_bytes(&mut field).await?)
                .trim()
                .to_string();
            if !value.is_empty() {
                upload_meta.original_name = value;
            }
            continue;
        }
        if content.has_form_field("keepFileName") || content.has_form_field("keep_file_name") {
            let value = String::from_utf8_lossy(&read_multipart_field_bytes(&mut field).await?)
                .trim()
                .to_ascii_lowercase();
            upload_meta.keep_file_name = matches!(value.as_str(), "1" | "true" | "yes" | "on");
            continue;
        }
        if let Ok(paste_type) = PasteType::try_from(&content) {
            let mut bytes = Vec::<u8>::new();
            while let Some(chunk) = field.next().await {
                bytes.append(&mut chunk?.to_vec());
            }
            if bytes.is_empty() {
                warn!("{} sent zero bytes", host);
                return Err(error::ErrorBadRequest("invalid file size"));
            }
            if let Some(limit) = crate::admin::file_size_limit_bytes() {
                if bytes.len() as u64 > limit {
                    return Err(error::ErrorPayloadTooLarge(format!(
                        "file exceeds the configured {} limit",
                        Byte::from_u64(limit).get_appropriate_unit(UnitType::Decimal)
                    )));
                }
            }
            if paste_type != PasteType::Oneshot
                && paste_type != PasteType::RemoteFile
                && paste_type != PasteType::OneshotUrl
                && expiry_date.is_none()
                && !config
                    .read()
                    .map_err(|_| error::ErrorInternalServerError("cannot acquire config"))?
                    .paste
                    .duplicate_files
                    .unwrap_or(true)
            {
                let bytes_checksum = util::sha256_digest(&*bytes)?;
                // Check for duplicate files in the token-specific directory
                if let Some(file) =
                    Directory::try_from(token_upload_path.as_path())?.get_file(bytes_checksum)
                {
                    let duplicate_name = file
                        .path
                        .file_name()
                        .map(|v| v.to_string_lossy().to_string())
                        .unwrap_or_default();
                    urls.push(format!(
                        "{}{}\n",
                        server_url,
                        public_path_from_file_name(&duplicate_name)
                    ));
                    continue;
                }
            }
            let mut paste = Paste {
                data: bytes.to_vec(),
                type_: paste_type,
            };
            let mut file_name = match paste.type_ {
                PasteType::File | PasteType::Oneshot => {
                    let config = config
                        .read()
                        .map_err(|_| error::ErrorInternalServerError("cannot acquire config"))?;
                    // Create a config clone with the token-specific upload path
                    let mut upload_config = config.clone();
                    upload_config.server.upload_path = token_upload_path.clone();
                    paste.store_file(
                        content.get_file_name()?,
                        expiry_date,
                        header_filename.clone(),
                        &upload_config,
                    )?
                }
                PasteType::RemoteFile => {
                    if env::var("REMOTE_UPLOADS_ENABLED").ok().as_deref() != Some("1") {
                        return Err(error::ErrorForbidden("remote uploads are disabled"));
                    }
                    // Create a config with the token-specific upload path for remote file
                    let mut upload_config = config
                        .read()
                        .map_err(|_| error::ErrorInternalServerError("cannot acquire config"))?
                        .clone();
                    upload_config.server.upload_path = token_upload_path.clone();
                    paste
                        .store_remote_file(expiry_date, &client, &RwLock::new(upload_config))
                        .await?
                }
                PasteType::Url | PasteType::OneshotUrl => {
                    let config = config
                        .read()
                        .map_err(|_| error::ErrorInternalServerError("cannot acquire config"))?;
                    // Create a config clone with the token-specific upload path
                    let mut upload_config = config.clone();
                    upload_config.server.upload_path = token_upload_path.clone();
                    paste.store_url(expiry_date, header_filename.clone(), &upload_config)?
                }
            };
            info!(
                "{} ({}) is uploaded from {}",
                file_name,
                Byte::from_u128(paste.data.len() as u128)
                    .unwrap_or_default()
                    .get_appropriate_unit(UnitType::Decimal),
                host
            );
            let config = config
                .read()
                .map_err(|_| error::ErrorInternalServerError("cannot acquire config"))?;
            if let Some(handle_spaces_config) = config.server.handle_spaces {
                file_name = handle_spaces_config.process_filename(&file_name);
            }
            if matches!(
                paste_type,
                PasteType::File | PasteType::RemoteFile | PasteType::Oneshot
            ) {
                let stored_name = stored_file_name(&file_name, expiry_date);
                if let Err(e) =
                    persist_upload_metadata(&token_upload_path, &stored_name, &upload_meta)
                {
                    warn!("cannot store upload metadata for {}: {}", stored_name, e);
                }
            }
            crate::admin::dispatch_webhook(
                "file.uploaded",
                json!({
                    "file": file_name.clone(),
                    "url": format!("{}{}", server_url, public_path_from_file_name(&file_name)),
                    "uploader": upload_meta.uploader.clone(),
                    "source": upload_meta.source.clone(),
                    "original_name": upload_meta.original_name.clone(),
                    "size_bytes": paste.data.len(),
                }),
            );
            urls.push(format!(
                "{}{}\n",
                server_url,
                public_path_from_file_name(&file_name)
            ));
        } else {
            warn!("{} sent an invalid form field", host);
            return Err(error::ErrorBadRequest("invalid form field"));
        }
    }
    Ok(HttpResponse::Ok().body(urls.join("")))
}

/// File entry item for list endpoint.
#[derive(Serialize, Deserialize)]
pub struct ListItem {
    /// Uploaded file name.
    pub file_name: PathBuf,
    /// Size of the file in bytes.
    pub file_size: u64,
    /// ISO8601 formatted date-time of the moment the file was created (uploaded).
    pub creation_date_utc: Option<String>,
    /// ISO8601 formatted date-time string of the expiration timestamp if one exists for this file.
    pub expires_at_utc: Option<String>,
}

/// Returns the list of files.
#[get("/list")]
#[actix_web_grants::protect("TokenType::Auth", ty = TokenType, error = unauthorized_error)]
async fn list(
    request: HttpRequest,
    config: web::Data<RwLock<Config>>,
) -> Result<HttpResponse, Error> {
    let config = config
        .read()
        .map_err(|_| error::ErrorInternalServerError("cannot acquire config"))?
        .clone();
    if !config.server.expose_list.unwrap_or(false) {
        warn!("server is not configured to expose list endpoint");
        Err(error::ErrorNotFound(""))?;
    }

    // Use token-specific upload path
    let upload_path = get_upload_path_for_token(&request, &config);

    // If the upload path doesn't exist, return an empty list
    let entries: Vec<ListItem> = match fs::read_dir(&upload_path) {
        Ok(read_dir) => read_dir
            .filter_map(|entry| {
                entry.ok().and_then(|e| {
                    let metadata = match e.metadata() {
                        Ok(metadata) => {
                            if metadata.is_dir() {
                                return None;
                            }
                            metadata
                        }
                        Err(e) => {
                            error!("failed to read metadata: {e}");
                            return None;
                        }
                    };
                    let mut file_name = PathBuf::from(e.file_name());

                    let creation_date_utc = metadata.created().ok().map(|v| {
                        let millis = v
                            .duration_since(UNIX_EPOCH)
                            .expect("Time since UNIX epoch should be valid.")
                            .as_millis();
                        uts2ts::uts2ts(
                            i64::try_from(millis)
                                .expect("UNIX time should be smaller than i64::MAX")
                                / 1000,
                        )
                        .as_string()
                    });

                    let expires_at_utc = if let Some(expiration) = file_name
                        .extension()
                        .and_then(|ext| ext.to_str())
                        .and_then(|v| v.parse::<i64>().ok())
                    {
                        file_name.set_extension("");
                        if util::get_system_time().ok()?
                            > Duration::from_millis(expiration.try_into().ok()?)
                        {
                            return None;
                        }
                        Some(uts2ts::uts2ts(expiration / 1000).as_string())
                    } else {
                        None
                    };
                    Some(ListItem {
                        file_name,
                        file_size: metadata.len(),
                        creation_date_utc,
                        expires_at_utc,
                    })
                })
            })
            .collect(),
        Err(_) => Vec::new(),
    };
    Ok(HttpResponse::Ok().json(entries))
}

/// Configures the server routes.
pub fn configure_routes(cfg: &mut web::ServiceConfig) {
    cfg.service(web::scope("/auth").configure(crate::account_auth::configure_routes));
    cfg.service(
        web::scope("")
            .service(index)
            .service(resolve)
            .service(token_owner)
            .service(version)
            .service(list)
            .service(public_meta)
            .service(file_route_redirect)
            .service(serve_short)
            .service(serve)
            .service(upload)
            .service(delete)
            .route("", web::head().to(HttpResponse::MethodNotAllowed))
            .wrap(GrantsMiddleware::with_extractor(extract_tokens))
            .wrap(
                ErrorHandlers::new().handler(StatusCode::UNAUTHORIZED, handle_unauthorized_error),
            ),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{CorsConfig, LandingPageConfig};
    use crate::middleware::ContentLengthLimiter;
    use crate::random::{RandomURLConfig, RandomURLType};
    use actix_web::body::MessageBody;
    use actix_web::body::{BodySize, BoxBody};
    use actix_web::error::Error;
    use actix_web::http::header::AUTHORIZATION;
    use actix_web::http::{header, StatusCode};
    use actix_web::test::{self, TestRequest};
    use actix_web::web::Data;
    use actix_web::App;
    use awc::ClientBuilder;
    use glob::glob;

    #[test]
    fn test_stored_file_name_matches_store_file_suffixing() {
        // No expiry: the on-disk name is exactly the returned name.
        assert_eq!("ZSlZjhsX.jpg", stored_file_name("ZSlZjhsX.jpg", None));
        // With expiry: `Paste::store_file` writes `<name>.<millis>` to disk
        // while still returning `<name>` - metadata must key off the former.
        assert_eq!(
            "ZSlZjhsX.jpg.1784356059807",
            stored_file_name("ZSlZjhsX.jpg", Some(1784356059807))
        );
    }

    #[test]
    fn test_resolve_token_finds_timestamped_account_upload() -> Result<(), Error> {
        let upload_path = env::temp_dir().join(format!(
            "rustypaste-resolve-account-upload-{}",
            std::process::id()
        ));
        let account_dir = upload_path.join(token_to_dir_name("account-upload-token"));
        fs::create_dir_all(&account_dir)?;
        let stored_path = account_dir.join("Iv5BL2Oi.txt.1785792991336");
        fs::write(&stored_path, b"account upload")?;
        #[cfg(unix)]
        std::os::unix::fs::symlink(&stored_path, upload_path.join("Iv5BL2Oi.txt"))?;

        let resolved = resolve_token_to_file("Iv5BL2Oi", &upload_path)?;
        assert_eq!(resolved.file_name, "Iv5BL2Oi.txt.1785792991336");
        assert_eq!(resolved.owner_token.as_deref(), Some("account-upload-token"));

        fs::remove_dir_all(upload_path)?;
        Ok(())
    }

    use std::fs::File;
    use std::io::Write;
    use std::path::PathBuf;
    use std::str;
    use std::thread;
    use std::time::Duration;

    fn get_multipart_request(data: &str, name: &str, filename: &str) -> TestRequest {
        let multipart_data = format!(
            "\r\n\
             --multipart_bound\r\n\
             Content-Disposition: form-data; name=\"{}\"; filename=\"{}\"\r\n\
             Content-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\n\r\n\
             {}\r\n\
             --multipart_bound--\r\n",
            name,
            filename,
            data.len(),
            data,
        );
        TestRequest::post()
            .insert_header((
                header::CONTENT_TYPE,
                header::HeaderValue::from_static("multipart/mixed; boundary=\"multipart_bound\""),
            ))
            .insert_header((
                header::CONTENT_LENGTH,
                header::HeaderValue::from_str(&data.len().to_string())
                    .expect("cannot create header value"),
            ))
            .set_payload(multipart_data)
    }

    fn get_multipart_request_with_fields(
        data: &str,
        name: &str,
        filename: &str,
        fields: &[(&str, &str)],
    ) -> TestRequest {
        let mut multipart_data = String::from("\r\n");
        for (field_name, field_value) in fields {
            multipart_data.push_str(&format!(
                "--multipart_bound\r\n\
                 Content-Disposition: form-data; name=\"{}\"\r\n\r\n\
                 {}\r\n",
                field_name, field_value
            ));
        }
        multipart_data.push_str(&format!(
            "--multipart_bound\r\n\
             Content-Disposition: form-data; name=\"{}\"; filename=\"{}\"\r\n\
             Content-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\n\r\n\
             {}\r\n\
             --multipart_bound--\r\n",
            name,
            filename,
            data.len(),
            data,
        ));
        TestRequest::post()
            .insert_header((
                header::CONTENT_TYPE,
                header::HeaderValue::from_static("multipart/mixed; boundary=\"multipart_bound\""),
            ))
            .insert_header((
                header::CONTENT_LENGTH,
                header::HeaderValue::from_str(&multipart_data.len().to_string())
                    .expect("cannot create header value"),
            ))
            .set_payload(multipart_data)
    }

    async fn assert_body(body: BoxBody, expected: &str) -> Result<(), Error> {
        if let BodySize::Sized(size) = body.size() {
            assert_eq!(size, expected.len() as u64);
            let body_bytes = actix_web::body::to_bytes(body).await?;
            let body_text = str::from_utf8(&body_bytes)?;
            assert_eq!(expected, body_text);
            Ok(())
        } else {
            Err(error::ErrorInternalServerError("unexpected body type"))
        }
    }

    #[actix_web::test]
    async fn test_index() {
        let config = Config::default();
        let app = test::init_service(
            App::new()
                .app_data(Data::new(RwLock::new(config)))
                .service(index),
        )
        .await;
        let request = TestRequest::default()
            .insert_header(("content-type", "text/plain"))
            .to_request();
        let response = test::call_service(&app, request).await;
        assert_eq!(StatusCode::FOUND, response.status());
    }

    #[actix_web::test]
    async fn test_index_with_landing_page() -> Result<(), Error> {
        let config = Config {
            landing_page: Some(LandingPageConfig {
                text: Some(String::from("landing page")),
                ..Default::default()
            }),
            ..Default::default()
        };
        let app = test::init_service(
            App::new()
                .app_data(Data::new(RwLock::new(config)))
                .service(index),
        )
        .await;
        let request = TestRequest::default()
            .insert_header(("content-type", "text/plain"))
            .to_request();
        let response = test::call_service(&app, request).await;
        assert_eq!(StatusCode::OK, response.status());
        assert_body(response.into_body(), "landing page").await?;
        Ok(())
    }

    #[actix_web::test]
    async fn test_index_with_landing_page_file() -> Result<(), Error> {
        let filename = "landing_page.txt";
        let config = Config {
            landing_page: Some(LandingPageConfig {
                file: Some(filename.to_string()),
                ..Default::default()
            }),
            ..Default::default()
        };
        let mut file = File::create(filename)?;
        file.write_all("landing page from file".as_bytes())?;
        let app = test::init_service(
            App::new()
                .app_data(Data::new(RwLock::new(config)))
                .service(index),
        )
        .await;
        let request = TestRequest::default()
            .insert_header(("content-type", "text/plain"))
            .to_request();
        let response = test::call_service(&app, request).await;
        assert_eq!(StatusCode::OK, response.status());
        assert_body(response.into_body(), "landing page from file").await?;
        fs::remove_file(filename)?;
        Ok(())
    }

    #[actix_web::test]
    async fn test_index_with_landing_page_file_not_found() -> Result<(), Error> {
        let filename = "landing_page.txt";
        let config = Config {
            landing_page: Some(LandingPageConfig {
                text: Some(String::from("landing page")),
                file: Some(filename.to_string()),
                ..Default::default()
            }),
            ..Default::default()
        };
        let app = test::init_service(
            App::new()
                .app_data(Data::new(RwLock::new(config)))
                .service(index),
        )
        .await;
        let request = TestRequest::default()
            .insert_header(("content-type", "text/plain"))
            .to_request();
        let response = test::call_service(&app, request).await;
        assert_eq!(StatusCode::FOUND, response.status());
        Ok(())
    }

    #[actix_web::test]
    async fn test_version_without_auth() -> Result<(), Error> {
        let mut config = Config::default();
        config.server.auth_tokens = Some(["test".to_string()].into());
        let app = test::init_service(
            App::new()
                .app_data(Data::new(RwLock::new(config)))
                .app_data(Data::new(Client::default()))
                .configure(configure_routes),
        )
        .await;

        let request = TestRequest::default()
            .insert_header(("content-type", "text/plain"))
            .uri("/version")
            .to_request();
        let response = test::call_service(&app, request).await;
        assert_eq!(StatusCode::UNAUTHORIZED, response.status());
        assert_body(response.into_body(), "unauthorized\n").await?;
        Ok(())
    }

    #[actix_web::test]
    async fn test_version_without_config() -> Result<(), Error> {
        let app = test::init_service(
            App::new()
                .app_data(Data::new(RwLock::new(Config::default())))
                .app_data(Data::new(Client::default()))
                .configure(configure_routes),
        )
        .await;

        let request = TestRequest::default()
            .insert_header(("content-type", "text/plain"))
            .uri("/version")
            .to_request();
        let response = test::call_service(&app, request).await;
        assert_eq!(StatusCode::NOT_FOUND, response.status());
        assert_body(response.into_body(), "").await?;
        Ok(())
    }

    #[actix_web::test]
    async fn test_version() -> Result<(), Error> {
        let mut config = Config::default();
        config.server.expose_version = Some(true);
        let app = test::init_service(
            App::new()
                .app_data(Data::new(RwLock::new(config)))
                .app_data(Data::new(Client::default()))
                .configure(configure_routes),
        )
        .await;

        let request = TestRequest::default()
            .insert_header(("content-type", "text/plain"))
            .uri("/version")
            .to_request();
        let response = test::call_service(&app, request).await;
        assert_eq!(StatusCode::OK, response.status());
        assert_body(
            response.into_body(),
            &(env!("CARGO_PKG_VERSION").to_owned() + "\n"),
        )
        .await?;
        Ok(())
    }

    #[actix_web::test]
    async fn test_list() -> Result<(), Error> {
        let mut config = Config::default();
        config.server.expose_list = Some(true);

        let test_upload_dir = "test_upload";
        fs::create_dir(test_upload_dir)?;
        config.server.upload_path = PathBuf::from(test_upload_dir);

        let app = test::init_service(
            App::new()
                .app_data(Data::new(RwLock::new(config)))
                .app_data(Data::new(Client::default()))
                .configure(configure_routes),
        )
        .await;

        let filename = "test_file.txt";
        let timestamp = util::get_system_time()?.as_secs().to_string();
        test::call_service(
            &app,
            get_multipart_request(&timestamp, "file", filename).to_request(),
        )
        .await;

        let request = TestRequest::default()
            .insert_header(("content-type", "text/plain"))
            .uri("/list")
            .to_request();
        let result: Vec<ListItem> = test::call_and_read_body_json(&app, request).await;

        assert_eq!(result.len(), 1);
        assert_eq!(
            result.first().expect("json object").file_name,
            PathBuf::from(filename)
        );

        fs::remove_dir_all(test_upload_dir)?;

        Ok(())
    }

    #[test]
    fn test_account_token_uses_a_separate_upload_directory() {
        let db_path = env::temp_dir().join(format!(
            "rustypaste-account-upload-path-{}.sqlite",
            std::process::id()
        ));
        let upload_path = env::temp_dir().join(format!(
            "rustypaste-account-upload-path-{}",
            std::process::id()
        ));
        let token = "account-history-token";
        let connection = Connection::open(&db_path).expect("cannot create account test database");
        crate::account_auth::init_db(&connection).expect("cannot initialize account test database");
        connection
            .execute(
                "INSERT INTO users (username, password, token, created_at) VALUES (?1, ?2, ?3, ?4)",
                ("history-user", "unused", token, 0),
            )
            .expect("cannot create account test user");
        drop(connection);

        unsafe { env::set_var("DB_PATH", &db_path) };
        let mut config = Config::default();
        config.server.upload_path = upload_path.clone();
        let request = TestRequest::default()
            .insert_header((AUTHORIZATION, token))
            .to_http_request();

        assert_eq!(
            get_upload_path_for_token(&request, &config),
            upload_path.join(token_to_dir_name(token))
        );

        unsafe { env::remove_var("DB_PATH") };
        fs::remove_file(db_path).expect("cannot remove account test database");
    }

    #[actix_web::test]
    async fn test_list_expired() -> Result<(), Error> {
        let mut config = Config::default();
        config.server.expose_list = Some(true);

        let test_upload_dir = "test_upload";
        fs::create_dir(test_upload_dir)?;
        config.server.upload_path = PathBuf::from(test_upload_dir);

        let app = test::init_service(
            App::new()
                .app_data(Data::new(RwLock::new(config)))
                .app_data(Data::new(Client::default()))
                .configure(configure_routes),
        )
        .await;

        let filename = "test_file.txt";
        let timestamp = util::get_system_time()?.as_secs().to_string();
        test::call_service(
            &app,
            get_multipart_request(&timestamp, "file", filename)
                .insert_header((
                    header::HeaderName::from_static("expire"),
                    header::HeaderValue::from_static("50ms"),
                ))
                .to_request(),
        )
        .await;

        thread::sleep(Duration::from_millis(500));

        let request = TestRequest::default()
            .insert_header(("content-type", "text/plain"))
            .uri("/list")
            .to_request();
        let result: Vec<ListItem> = test::call_and_read_body_json(&app, request).await;

        assert!(result.is_empty());

        fs::remove_dir_all(test_upload_dir)?;

        Ok(())
    }

    #[actix_web::test]
    async fn test_per_token_storage() -> Result<(), Error> {
        let mut config = Config::default();
        config.server.expose_list = Some(true);

        let test_upload_dir = "test_upload_per_token";
        fs::create_dir_all(test_upload_dir)?;
        config.server.upload_path = PathBuf::from(test_upload_dir);

        // Set up auth tokens
        let token1 = "token1";
        let token2 = "token2";
        config.server.auth_tokens = Some([token1.to_string(), token2.to_string()].into());

        let app = test::init_service(
            App::new()
                .app_data(Data::new(RwLock::new(config.clone())))
                .app_data(Data::new(Client::default()))
                .configure(configure_routes),
        )
        .await;

        // Upload a file using token1
        let filename1 = "token1_file.txt";
        let content1 = "content from token1";
        let response1 = test::call_service(
            &app,
            get_multipart_request(content1, "file", filename1)
                .insert_header((
                    AUTHORIZATION,
                    header::HeaderValue::from_static("basic token1"),
                ))
                .to_request(),
        )
        .await;
        assert_eq!(StatusCode::OK, response1.status());

        // Upload a file using token2
        let filename2 = "token2_file.txt";
        let content2 = "content from token2";
        let response2 = test::call_service(
            &app,
            get_multipart_request(content2, "file", filename2)
                .insert_header((
                    AUTHORIZATION,
                    header::HeaderValue::from_static("basic token2"),
                ))
                .to_request(),
        )
        .await;
        assert_eq!(StatusCode::OK, response2.status());

        // Verify files are stored in token-specific directories
        let token1_dir = PathBuf::from(test_upload_dir).join(util::token_to_dir_name(token1));
        let token2_dir = PathBuf::from(test_upload_dir).join(util::token_to_dir_name(token2));

        assert!(
            token1_dir.join(filename1).exists(),
            "File should exist in token1's directory"
        );
        assert!(
            token2_dir.join(filename2).exists(),
            "File should exist in token2's directory"
        );
        assert!(
            !token1_dir.join(filename2).exists(),
            "Token2's file should NOT be in token1's directory"
        );
        assert!(
            !token2_dir.join(filename1).exists(),
            "Token1's file should NOT be in token2's directory"
        );

        // List files using token1 - should only see token1's file
        let list_request1 = TestRequest::get()
            .uri("/list")
            .insert_header((
                AUTHORIZATION,
                header::HeaderValue::from_static("basic token1"),
            ))
            .to_request();
        let result1: Vec<ListItem> = test::call_and_read_body_json(&app, list_request1).await;
        assert_eq!(result1.len(), 1);
        assert_eq!(result1[0].file_name, PathBuf::from(filename1));

        // List files using token2 - should only see token2's file
        let list_request2 = TestRequest::get()
            .uri("/list")
            .insert_header((
                AUTHORIZATION,
                header::HeaderValue::from_static("basic token2"),
            ))
            .to_request();
        let result2: Vec<ListItem> = test::call_and_read_body_json(&app, list_request2).await;
        assert_eq!(result2.len(), 1);
        assert_eq!(result2[0].file_name, PathBuf::from(filename2));

        // Verify that token1 can still access token2's file via serve endpoint
        let serve_request = TestRequest::get()
            .uri(&format!("/{filename2}"))
            .insert_header((
                AUTHORIZATION,
                header::HeaderValue::from_static("basic token1"),
            ))
            .to_request();
        let serve_response = test::call_service(&app, serve_request).await;
        assert_eq!(StatusCode::OK, serve_response.status());

        // Clean up
        fs::remove_dir_all(test_upload_dir)?;

        Ok(())
    }

    #[actix_web::test]
    async fn test_unified_tokens() -> Result<(), Error> {
        let mut config = Config::default();
        config.server.expose_list = Some(true);

        let test_upload_dir = "test_upload_unified_tokens";
        fs::create_dir_all(test_upload_dir)?;
        config.server.upload_path = PathBuf::from(test_upload_dir);

        // Set up unified tokens (works for both auth and delete)
        let token1 = "unified_token1";
        let token2 = "unified_token2";
        config.server.tokens = Some([token1.to_string(), token2.to_string()].into());

        let app = test::init_service(
            App::new()
                .app_data(Data::new(RwLock::new(config.clone())))
                .app_data(Data::new(Client::default()))
                .configure(configure_routes),
        )
        .await;

        // Upload a file using token1
        let filename1 = "unified_token1_file.txt";
        let content1 = "content from unified_token1";
        let response1 = test::call_service(
            &app,
            get_multipart_request(content1, "file", filename1)
                .insert_header((
                    AUTHORIZATION,
                    header::HeaderValue::from_static("basic unified_token1"),
                ))
                .to_request(),
        )
        .await;
        assert_eq!(StatusCode::OK, response1.status());

        // Upload a file using token2
        let filename2 = "unified_token2_file.txt";
        let content2 = "content from unified_token2";
        let response2 = test::call_service(
            &app,
            get_multipart_request(content2, "file", filename2)
                .insert_header((
                    AUTHORIZATION,
                    header::HeaderValue::from_static("basic unified_token2"),
                ))
                .to_request(),
        )
        .await;
        assert_eq!(StatusCode::OK, response2.status());

        // Verify files are stored in token-specific directories
        let token1_dir = PathBuf::from(test_upload_dir).join(util::token_to_dir_name(token1));
        let token2_dir = PathBuf::from(test_upload_dir).join(util::token_to_dir_name(token2));

        assert!(
            token1_dir.join(filename1).exists(),
            "File should exist in token1's directory"
        );
        assert!(
            token2_dir.join(filename2).exists(),
            "File should exist in token2's directory"
        );

        // Token1 can delete their own file
        let delete_own_request = TestRequest::delete()
            .uri(&format!("/{filename1}"))
            .insert_header((
                AUTHORIZATION,
                header::HeaderValue::from_static("basic unified_token1"),
            ))
            .to_request();
        let delete_response = test::call_service(&app, delete_own_request).await;
        assert_eq!(StatusCode::OK, delete_response.status());
        assert!(!token1_dir.join(filename1).exists());

        // Token1 CANNOT delete token2's file (should fail with 404 - file not found in their folder)
        let delete_others_request = TestRequest::delete()
            .uri(&format!("/{filename2}"))
            .insert_header((
                AUTHORIZATION,
                header::HeaderValue::from_static("basic unified_token1"),
            ))
            .to_request();
        let delete_response = test::call_service(&app, delete_others_request).await;
        assert_eq!(StatusCode::NOT_FOUND, delete_response.status());
        assert!(
            token2_dir.join(filename2).exists(),
            "Token2's file should still exist"
        );

        // Clean up
        fs::remove_dir_all(test_upload_dir)?;

        Ok(())
    }

    #[actix_web::test]
    async fn test_auth() -> Result<(), Error> {
        let mut config = Config::default();
        config.server.auth_tokens = Some(["test".to_string()].into());

        let app = test::init_service(
            App::new()
                .app_data(Data::new(RwLock::new(config)))
                .app_data(Data::new(Client::default()))
                .configure(configure_routes),
        )
        .await;

        let response =
            test::call_service(&app, get_multipart_request("", "", "").to_request()).await;
        assert_eq!(StatusCode::UNAUTHORIZED, response.status());
        assert_body(response.into_body(), "unauthorized\n").await?;

        Ok(())
    }

    #[actix_web::test]
    async fn test_payload_limit() -> Result<(), Error> {
        let app = test::init_service(
            App::new()
                .app_data(Data::new(RwLock::new(Config::default())))
                .app_data(Data::new(Client::default()))
                .wrap(ContentLengthLimiter::new(Byte::from_u64(1)))
                .configure(configure_routes),
        )
        .await;

        let response = test::call_service(
            &app,
            get_multipart_request("test", "file", "test").to_request(),
        )
        .await;
        assert_eq!(StatusCode::PAYLOAD_TOO_LARGE, response.status());
        assert_body(response.into_body().boxed(), "upload limit exceeded").await?;

        Ok(())
    }

    #[actix_web::test]
    async fn test_delete_file() -> Result<(), Error> {
        let mut config = Config::default();
        config.server.delete_tokens = Some(["test".to_string()].into());
        config.server.upload_path = env::current_dir()?;

        let app = test::init_service(
            App::new()
                .app_data(Data::new(RwLock::new(config)))
                .app_data(Data::new(Client::default()))
                .configure(configure_routes),
        )
        .await;

        let file_name = "test_file.txt";
        let timestamp = util::get_system_time()?.as_secs().to_string();
        test::call_service(
            &app,
            get_multipart_request(&timestamp, "file", file_name).to_request(),
        )
        .await;

        let request = TestRequest::delete()
            .insert_header((AUTHORIZATION, header::HeaderValue::from_static("test")))
            .uri(&format!("/{file_name}"))
            .to_request();
        let response = test::call_service(&app, request).await;

        assert_eq!(StatusCode::OK, response.status());
        assert_body(response.into_body(), "file deleted\n").await?;

        let path = PathBuf::from(file_name);
        assert!(!path.exists());

        Ok(())
    }

    #[actix_web::test]
    async fn test_delete_file_without_token_in_config() -> Result<(), Error> {
        let mut config = Config::default();
        config.server.upload_path = env::current_dir()?;

        let app = test::init_service(
            App::new()
                .app_data(Data::new(RwLock::new(config)))
                .app_data(Data::new(Client::default()))
                .configure(configure_routes),
        )
        .await;

        let file_name = "test_file.txt";
        let request = TestRequest::delete()
            .insert_header((AUTHORIZATION, header::HeaderValue::from_static("test")))
            .uri(&format!("/{file_name}"))
            .to_request();
        let response = test::call_service(&app, request).await;

        assert_eq!(StatusCode::NOT_FOUND, response.status());
        assert_body(response.into_body(), "").await?;

        Ok(())
    }

    #[actix_web::test]
    async fn test_upload_file() -> Result<(), Error> {
        let mut config = Config::default();
        config.server.upload_path = env::current_dir()?;

        let app = test::init_service(
            App::new()
                .app_data(Data::new(RwLock::new(config)))
                .app_data(Data::new(Client::default()))
                .configure(configure_routes),
        )
        .await;

        let file_name = "test_file.txt";
        let timestamp = util::get_system_time()?.as_secs().to_string();
        let response = test::call_service(
            &app,
            get_multipart_request(&timestamp, "file", file_name).to_request(),
        )
        .await;
        assert_eq!(StatusCode::OK, response.status());
        assert_body(
            response.into_body(),
            &format!(
                "http://localhost:8080{}\n",
                public_path_from_file_name(&file_name)
            ),
        )
        .await?;

        let serve_request = TestRequest::get()
            .uri(&format!("/{file_name}"))
            .to_request();
        let response = test::call_service(&app, serve_request).await;
        assert_eq!(StatusCode::OK, response.status());
        assert_body(response.into_body(), &timestamp).await?;

        fs::remove_file(file_name)?;
        let serve_request = TestRequest::get()
            .uri(&format!("/{file_name}"))
            .to_request();
        let response = test::call_service(&app, serve_request).await;
        assert_eq!(StatusCode::NOT_FOUND, response.status());

        Ok(())
    }

    #[actix_web::test]
    async fn test_browser_file_request_redirects_to_public_ui_and_raw_query_serves_bytes() -> Result<(), Error> {
        let mut config = Config::default();
        config.server.url = Some("https://paste.example.com".to_string());
        let upload_path = env::temp_dir().join(format!("rustypaste-browser-preview-{}", std::process::id()));
        fs::create_dir_all(&upload_path)?;
        config.server.upload_path = upload_path.clone();
        let file_name = "browser-file-request.txt";
        let contents = "browser raw bytes";
        fs::write(upload_path.join(file_name), contents)?;

        let app = test::init_service(
            App::new()
                .app_data(Data::new(RwLock::new(config)))
                .app_data(Data::new(Client::default()))
                .configure(configure_routes),
        )
        .await;

        let preview_http_request = TestRequest::get()
            .uri(&format!("/{file_name}"))
            .insert_header(("Accept", "text/html"))
            .to_http_request();
        assert!(should_redirect_to_preview(&preview_http_request, file_name, false, false));
        let preview_request = TestRequest::get()
            .uri(&format!("/{file_name}"))
            .insert_header(("Accept", "text/html"))
            .to_request();
        let preview_response = test::call_service(&app, preview_request).await;
        assert_eq!(StatusCode::FOUND, preview_response.status());
        assert_eq!(
            preview_response
                .headers()
                .get("location")
                .and_then(|value| value.to_str().ok()),
            Some("https://paste.example.com/#/preview?p=/browser-file-request/file.txt")
        );

        let raw_response = test::call_service(
            &app,
            TestRequest::get()
                .uri(&format!("/{file_name}?raw=1"))
                .insert_header(("Accept", "text/html"))
                .to_request(),
        )
        .await;
        assert_eq!(StatusCode::OK, raw_response.status());
        assert_body(raw_response.into_body(), contents).await?;

        fs::remove_dir_all(upload_path)?;
        Ok(())
    }

    #[actix_web::test]
    async fn test_encrypted_file_raw_and_download_routes_redirect_to_preview() -> Result<(), Error> {
        let mut config = Config::default();
        let upload_path = env::temp_dir().join(format!(
            "rustypaste-encrypted-route-{}",
            std::process::id()
        ));
        fs::create_dir_all(&upload_path)?;
        config.server.upload_path = upload_path.clone();
        fs::write(upload_path.join("encrypted-note.txt.rpenc"), b"encrypted bytes")?;

        let app = test::init_service(
            App::new()
                .app_data(Data::new(RwLock::new(config)))
                .app_data(Data::new(Client::default()))
                .configure(configure_routes),
        )
        .await;

        for mode in ["raw", "download"] {
            let response = test::call_service(
                &app,
                TestRequest::get()
                    .uri(&format!("/file/encrypted-note+salt/{mode}"))
                    .to_request(),
            )
            .await;
            assert_eq!(StatusCode::FOUND, response.status());
            assert_eq!(
                response
                    .headers()
                    .get("location")
                    .and_then(|value| value.to_str().ok()),
                Some("/file/encrypted-note+salt/preview")
            );
        }

        fs::remove_dir_all(upload_path)?;
        Ok(())
    }

    #[actix_web::test]
    async fn test_raw_expiry_suffixed_file_uses_display_name_mime() -> Result<(), Error> {
        let mut config = Config::default();
        let upload_path =
            env::temp_dir().join(format!("rustypaste-raw-mime-{}", std::process::id()));
        fs::create_dir_all(upload_path.join(".rpmeta"))?;
        config.server.upload_path = upload_path.clone();
        let expiry = util::get_system_time()?.as_millis() + Duration::from_secs(60).as_millis();
        let file_name = format!("screenshot.jpg.{expiry}");
        fs::write(upload_path.join(&file_name), b"raw image bytes")?;
        fs::write(
            metadata_file_path(&upload_path, &file_name),
            serde_json::to_vec(&StoredUploadMeta {
                display_name: Some("screenshot.jpg".to_string()),
                uploader: Some("Unknown (token user)".to_string()),
                source: Some("WebUI".to_string()),
                password_salt: None,
            })?,
        )?;

        let app = test::init_service(
            App::new()
                .app_data(Data::new(RwLock::new(config)))
                .app_data(Data::new(Client::default()))
                .configure(configure_routes),
        )
        .await;
        let response = test::call_service(
            &app,
            TestRequest::get()
                .uri("/screenshot.jpg?raw=1")
                .insert_header(("Accept", "text/html"))
                .to_request(),
        )
        .await;

        assert_eq!(StatusCode::OK, response.status());
        assert_eq!(
            response
                .headers()
                .get("content-type")
                .and_then(|value| value.to_str().ok()),
            Some("image/jpeg")
        );
        assert_body(response.into_body(), "raw image bytes").await?;

        fs::remove_file(metadata_file_path(&upload_path, &file_name))?;
        fs::write(
            metadata_file_path(&upload_path, "screenshot.jpg"),
            serde_json::to_vec(&StoredUploadMeta {
                display_name: Some("screenshot.jpg".to_string()),
                uploader: None,
                source: None,
                password_salt: None,
            })?,
        )?;
        let legacy_response = test::call_service(
            &app,
            TestRequest::get()
                .uri("/screenshot.jpg?raw=1")
                .insert_header(("Accept", "text/html"))
                .to_request(),
        )
        .await;
        assert_eq!(
            legacy_response
                .headers()
                .get("content-type")
                .and_then(|value| value.to_str().ok()),
            Some("image/jpeg")
        );

        fs::remove_dir_all(upload_path)?;
        Ok(())
    }

    #[actix_web::test]
    async fn test_public_raw_request_finds_account_token_directory_upload() -> Result<(), Error> {
        let mut config = Config::default();
        let upload_path = env::temp_dir().join(format!(
            "rustypaste-account-public-{}",
            std::process::id()
        ));
        let account_dir = upload_path.join(token_to_dir_name("account-upload-token"));
        fs::create_dir_all(&account_dir)?;
        fs::write(account_dir.join("account-upload.txt"), "account directory upload")?;
        config.server.upload_path = upload_path.clone();

        let app = test::init_service(
            App::new()
                .app_data(Data::new(RwLock::new(config)))
                .app_data(Data::new(Client::default()))
                .configure(configure_routes),
        )
        .await;
        let response = test::call_service(
            &app,
            TestRequest::get()
                .uri("/account-upload.txt?raw=1")
                .insert_header(("Accept", "text/html"))
                .to_request(),
        )
        .await;

        assert_eq!(StatusCode::OK, response.status());
        assert_body(response.into_body(), "account directory upload").await?;

        fs::remove_dir_all(upload_path)?;
        Ok(())
    }

    #[actix_web::test]
    async fn test_upload_file_accepts_flat_sharex_metadata_fields() -> Result<(), Error> {
        let mut config = Config::default();
        config.server.upload_path = env::current_dir()?;

        let app = test::init_service(
            App::new()
                .app_data(Data::new(RwLock::new(config.clone())))
                .app_data(Data::new(Client::default()))
                .configure(configure_routes),
        )
        .await;

        let timestamp = util::get_system_time()?.as_secs().to_string();
        let file_name = format!("sharex-flat-{timestamp}.txt");
        let response = test::call_service(
            &app,
            get_multipart_request_with_fields(
                &timestamp,
                "file",
                &file_name,
                &[("uploader", "test-user (ShareX)"), ("source", "ShareX")],
            )
            .to_request(),
        )
        .await;
        assert_eq!(StatusCode::OK, response.status());
        assert_body(
            response.into_body(),
            &format!(
                "http://localhost:8080{}\n",
                public_path_from_file_name(&file_name)
            ),
        )
        .await?;

        let meta_request = TestRequest::get()
            .uri(&format!("/meta/{file_name}"))
            .to_request();
        let meta: PublicFileMeta = test::call_and_read_body_json(&app, meta_request).await;
        assert_eq!(meta.uploader, "test-user (ShareX)");
        assert_eq!(meta.source.as_deref(), Some("ShareX"));

        let metadata_path = metadata_file_path(&config.server.upload_path, &file_name);
        if metadata_path.exists() {
            fs::remove_file(metadata_path)?;
        }
        if let Ok(path) = fs::canonicalize(&file_name) {
            let _ = fs::remove_file(path);
        } else if PathBuf::from(&file_name).exists() {
            fs::remove_file(&file_name)?;
        }

        Ok(())
    }

    #[actix_web::test]
    async fn test_upload_file_marks_header_only_sharex_uploads() -> Result<(), Error> {
        let mut config = Config::default();
        let upload_path = env::temp_dir().join(format!(
            "rustypaste-sharex-header-{}",
            std::process::id()
        ));
        fs::create_dir_all(&upload_path)?;
        config.server.upload_path = upload_path.clone();
        config.server.tokens = Some(["sharex-test-token".to_string()].into());
        let app = test::init_service(
            App::new()
                .app_data(Data::new(RwLock::new(config.clone())))
                .app_data(Data::new(Client::default()))
                .configure(configure_routes),
        )
        .await;

        let timestamp = util::get_system_time()?.as_secs().to_string();
        let file_name = format!("sharex-header-{timestamp}.txt");
        let response = test::call_service(
            &app,
            get_multipart_request_with_fields(&timestamp, "file", &file_name, &[])
                .insert_header(("X-Upload-Client", "ShareX"))
                .insert_header((AUTHORIZATION, "sharex-test-token"))
                .to_request(),
        )
        .await;
        assert_eq!(StatusCode::OK, response.status());

        let meta_request = TestRequest::get()
            .uri(&format!("/meta/{file_name}"))
            .insert_header((AUTHORIZATION, "sharex-test-token"))
            .to_request();
        let meta: PublicFileMeta = test::call_and_read_body_json(&app, meta_request).await;
        assert_eq!(meta.source.as_deref(), Some("ShareX"));

        fs::remove_dir_all(upload_path)?;
        Ok(())
    }

    #[actix_web::test]
    async fn test_upload_expiring_file_metadata_uses_on_disk_name() -> Result<(), Error> {
        let mut config = Config::default();
        config.server.upload_path = env::current_dir()?;

        let app = test::init_service(
            App::new()
                .app_data(Data::new(RwLock::new(config.clone())))
                .app_data(Data::new(Client::default()))
                .configure(configure_routes),
        )
        .await;

        let timestamp = util::get_system_time()?.as_secs().to_string();
        let file_name = format!("expiring-owned-{timestamp}.txt");
        let response = test::call_service(
            &app,
            get_multipart_request_with_fields(
                &timestamp,
                "file",
                &file_name,
                &[("uploader", "regression-user"), ("source", "WebUI")],
            )
            .insert_header((
                header::HeaderName::from_static("expire"),
                header::HeaderValue::from_static("1h"),
            ))
            .to_request(),
        )
        .await;
        assert_eq!(StatusCode::OK, response.status());

        // The file on disk carries an expiry timestamp suffix that the
        // response body (and `store_file`'s return value) does not - the
        // metadata sidecar must be keyed by the suffixed on-disk name, or
        // the admin panel can never find it and reports the upload as
        // unowned/anonymous even though an uploader was provided.
        let saved = glob(&format!("{file_name}.[0-9]*"))
            .map_err(error::ErrorInternalServerError)?
            .next()
            .transpose()
            .map_err(error::ErrorInternalServerError)?
            .expect("expiring upload should be saved with a timestamp suffix");
        let saved_name = saved
            .file_name()
            .and_then(|v| v.to_str())
            .expect("saved file should have a name")
            .to_string();
        assert_ne!(saved_name, file_name, "on-disk name should carry the expiry suffix");

        let metadata_path = metadata_file_path(&config.server.upload_path, &saved_name);
        assert!(
            metadata_path.exists(),
            "metadata sidecar should exist at the on-disk (suffixed) name"
        );
        let stored: StoredUploadMeta =
            serde_json::from_str(&fs::read_to_string(&metadata_path)?)
                .map_err(error::ErrorInternalServerError)?;
        assert_eq!(stored.uploader.as_deref(), Some("regression-user"));

        fs::remove_file(metadata_path)?;
        fs::remove_file(saved)?;

        Ok(())
    }

    #[actix_web::test]
    async fn test_upload_file_override_filename() -> Result<(), Error> {
        let mut config = Config::default();
        config.server.upload_path = env::current_dir()?;

        let app = test::init_service(
            App::new()
                .app_data(Data::new(RwLock::new(config)))
                .app_data(Data::new(Client::default()))
                .configure(configure_routes),
        )
        .await;

        let file_name = "test_file.txt";
        let header_filename = "fn_from_header.txt";
        let timestamp = util::get_system_time()?.as_secs().to_string();
        let response = test::call_service(
            &app,
            get_multipart_request(&timestamp, "file", file_name)
                .insert_header((
                    header::HeaderName::from_static("filename"),
                    header::HeaderValue::from_static("fn_from_header.txt"),
                ))
                .to_request(),
        )
        .await;
        assert_eq!(StatusCode::OK, response.status());
        assert_body(
            response.into_body(),
            &format!("http://localhost:8080{}\n", public_path_from_file_name(header_filename)),
        )
        .await?;

        let serve_request = TestRequest::get()
            .uri(&format!("/{header_filename}"))
            .to_request();
        let response = test::call_service(&app, serve_request).await;
        assert_eq!(StatusCode::OK, response.status());
        assert_body(response.into_body(), &timestamp).await?;

        fs::remove_file(header_filename)?;
        let serve_request = TestRequest::get()
            .uri(&format!("/{header_filename}"))
            .to_request();
        let response = test::call_service(&app, serve_request).await;
        assert_eq!(StatusCode::NOT_FOUND, response.status());

        Ok(())
    }

    #[actix_web::test]
    async fn test_upload_same_filename() -> Result<(), Error> {
        let mut config = Config::default();
        config.server.upload_path = env::current_dir()?;

        let app = test::init_service(
            App::new()
                .app_data(Data::new(RwLock::new(config)))
                .app_data(Data::new(Client::default()))
                .configure(configure_routes),
        )
        .await;

        let file_name = "test_file.txt";
        let header_filename = "fn_from_header.txt";
        let timestamp = util::get_system_time()?.as_secs().to_string();
        let response = test::call_service(
            &app,
            get_multipart_request(&timestamp, "file", file_name)
                .insert_header((
                    header::HeaderName::from_static("filename"),
                    header::HeaderValue::from_static("fn_from_header.txt"),
                ))
                .to_request(),
        )
        .await;
        assert_eq!(StatusCode::OK, response.status());
        assert_body(
            response.into_body(),
            &format!("http://localhost:8080/fn_from_header/file.txt\n"),
        )
        .await?;

        let timestamp = util::get_system_time()?.as_secs().to_string();
        let response = test::call_service(
            &app,
            get_multipart_request(&timestamp, "file", file_name)
                .insert_header((
                    header::HeaderName::from_static("filename"),
                    header::HeaderValue::from_static("fn_from_header.txt"),
                ))
                .to_request(),
        )
        .await;
        assert_eq!(StatusCode::CONFLICT, response.status());
        assert_body(response.into_body(), "file already exists\n").await?;

        fs::remove_file(header_filename)?;

        Ok(())
    }

    #[actix_web::test]
    #[allow(deprecated)]
    async fn test_upload_duplicate_file() -> Result<(), Error> {
        let test_upload_dir = "test_upload";
        fs::create_dir(test_upload_dir)?;

        let mut config = Config::default();
        config.server.upload_path = PathBuf::from(&test_upload_dir);
        config.paste.duplicate_files = Some(false);
        config.paste.random_url = Some(RandomURLConfig {
            enabled: Some(true),
            type_: RandomURLType::Alphanumeric,
            ..Default::default()
        });

        let app = test::init_service(
            App::new()
                .app_data(Data::new(RwLock::new(config)))
                .app_data(Data::new(Client::default()))
                .configure(configure_routes),
        )
        .await;

        let response = test::call_service(
            &app,
            get_multipart_request("test", "file", "x").to_request(),
        )
        .await;
        assert_eq!(StatusCode::OK, response.status());
        let body = response.into_body();
        let first_body_bytes = actix_web::body::to_bytes(body).await?;

        let response = test::call_service(
            &app,
            get_multipart_request("test", "file", "x").to_request(),
        )
        .await;
        assert_eq!(StatusCode::OK, response.status());
        let body = response.into_body();
        let second_body_bytes = actix_web::body::to_bytes(body).await?;

        assert_eq!(first_body_bytes, second_body_bytes);

        fs::remove_dir_all(test_upload_dir)?;

        Ok(())
    }

    #[actix_web::test]
    async fn test_upload_expiring_file() -> Result<(), Error> {
        let mut config = Config::default();
        config.server.upload_path = env::current_dir()?;

        let app = test::init_service(
            App::new()
                .app_data(Data::new(RwLock::new(config)))
                .app_data(Data::new(Client::default()))
                .configure(configure_routes),
        )
        .await;

        let file_name = "test_file.txt";
        let timestamp = util::get_system_time()?.as_secs().to_string();
        let response = test::call_service(
            &app,
            get_multipart_request(&timestamp, "file", file_name)
                .insert_header((
                    header::HeaderName::from_static("expire"),
                    header::HeaderValue::from_static("20ms"),
                ))
                .to_request(),
        )
        .await;
        assert_eq!(StatusCode::OK, response.status());
        assert_body(
            response.into_body(),
            &format!("http://localhost:8080/test_file/file.txt\n"),
        )
        .await?;

        let serve_request = TestRequest::get()
            .uri(&format!("/{file_name}"))
            .to_request();
        let response = test::call_service(&app, serve_request).await;
        assert_eq!(StatusCode::OK, response.status());
        assert_body(response.into_body(), &timestamp).await?;

        thread::sleep(Duration::from_millis(40));

        let serve_request = TestRequest::get()
            .uri(&format!("/{file_name}"))
            .to_request();
        let response = test::call_service(&app, serve_request).await;
        assert_eq!(StatusCode::NOT_FOUND, response.status());

        if let Some(glob_path) = glob(&format!("{file_name}.[0-9]*"))
            .map_err(error::ErrorInternalServerError)?
            .next()
        {
            fs::remove_file(glob_path.map_err(error::ErrorInternalServerError)?)?;
        }

        Ok(())
    }

    #[actix_web::test]
    async fn test_upload_remote_file() -> Result<(), Error> {
        let mut config = Config::default();
        config.server.upload_path = env::current_dir()?;
        config.server.max_content_length = Byte::from_u128(30000).unwrap_or_default();

        let app = test::init_service(
            App::new()
                .app_data(Data::new(RwLock::new(config)))
                .app_data(Data::new(
                    ClientBuilder::new()
                        .timeout(Duration::from_secs(30))
                        .finish(),
                ))
                .configure(configure_routes),
        )
        .await;

        let file_name =
            "rp_test_3b5eeeee7a7326cd6141f54820e6356a0e9d1dd4021407cb1d5e9de9f034ed2f.png";
        let response = test::call_service(
            &app,
            get_multipart_request(
                "https://raw.githubusercontent.com/orhun/rustypaste/refs/heads/master/img/rp_test_3b5eeeee7a7326cd6141f54820e6356a0e9d1dd4021407cb1d5e9de9f034ed2f.png",
                "remote",
                file_name,
            )
            .to_request(),
        )
        .await;
        assert_eq!(StatusCode::OK, response.status());
        assert_body(
            response.into_body().boxed(),
            &format!("http://localhost:8080/rp_test_3b5eeeee7a7326cd6141f54820e6356a0e9d1dd4021407cb1d5e9de9f034ed2f/file.png\n"),
        )
        .await?;

        let serve_request = TestRequest::get()
            .uri(&format!("/{file_name}"))
            .to_request();
        let response = test::call_service(&app, serve_request).await;
        assert_eq!(StatusCode::OK, response.status());

        let body = response.into_body();
        let body_bytes = actix_web::body::to_bytes(body).await?;
        assert_eq!(
            "3b5eeeee7a7326cd6141f54820e6356a0e9d1dd4021407cb1d5e9de9f034ed2f",
            util::sha256_digest(&*body_bytes)?
        );

        fs::remove_file(file_name)?;

        let serve_request = TestRequest::get()
            .uri(&format!("/{file_name}"))
            .to_request();
        let response = test::call_service(&app, serve_request).await;
        assert_eq!(StatusCode::NOT_FOUND, response.status());

        Ok(())
    }

    #[actix_web::test]
    async fn test_upload_url() -> Result<(), Error> {
        let mut config = Config::default();
        config.server.upload_path = env::current_dir()?;

        let app = test::init_service(
            App::new()
                .app_data(Data::new(RwLock::new(config.clone())))
                .app_data(Data::new(Client::default()))
                .configure(configure_routes),
        )
        .await;

        let url_upload_path = PasteType::Url
            .get_path(&config.server.upload_path)
            .expect("Bad upload path");
        fs::create_dir_all(&url_upload_path)?;

        let response = test::call_service(
            &app,
            get_multipart_request(env!("CARGO_PKG_HOMEPAGE"), "url", "").to_request(),
        )
        .await;
        assert_eq!(StatusCode::OK, response.status());
        assert_body(response.into_body(), "http://localhost:8080/url/file\n").await?;

        let serve_request = TestRequest::get().uri("/url").to_request();
        let response = test::call_service(&app, serve_request).await;
        assert_eq!(StatusCode::FOUND, response.status());

        fs::remove_file(url_upload_path.join("url"))?;
        fs::remove_dir(url_upload_path)?;

        let serve_request = TestRequest::get().uri("/url").to_request();
        let response = test::call_service(&app, serve_request).await;
        assert_eq!(StatusCode::NOT_FOUND, response.status());

        Ok(())
    }

    #[actix_web::test]
    async fn test_upload_oneshot() -> Result<(), Error> {
        let mut config = Config::default();
        config.server.upload_path = env::current_dir()?;

        let app = test::init_service(
            App::new()
                .app_data(Data::new(RwLock::new(config.clone())))
                .app_data(Data::new(Client::default()))
                .configure(configure_routes),
        )
        .await;

        let oneshot_upload_path = PasteType::Oneshot
            .get_path(&config.server.upload_path)
            .expect("Bad upload path");
        fs::create_dir_all(&oneshot_upload_path)?;

        let file_name = "oneshot.txt";
        let timestamp = util::get_system_time()?.as_secs().to_string();
        let response = test::call_service(
            &app,
            get_multipart_request(&timestamp, "oneshot", file_name).to_request(),
        )
        .await;
        assert_eq!(StatusCode::OK, response.status());
        assert_body(
            response.into_body(),
            &format!("http://localhost:8080/oneshot/file.txt\n"),
        )
        .await?;

        let serve_request = TestRequest::get()
            .uri(&format!("/{file_name}"))
            .to_request();
        let response = test::call_service(&app, serve_request).await;
        assert_eq!(StatusCode::OK, response.status());
        assert_body(response.into_body(), &timestamp).await?;

        let serve_request = TestRequest::get()
            .uri(&format!("/{file_name}"))
            .to_request();
        let response = test::call_service(&app, serve_request).await;
        assert_eq!(StatusCode::NOT_FOUND, response.status());

        if let Some(glob_path) = glob(
            &oneshot_upload_path
                .join(format!("{file_name}.[0-9]*"))
                .to_string_lossy(),
        )
        .map_err(error::ErrorInternalServerError)?
        .next()
        {
            fs::remove_file(glob_path.map_err(error::ErrorInternalServerError)?)?;
        }
        fs::remove_dir(oneshot_upload_path)?;

        Ok(())
    }

    #[actix_web::test]
    async fn test_upload_oneshot_url() -> Result<(), Error> {
        let mut config = Config::default();
        config.server.upload_path = env::current_dir()?;

        let oneshot_url_suffix = "oneshot_url";

        let app = test::init_service(
            App::new()
                .app_data(Data::new(RwLock::new(config.clone())))
                .app_data(Data::new(Client::default()))
                .configure(configure_routes),
        )
        .await;

        let url_upload_path = PasteType::OneshotUrl
            .get_path(&config.server.upload_path)
            .expect("Bad upload path");
        fs::create_dir_all(&url_upload_path)?;

        let response = test::call_service(
            &app,
            get_multipart_request(
                env!("CARGO_PKG_HOMEPAGE"),
                oneshot_url_suffix,
                oneshot_url_suffix,
            )
            .to_request(),
        )
        .await;
        assert_eq!(StatusCode::OK, response.status());
        assert_body(
            response.into_body(),
            &format!("http://localhost:8080/{oneshot_url_suffix}/file\n"),
        )
        .await?;

        // Make the oneshot_url request, ensure it is found.
        let serve_request = TestRequest::with_uri(&format!("/{oneshot_url_suffix}")).to_request();
        let response = test::call_service(&app, serve_request).await;
        assert_eq!(StatusCode::FOUND, response.status());

        // Make the same request again, and ensure that the oneshot_url is not found.
        let serve_request = TestRequest::with_uri(&format!("/{oneshot_url_suffix}")).to_request();
        let response = test::call_service(&app, serve_request).await;
        assert_eq!(StatusCode::NOT_FOUND, response.status());

        // Cleanup
        fs::remove_dir_all(url_upload_path)?;

        Ok(())
    }

    #[actix_web::test]
    async fn test_cors_headers() -> Result<(), Error> {
        let cors_config = CorsConfig {
            allowed_origins: vec!["https://paste.example.com".to_string()],
            allowed_methods: vec![
                "GET".to_string(),
                "POST".to_string(),
                "DELETE".to_string(),
                "OPTIONS".to_string(),
            ],
            allowed_headers: vec!["Authorization".to_string(), "Content-Type".to_string()],
        };

        let app = test::init_service(
            App::new()
                .app_data(Data::new(RwLock::new(Config::default())))
                .app_data(Data::new(Client::default()))
                .wrap(cors_config.build())
                .configure(configure_routes),
        )
        .await;

        // Send a preflight OPTIONS request with an Origin header
        let request = TestRequest::default()
            .method(actix_web::http::Method::OPTIONS)
            .insert_header(("Origin", "https://paste.example.com"))
            .insert_header(("Access-Control-Request-Method", "POST"))
            .insert_header((
                "Access-Control-Request-Headers",
                "Authorization, Content-Type",
            ))
            .uri("/")
            .to_request();
        let response = test::call_service(&app, request).await;

        // Check CORS headers are present
        assert!(response
            .headers()
            .contains_key("access-control-allow-origin"));
        assert_eq!(
            response
                .headers()
                .get("access-control-allow-origin")
                .unwrap()
                .to_str()
                .unwrap(),
            "https://paste.example.com"
        );

        Ok(())
    }

    #[actix_web::test]
    async fn test_cors_wildcard_origin() -> Result<(), Error> {
        let cors_config = CorsConfig {
            allowed_origins: vec!["*".to_string()],
            allowed_methods: vec!["GET".to_string()],
            allowed_headers: vec![],
        };

        let app = test::init_service(
            App::new()
                .app_data(Data::new(RwLock::new(Config::default())))
                .app_data(Data::new(Client::default()))
                .wrap(cors_config.build())
                .configure(configure_routes),
        )
        .await;

        // Send a request with an Origin header
        let request = TestRequest::get()
            .insert_header(("Origin", "https://any-origin.com"))
            .uri("/")
            .to_request();
        let response = test::call_service(&app, request).await;

        // With wildcard, any origin should be allowed - actix-cors echoes the origin back
        assert!(response
            .headers()
            .contains_key("access-control-allow-origin"));
        let allowed_origin = response
            .headers()
            .get("access-control-allow-origin")
            .unwrap()
            .to_str()
            .unwrap();
        // When allow_any_origin() is used, actix-cors echoes back the request origin
        assert!(allowed_origin == "*" || allowed_origin == "https://any-origin.com");

        Ok(())
    }
}
