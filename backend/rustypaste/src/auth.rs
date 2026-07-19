use crate::account_auth::init_db;
use crate::config::{Config, TokenType};
use actix_web::dev::{ServiceRequest, ServiceResponse};
use actix_web::http::header::AUTHORIZATION;
use actix_web::http::Method;
use actix_web::middleware::ErrorHandlerResponse;
use actix_web::{error, web, Error, HttpRequest};
use rusqlite::Connection;
use std::collections::HashSet;
use std::env;
use std::sync::RwLock;

fn auth_db_path() -> String {
    env::var("DB_PATH").unwrap_or_else(|_| "/var/lib/rustypaste-auth/users.db".to_string())
}

fn account_token_exists(token: &str) -> bool {
    if token.trim().is_empty() {
        return false;
    }
    let Ok(connection) = Connection::open(auth_db_path()) else {
        return false;
    };
    if init_db(&connection).is_err() {
        return false;
    }
    connection
        .query_row(
            "SELECT 1 FROM users WHERE token=?1 AND suspended_at IS NULL LIMIT 1",
            [token],
            |_row| Ok(true),
        )
        .ok()
        .unwrap_or(false)
}

/// Extracts the raw auth token from a request's Authorization header.
///
/// Returns `None` if no valid auth token is found or if auth tokens are not configured.
pub fn get_auth_token(request: &HttpRequest, config: &Config) -> Option<String> {
    let auth_header = request
        .headers()
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split_whitespace().last())
        .filter(|s| !s.is_empty())?;

    // Check if the token is valid (configured in auth_tokens)
    if let Some(configured_tokens) = config.get_tokens(TokenType::Auth) {
        if configured_tokens.contains(auth_header) {
            return Some(auth_header.to_string());
        }
    }
    if account_token_exists(auth_header) {
        return Some(auth_header.to_string());
    }
    None
}

/// Extracts the tokens from the authorization header by token type.
///
/// `Authorization: (type) <token>`
pub(crate) async fn extract_tokens(req: &ServiceRequest) -> Result<HashSet<TokenType>, Error> {
    let config = req
        .app_data::<web::Data<RwLock<Config>>>()
        .map(|cfg| cfg.read())
        .and_then(Result::ok)
        .ok_or_else(|| error::ErrorInternalServerError("cannot acquire config"))?;

    let mut user_tokens = HashSet::with_capacity(2);

    let auth_header = req
        .headers()
        .get(AUTHORIZATION)
        .map(|v| v.to_str().unwrap_or_default())
        .map(|v| v.split_whitespace().last().unwrap_or_default());
    let db_token_valid = auth_header.is_some_and(account_token_exists);

    for token_type in [TokenType::Auth, TokenType::Delete] {
        let maybe_tokens = config.get_tokens(token_type);
        if let Some(configured_tokens) = &maybe_tokens {
            if configured_tokens.contains(auth_header.unwrap_or_default()) {
                user_tokens.insert(token_type);
                continue;
            }
        }
        if db_token_valid {
            user_tokens.insert(token_type);
        } else if token_type == TokenType::Auth
            && maybe_tokens.is_none()
            && std::env::var("ALLOW_ANONYMOUS_UPLOADS")
                .unwrap_or_else(|_| "1".to_string())
                == "1"
        {
            // Anonymous uploads are an explicit deployment choice.
            user_tokens.insert(token_type);
        } else if token_type == TokenType::Delete
            && req.method() == Method::DELETE
            && maybe_tokens.is_none()
        {
            // explicitly disable `DELETE` methods if no `delete_tokens` are set
            warn!("delete endpoint is not served because there are no delete_tokens set");
            Err(error::ErrorNotFound(""))?;
        }
    }

    Ok(user_tokens)
}

/// Returns `HttpResponse` with unauthorized (`401`) error and `unauthorized\n` as body.
pub(crate) fn unauthorized_error() -> actix_web::HttpResponse {
    error::ErrorUnauthorized("unauthorized\n").into()
}

/// Log all unauthorized requests.
pub(crate) fn handle_unauthorized_error<B>(
    res: ServiceResponse<B>,
) -> actix_web::Result<ErrorHandlerResponse<B>> {
    let connection = res.request().connection_info().clone();
    let host = connection.realip_remote_addr().unwrap_or("unknown host");

    warn!("authorization failure for {host}");

    Ok(ErrorHandlerResponse::Response(res.map_into_left_body()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::http::header::HeaderValue;
    use actix_web::test::TestRequest;
    use actix_web::web::Data;
    use actix_web::HttpResponse;
    use awc::http::StatusCode;

    #[actix_web::test]
    async fn test_extract_tokens() -> Result<(), Error> {
        let mut config = Config::default();

        // request without configured auth-tokens
        let request = TestRequest::default()
            .app_data(Data::new(RwLock::new(config.clone())))
            .insert_header((AUTHORIZATION, HeaderValue::from_static("basic test_token")))
            .to_srv_request();
        let tokens = extract_tokens(&request).await?;
        assert_eq!(HashSet::from([TokenType::Auth]), tokens);

        // request with configured auth-tokens
        config.server.auth_tokens = Some(["test_token".to_string()].into());
        let request = TestRequest::default()
            .app_data(Data::new(RwLock::new(config.clone())))
            .insert_header((AUTHORIZATION, HeaderValue::from_static("basic test_token")))
            .to_srv_request();
        let tokens = extract_tokens(&request).await?;
        assert_eq!(HashSet::from([TokenType::Auth]), tokens);

        // request with configured auth-tokens but wrong token in request
        config.server.auth_tokens = Some(["test_token".to_string()].into());
        let request = TestRequest::default()
            .app_data(Data::new(RwLock::new(config.clone())))
            .insert_header((
                AUTHORIZATION,
                HeaderValue::from_static("basic invalid_token"),
            ))
            .to_srv_request();
        let tokens = extract_tokens(&request).await?;
        assert_eq!(HashSet::new(), tokens);

        // DELETE request without configured delete-tokens
        let request = TestRequest::default()
            .method(Method::DELETE)
            .app_data(Data::new(RwLock::new(config.clone())))
            .insert_header((AUTHORIZATION, HeaderValue::from_static("basic test_token")))
            .to_srv_request();
        let res = extract_tokens(&request).await;
        assert!(res.is_err());
        assert_eq!(
            Some(StatusCode::NOT_FOUND),
            res.err()
                .as_ref()
                .map(Error::error_response)
                .as_ref()
                .map(HttpResponse::status)
        );

        // DELETE request with configured delete-tokens
        config.server.delete_tokens = Some(["delete_token".to_string()].into());
        let request = TestRequest::default()
            .method(Method::DELETE)
            .app_data(Data::new(RwLock::new(config.clone())))
            .insert_header((
                AUTHORIZATION,
                HeaderValue::from_static("basic delete_token"),
            ))
            .to_srv_request();
        let tokens = extract_tokens(&request).await?;
        assert_eq!(HashSet::from([TokenType::Delete]), tokens);

        // DELETE request with configured delete-tokens but wrong token in request
        let request = TestRequest::default()
            .method(Method::DELETE)
            .app_data(Data::new(RwLock::new(config.clone())))
            .insert_header((
                AUTHORIZATION,
                HeaderValue::from_static("basic invalid_token"),
            ))
            .to_srv_request();
        let tokens = extract_tokens(&request).await?;
        assert_eq!(HashSet::new(), tokens);

        Ok(())
    }
}
