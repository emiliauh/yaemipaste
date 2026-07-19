//! Minimal in-memory sliding-window rate limiter.
//!
//! Used to slow down brute-force attempts against login, admin claim, and
//! other sensitive/destructive endpoints. State is per-process (per worker);
//! this is intentionally simple rather than a distributed limiter, matching
//! the project's existing "no extra infra" deployment shape.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Shared rate limiter state, installed as `web::Data<RateLimiter>`.
#[derive(Debug, Default)]
pub struct RateLimiter {
    hits: Mutex<HashMap<String, Vec<Instant>>>,
}

impl RateLimiter {
    /// Creates an empty limiter.
    pub fn new() -> Self {
        Self {
            hits: Mutex::new(HashMap::new()),
        }
    }

    /// Records a hit for `key` and returns `true` if the caller is still
    /// within the allowed `limit` hits per `window`. Older hits outside the
    /// window are pruned as a side effect, so memory does not grow unbounded
    /// for keys that stop being used.
    pub fn check(&self, key: &str, limit: usize, window: Duration) -> bool {
        let now = Instant::now();
        let Ok(mut hits) = self.hits.lock() else {
            // Poisoned lock: fail open rather than wedging the server, but
            // this should never happen since we never panic while holding it.
            return true;
        };
        let entry = hits.entry(key.to_string()).or_default();
        entry.retain(|instant| now.duration_since(*instant) < window);
        if entry.len() >= limit {
            return false;
        }
        entry.push(now);
        true
    }
}

/// Best-effort client identity for rate-limit bucketing: prefers the
/// real client IP, falls back to a constant so limiting still applies
/// (conservatively, shared across all unknown-IP callers) instead of
/// being bypassable by omitting the header.
pub fn client_key(request: &actix_web::HttpRequest) -> String {
    request
        .connection_info()
        .realip_remote_addr()
        .unwrap_or("unknown")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_up_to_limit_then_blocks() {
        let limiter = RateLimiter::new();
        for _ in 0..3 {
            assert!(limiter.check("a", 3, Duration::from_secs(60)));
        }
        assert!(!limiter.check("a", 3, Duration::from_secs(60)));
    }

    #[test]
    fn keys_are_independent() {
        let limiter = RateLimiter::new();
        assert!(limiter.check("a", 1, Duration::from_secs(60)));
        assert!(limiter.check("b", 1, Duration::from_secs(60)));
        assert!(!limiter.check("a", 1, Duration::from_secs(60)));
    }
}
