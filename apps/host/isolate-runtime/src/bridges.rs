//! The two bridges kantel-host serves: STORE (its blob store for this VM's account) and EGRESS (its egress proxy).
//! The runtime talks to nothing else. Each is reached over TCP (host:port or an http:// URL) or a Unix socket
//! (`unix:/absolute/path`) — in native mode kantel-host puts each account's bridges on Unix sockets in a 0700
//! per-account directory, so one account's runtime can't reach another's over loopback.

use std::collections::HashMap;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use anyhow::{Result, anyhow, bail};
use bytes::Bytes;
use http_body_util::BodyExt;
use hyper::body::Incoming;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncWrite};

use crate::limits::Budget;

/// The most of one egress response body one fetch may read.
const MAX_FETCH_BODY: usize = 64 * 1024 * 1024;
/// Bytes of in-flight response/blob bodies being collected in Rust across the whole process, so many concurrent
/// fetches can't exhaust host memory regardless of per-isolate budgets.
const MAX_PROCESS_INFLIGHT: usize = 512 * 1024 * 1024;
static PROCESS_INFLIGHT: AtomicUsize = AtomicUsize::new(0);

/// Charges bytes being collected in Rust against the isolate's memory budget and a process-wide in-flight cap, and
/// releases them when dropped (when the collected buffer is handed to V8 and freed). So a response can't be larger
/// than the sandbox's memory, and all in-flight bodies together can't exhaust the host (review findings H5, M7).
pub struct Charge {
    budget: Arc<Budget>,
    taken: usize,
}

impl Charge {
    pub fn new(budget: Arc<Budget>) -> Charge {
        Charge { budget, taken: 0 }
    }
    fn add(&mut self, n: usize) -> Result<()> {
        let before = PROCESS_INFLIGHT.fetch_add(n, Ordering::SeqCst);
        if before + n > MAX_PROCESS_INFLIGHT {
            PROCESS_INFLIGHT.fetch_sub(n, Ordering::SeqCst);
            bail!("the runtime is busy (too much data in flight); try again");
        }
        if !self.budget.try_take(n) {
            PROCESS_INFLIGHT.fetch_sub(n, Ordering::SeqCst);
            bail!("response is larger than this isolate's memory; use a microVM for large downloads");
        }
        self.taken += n;
        Ok(())
    }
}

impl Drop for Charge {
    fn drop(&mut self) {
        PROCESS_INFLIGHT.fetch_sub(self.taken, Ordering::SeqCst);
        self.budget.give(self.taken);
    }
}

pub fn valid_sha(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Where a bridge listens: a TCP authority (host:port) or a Unix socket path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Target {
    Tcp(String),
    Unix(PathBuf),
}

impl Target {
    /// Parse `unix:/path`, `http://host:port` or `host:port` (adding `:80` to a bare TCP host).
    pub fn parse(s: &str) -> Result<Target> {
        if let Some(path) = s.strip_prefix("unix:") {
            if path.is_empty() {
                bail!("{s}: empty unix socket path");
            }
            return Ok(Target::Unix(PathBuf::from(path)));
        }
        let rest = s.strip_prefix("http://").unwrap_or(s);
        if rest.contains("://") {
            bail!("{s}: only http://, host:port and unix:/path are supported");
        }
        let host = rest.split('/').next().unwrap_or_default();
        if host.is_empty() {
            bail!("{s}: no host");
        }
        Ok(Target::Tcp(if host.contains(':') { host.to_string() } else { format!("{host}:80") }))
    }

    pub fn describe(&self) -> String {
        match self {
            Target::Tcp(a) => a.clone(),
            Target::Unix(p) => format!("unix:{}", p.display()),
        }
    }
}

/// A dialled connection to a bridge: either a TCP or a Unix stream.
trait Stream: AsyncRead + AsyncWrite + Send + Unpin {}
impl<T: AsyncRead + AsyncWrite + Send + Unpin> Stream for T {}
type BoxStream = Pin<Box<dyn Stream>>;

async fn dial(target: &Target) -> Result<BoxStream> {
    match target {
        Target::Tcp(authority) => {
            let stream = tokio::net::TcpStream::connect(authority).await?;
            Ok(Box::pin(stream))
        }
        Target::Unix(path) => {
            let stream = tokio::net::UnixStream::connect(path).await?;
            Ok(Box::pin(stream))
        }
    }
}

/// Send one HTTP/1.1 request over a fresh connection to `target` and read the whole response, charging the body's
/// bytes as they arrive against `charge` (if any) and refusing past `cap`.
async fn request(
    target: &Target,
    method: &str,
    uri: &str,
    headers: &[(&str, &str)],
    body: Vec<u8>,
    cap: usize,
    charge: Option<&mut Charge>,
) -> Result<(hyper::StatusCode, hyper::HeaderMap, Bytes)> {
    let stream = dial(target).await?;
    let (mut sender, conn) = hyper::client::conn::http1::handshake(hyper_util::rt::TokioIo::new(stream)).await?;
    tokio::spawn(conn);
    let mut builder = hyper::Request::builder().method(method).uri(uri).header("host", "kantel");
    for (k, v) in headers {
        builder = builder.header(*k, *v);
    }
    let resp = sender.send_request(builder.body(http_body_util::Full::new(Bytes::from(body)))?).await?;
    let status = resp.status();
    let headers = resp.headers().clone();
    let data = read_body(resp.into_body(), cap, charge).await?;
    Ok((status, headers, data))
}

/// Collect a body up to `cap`, charging each frame against `charge` as it arrives (so a slow stream can't grow
/// unbounded, and the bytes count against the isolate's memory and the process-wide in-flight cap).
async fn read_body(body: Incoming, cap: usize, mut charge: Option<&mut Charge>) -> Result<Bytes> {
    let mut body = body;
    let mut out: Vec<u8> = Vec::new();
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|e| anyhow!("response body: {e}"))?;
        if let Some(chunk) = frame.data_ref() {
            if out.len() + chunk.len() > cap {
                bail!("response body is too large (over {} MiB)", cap / (1024 * 1024));
            }
            if let Some(c) = charge.as_deref_mut() {
                c.add(chunk.len())?;
            }
            out.extend_from_slice(chunk);
        }
    }
    Ok(Bytes::from(out))
}

