//! Loopback OAuth helper (Slice 9): the one Rust piece of the Microsoft
//! connection that TypeScript cannot do — a throwaway HTTP listener on
//! 127.0.0.1 that catches the browser redirect of a public-client
//! authorization-code flow and hands the query string back to the frontend.
//!
//! Deliberately dependency-free (std TcpListener only) and provider-agnostic:
//! any future OAuth connection (Google Calendar, …) reuses the same three
//! commands. Everything else — PKCE, the authorize URL, the token exchange —
//! lives in `src/lib/msauth.ts`.

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// The page the user sees in their browser after signing in.
const SUCCESS_HTML: &str = "<!doctype html><html><head><meta charset=\"utf-8\">\
<title>Lalela</title></head><body style=\"font-family:-apple-system,sans-serif;\
display:flex;align-items:center;justify-content:center;height:100vh;margin:0;\
background:#faf9f6;color:#1c1917\"><div style=\"text-align:center\">\
<h1 style=\"font-size:1.4rem\">You're connected</h1>\
<p style=\"color:#57534e\">Return to Lalela — you can close this tab.</p>\
</div></body></html>";

/// How long the listener waits for the user to finish signing in.
const WAIT_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Default)]
pub struct OauthState {
    listener: Mutex<Option<TcpListener>>,
}

/// Bind the loopback listener (preferred port, else any free port) and return
/// the actual port so the frontend can build the `http://localhost:{port}`
/// redirect URI before opening the browser.
#[tauri::command]
pub fn oauth_loopback_listen(
    port_preference: Option<u16>,
    state: tauri::State<'_, OauthState>,
) -> Result<u16, String> {
    let listener = match port_preference {
        Some(p) if p != 0 => TcpListener::bind(("127.0.0.1", p))
            .or_else(|_| TcpListener::bind(("127.0.0.1", 0))),
        _ => TcpListener::bind(("127.0.0.1", 0)),
    }
    .map_err(|e| format!("could not open a local sign-in port: {e}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    *state.listener.lock().map_err(|_| "state poisoned")? = Some(listener);
    Ok(port)
}

/// Await ONE OAuth redirect on the listener opened by `oauth_loopback_listen`
/// and return its raw query string (`code=…&state=…` or `error=…`). Serves a
/// small "you're connected" page to the browser; unrelated requests (favicon
/// probes) get a 404 and the wait continues. Times out after ~5 minutes.
#[tauri::command]
pub async fn oauth_loopback_wait(state: tauri::State<'_, OauthState>) -> Result<String, String> {
    let listener = state
        .listener
        .lock()
        .map_err(|_| "state poisoned")?
        .take()
        .ok_or("no sign-in listener is active — call oauth_loopback_listen first")?;
    tauri::async_runtime::spawn_blocking(move || wait_for_redirect(listener, WAIT_TIMEOUT))
        .await
        .map_err(|e| format!("sign-in listener task failed: {e}"))?
}

/// Drop the pending listener (user cancelled the connect flow).
#[tauri::command]
pub fn oauth_loopback_cancel(state: tauri::State<'_, OauthState>) {
    if let Ok(mut guard) = state.listener.lock() {
        *guard = None;
    }
}

#[derive(serde::Serialize)]
pub struct TokenHttpResponse {
    pub status: u16,
    pub body: String,
}

/// Token exchange/refresh must NOT carry a browser Origin header: the Tauri
/// webview stamps `Origin: tauri://localhost` on fetch(), and Entra rejects
/// cross-origin token redemption for native clients (AADSTS9002326) — the
/// SPA client-type workaround would cap refresh tokens at 24h. Rust owns the
/// POST instead, so the app behaves as a true public/native client.
#[tauri::command]
pub fn ms_token_request(url: String, body: String) -> Result<TokenHttpResponse, String> {
    if !url.starts_with("https://login.microsoftonline.com/") {
        return Err("Refusing token request to a non-Microsoft endpoint.".into());
    }
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(&url)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("Accept", "application/json")
        .body(body)
        .send()
        .map_err(|e| format!("Microsoft token request failed: {e}"))?;
    let status = resp.status().as_u16();
    let body = resp.text().map_err(|e| e.to_string())?;
    Ok(TokenHttpResponse { status, body })
}

fn wait_for_redirect(listener: TcpListener, timeout: Duration) -> Result<String, String> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        match listener.accept() {
            Ok((stream, _)) => {
                if let Some(query) = handle_request(stream) {
                    return Ok(query);
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(format!("sign-in listener failed: {e}")),
        }
    }
    Err("Timed out waiting for the browser sign-in. Try connecting again.".into())
}

/// Serve one HTTP request. Returns `Some(query)` when it is the OAuth
/// redirect (query carries `code=` or `error=`), `None` for anything else.
fn handle_request(stream: TcpStream) -> Option<String> {
    // The accepted socket may inherit the listener's non-blocking mode.
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut reader = BufReader::new(stream);
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).is_err() {
        return None;
    }
    // "GET /?code=…&state=… HTTP/1.1"
    let path = request_line.split_whitespace().nth(1).unwrap_or("");
    let query = path.splitn(2, '?').nth(1).unwrap_or("").to_string();
    let is_redirect = query
        .split('&')
        .any(|p| p.starts_with("code=") || p.starts_with("error="));
    let mut stream = reader.into_inner();
    if is_redirect {
        let _ = write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            SUCCESS_HTML.len(),
            SUCCESS_HTML
        );
        let _ = stream.flush();
        Some(query)
    } else {
        let _ = write!(
            stream,
            "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        );
        let _ = stream.flush();
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn request(port: u16, target: &str) -> String {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(s, "GET {target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n").unwrap();
        let mut out = String::new();
        let _ = s.read_to_string(&mut out);
        out
    }

    #[test]
    fn redirect_query_is_returned_and_noise_is_ignored() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();

        let client = std::thread::spawn(move || {
            // A favicon probe first must NOT satisfy the wait…
            let noise = request(port, "/favicon.ico");
            assert!(noise.contains("404"), "noise reply: {noise}");
            // …the actual redirect must, and gets the success page.
            let ok = request(port, "/?code=abc123&state=xyz");
            assert!(ok.contains("200 OK") && ok.contains("connected"), "redirect reply: {ok}");
        });

        let query = wait_for_redirect(listener, Duration::from_secs(10)).unwrap();
        assert_eq!(query, "code=abc123&state=xyz");
        client.join().unwrap();
    }

    #[test]
    fn error_redirect_also_resolves_the_wait() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let client = std::thread::spawn(move || {
            request(port, "/?error=access_denied&error_description=AADSTS65004")
        });
        let query = wait_for_redirect(listener, Duration::from_secs(10)).unwrap();
        assert!(query.starts_with("error=access_denied"));
        client.join().unwrap();
    }
}