pub struct Store {
    target: Target,
}

impl Store {
    pub fn new(target: Target) -> Store {
        Store { target }
    }

    /// Read a blob, capped at `cap` (the sandbox's memory) and charged against its budget — not the egress body cap,
    /// which is unrelated to the host's 256 MiB blob limit (review finding M7).
    pub async fn get(&self, sha: &str, cap: usize, charge: Option<&mut Charge>) -> Result<Vec<u8>> {
        if !valid_sha(sha) {
            bail!("blob: not a SHA-256 digest");
        }
        let (status, _, data) = request(&self.target, "GET", &format!("/blobs/{sha}"), &[], Vec::new(), cap, charge).await?;
        if !status.is_success() {
            bail!("blob {sha}: {status}");
        }
        Ok(data.to_vec())
    }

    pub async fn put(&self, bytes: Vec<u8>) -> Result<String> {
        let (status, _, data) =
            request(&self.target, "PUT", "/blobs", &[("content-type", "application/octet-stream")], bytes, 1024, None).await?;
        if !status.is_success() {
            bail!("put blob: {status}");
        }
        let v: Value = serde_json::from_slice(&data)?;
        Ok(v["sha"].as_str().ok_or_else(|| anyhow!("put blob: no sha"))?.to_string())
    }
}

#[derive(Deserialize)]
pub struct FetchReq {
    pub url: String,
    pub method: String,
    pub headers: HashMap<String, String>,
    pub follow: bool,
}

/// A buffer the guest decodes: [u32 big-endian meta length][meta JSON][body].
pub fn pack(meta: &Value, data: &[u8]) -> Vec<u8> {
    let m = serde_json::to_vec(meta).unwrap();
    let mut out = Vec::with_capacity(4 + m.len() + data.len());
    out.extend_from_slice(&(m.len() as u32).to_be_bytes());
    out.extend_from_slice(&m);
    out.extend_from_slice(data);
    out
}

/// Hop-by-hop and framing headers a guest request must not carry through the proxy (RFC 9110 and proxy hygiene).
fn is_dropped_header(lower: &str) -> bool {
    lower.starts_with("kantel-")
        || lower.starts_with("proxy-")
        || matches!(
            lower,
            "host" | "connection" | "keep-alive" | "transfer-encoding" | "content-length" | "te" | "trailer" | "upgrade"
        )
}

/// Credential headers stripped when a redirect crosses origins (as the Fetch standard does), so a guest's token
/// isn't sent to a host the redirect points at (review finding M10).
fn is_credential_header(lower: &str) -> bool {
    matches!(lower, "authorization" | "cookie" | "cookie2")
}

fn origin_of(uri: &hyper::Uri) -> (Option<&str>, Option<String>) {
    (uri.scheme_str(), uri.authority().map(|a| a.as_str().to_ascii_lowercase()))
}

/// One request through the egress proxy, in proxy style (absolute-form target), tagged with the sandbox. The
/// guest's own kantel-* headers (and hop-by-hop/framing headers) are dropped, so it can't claim another sandbox or
/// confuse the proxy's framing. `charge` bounds the response body against the isolate's memory.
pub async fn egress_fetch(egress: &Target, sandbox: &str, req: FetchReq, body: Vec<u8>, mut charge: Option<&mut Charge>) -> Result<Vec<u8>> {
    let (mut url, mut method, mut body) = (req.url.clone(), req.method.to_uppercase(), body);
    // The origin the credential headers were meant for (the first request's); cleared once a redirect crosses it.
    let first: hyper::Uri = url.parse().map_err(|e| anyhow!("bad URL {url}: {e}"))?;
    let origin = origin_of(&first);
    let mut credentials_ok = true;
    for _ in 0..10 {
        let uri: hyper::Uri = url.parse().map_err(|e| anyhow!("bad URL {url}: {e}"))?;
        match uri.scheme_str() {
            Some("http") | Some("https") => {}
            _ => bail!("unsupported URL scheme: {url}"),
        }
        if credentials_ok && origin_of(&uri) != origin {
            credentials_ok = false;
        }
        let authority = uri.authority().ok_or_else(|| anyhow!("no host in {url}"))?.to_string();
        let stream = dial(egress).await.map_err(|e| anyhow!("egress proxy: {e}"))?;
        let (mut sender, conn) = hyper::client::conn::http1::handshake(hyper_util::rt::TokioIo::new(stream)).await?;
        tokio::spawn(conn);
        // Absolute-form request target (proxy style), so the proxy sees the real destination.
        let mut builder = hyper::Request::builder().method(method.as_str()).uri(uri.clone());
        for (k, v) in &req.headers {
            let lower = k.to_ascii_lowercase();
            if is_dropped_header(&lower) || (!credentials_ok && is_credential_header(&lower)) {
                continue;
            }
            builder = builder.header(k.as_str(), v.as_str());
        }
        builder = builder.header("host", authority.as_str()).header("kantel-isolate-sandbox", sandbox);
        let request = builder.body(http_body_util::Full::new(Bytes::from(body.clone())))?;
        let resp = sender.send_request(request).await.map_err(|e| anyhow!("egress request: {e}"))?;
        let status = resp.status();
        if req.follow && status.is_redirection() {
            if let Some(loc) = resp.headers().get("location").and_then(|l| l.to_str().ok()) {
                url = resolve_redirect(&uri, &authority, loc);
                if status != hyper::StatusCode::TEMPORARY_REDIRECT && status != hyper::StatusCode::PERMANENT_REDIRECT {
                    method = "GET".into();
                    body = Vec::new();
                }
                continue;
            }
        }
        let mut headers = serde_json::Map::new();
        for (k, v) in resp.headers() {
            headers.insert(k.to_string(), Value::String(v.to_str().unwrap_or("").to_string()));
        }
        let data = read_body(resp.into_body(), MAX_FETCH_BODY, charge.as_deref_mut()).await?;
        let meta = json!({ "status": status.as_u16(), "statusText": status.canonical_reason().unwrap_or(""), "headers": headers, "url": url, "redirected": url != req.url });
        return Ok(pack(&meta, &data));
    }
    bail!("too many redirects")
}

fn resolve_redirect(uri: &hyper::Uri, authority: &str, loc: &str) -> String {
    if loc.starts_with("http://") || loc.starts_with("https://") {
        loc.to_string()
    } else if let Some(rest) = loc.strip_prefix("//") {
        format!("{}://{}", uri.scheme_str().unwrap_or("https"), rest)
    } else if loc.starts_with('/') {
        format!("{}://{}{}", uri.scheme_str().unwrap_or("https"), authority, loc)
    } else {
        let path = uri.path();
        let base = &path[..path.rfind('/').map(|i| i + 1).unwrap_or(0)];
        format!("{}://{}{}{}", uri.scheme_str().unwrap_or("https"), authority, base, loc)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_parsing() {
        assert_eq!(Target::parse("http://127.0.0.1:7001").unwrap(), Target::Tcp("127.0.0.1:7001".into()));
        assert_eq!(Target::parse("127.0.0.1:7001").unwrap(), Target::Tcp("127.0.0.1:7001".into()));
        assert_eq!(Target::parse("store").unwrap(), Target::Tcp("store:80".into()));
        assert_eq!(Target::parse("unix:/run/kantel/store.sock").unwrap(), Target::Unix("/run/kantel/store.sock".into()));
        assert!(Target::parse("https://x").is_err());
        assert!(Target::parse("unix:").is_err());
    }

    #[test]
    fn drops_hop_by_hop_and_kantel_headers() {
        for h in ["kantel-isolate-sandbox", "host", "connection", "content-length", "transfer-encoding", "proxy-authorization", "te", "upgrade"] {
            assert!(is_dropped_header(h), "{h} should be dropped");
        }
        assert!(!is_dropped_header("authorization"));
        assert!(!is_dropped_header("content-type"));
    }

    #[test]
    fn redirects_resolve() {
        let uri: hyper::Uri = "http://a.test/x/y".parse().unwrap();
        assert_eq!(resolve_redirect(&uri, "a.test", "https://b.test/z"), "https://b.test/z");
        assert_eq!(resolve_redirect(&uri, "a.test", "/z"), "http://a.test/z");
        assert_eq!(resolve_redirect(&uri, "a.test", "z"), "http://a.test/x/z");
        assert_eq!(resolve_redirect(&uri, "a.test", "//c.test/z"), "http://c.test/z");
    }

    #[test]
    fn sha_validation() {
        assert!(valid_sha(&"a".repeat(64)));
        assert!(!valid_sha(&"A".repeat(64)));
        assert!(!valid_sha("abc"));
    }
}
