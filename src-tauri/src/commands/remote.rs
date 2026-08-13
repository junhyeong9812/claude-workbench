//! R2a — attaching a remote host and bridging its events onto the workbench's
//! existing ones.
//!
//! Everything of substance is in `core_lib::remote`; this file is the two
//! things that cannot live there. One is the Tauri command surface (attach,
//! detach, poll, and two read-only calls). The other is the sink: three
//! `app.emit` lines that put a remote host's frames onto the **same** events a
//! local session has always produced.
//!
//! ## Why polling for the host list, and events for the timeline
//!
//! The timeline streams, because it is a stream and because `claude-timeline`
//! already exists to carry one. A connection's own state — attached, retrying,
//! which sessions exist, what the daemon said — has no existing event, and
//! inventing one would be a new frontend contract for a panel that is polled
//! only while it is open. So it is a snapshot ([`remote_hosts`]) instead: no
//! new event kind, and nothing to keep in sync.
//!
//! ## Read-only, and narrowly so
//!
//! The daemon's socket also carries `spawn` and `kill`. Nothing here can reach
//! them: the two calls exposed are `list` and `timeline`, spelled out as
//! separate commands rather than as a pass-through argv. R2b owns the write
//! surface, and giving the frontend a general "run this on the remote host"
//! command now would build it by accident.

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use core_lib::remote::host::Emit;
use core_lib::remote::proto::{decode_response, SessionsReply, TimelineSliceReply};
use core_lib::remote::{
    HostConfig, HostSnapshot, RemoteAuth, RemoteTimelinePayload, Registry, Sink,
};

use super::AppError;

/// Managed state: every attached host.
#[derive(Default)]
pub struct RemoteState {
    registry: Registry,
}

/// Turns a bridged event into the workbench event it has always been.
struct TauriSink {
    app: AppHandle,
}

impl Sink for TauriSink {
    fn emit(&self, e: Emit) {
        match e {
            Emit::Timeline(payload) => {
                let _ = self.app.emit("claude-timeline", payload);
            }
            Emit::Hook { uuid, event } => {
                let _ = self.app.emit(
                    "claude-hook-status",
                    super::hookserver::HookStatusEvent { uuid, event },
                );
            }
            Emit::Closed { id } => {
                let _ = self.app.emit("claude-session-closed", id);
            }
        }
    }
}

/// App-private known_hosts — the same file the SSH terminal learns keys into,
/// which is what makes "open a terminal to the host once" the way to trust it.
fn known_hosts_path(app: &AppHandle) -> Result<std::path::PathBuf, AppError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| AppError::new("앱 데이터 경로를 찾을 수 없습니다."))?;
    let _ = std::fs::create_dir_all(&dir);
    Ok(dir.join("known_hosts"))
}

/// A directly supplied secret wins; the saved connection's keychain entry is the
/// fallback; **an empty string is not a secret**. Returning `None` rather than
/// `""` is the whole point — see [`remote_connect`].
fn secret(direct: Option<String>, saved: Option<String>) -> Option<String> {
    direct
        .or(saved)
        .map(|s| s.trim_end_matches(['\r', '\n']).to_string())
        .filter(|s| !s.is_empty())
}

/// Attach a remote host: subscribe to its daemon's event stream over SSH.
///
/// Returns the id it was filed under (the caller's `host_id`). Attaching an id
/// that is already attached replaces it, so a reconnect button cannot leave two
/// observation windows doubling every event.
///
/// Credentials follow `ssh_create`'s rule exactly: a directly supplied secret
/// wins, and only in its absence is the saved connection's keychain entry read
/// — so a fresh connection or agent auth never triggers a keychain unlock.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn remote_connect(
    app: AppHandle,
    remote: State<'_, RemoteState>,
    host_id: String,
    label: String,
    host: String,
    port: u16,
    username: String,
    auth_kind: String,
    password: Option<String>,
    key_path: Option<String>,
    passphrase: Option<String>,
    connection_id: Option<String>,
    cwcd: Option<String>,
    socket: Option<String>,
) -> Result<String, AppError> {
    let saved = || connection_id.as_deref().and_then(super::ssh::ssh_get_secret);
    let auth = match auth_kind.as_str() {
        "password" => RemoteAuth::Password(
            // **Never an empty default.** A remote host reconnects on its own
            // every ≤15s, so a missing secret quietly became an empty password
            // offered to the remote `sshd` at that rate forever — until
            // `MaxAuthTries`/fail2ban blocked the user's address. A secret that
            // is not there is an error the user can act on, at the one moment
            // they are looking at the panel.
            secret(password, saved()).ok_or_else(|| {
                AppError::new(
                    "이 연결의 비밀번호를 찾을 수 없습니다 — 터미널에서 이 SSH 연결로 한 번 접속해 비밀번호를 저장한 뒤 다시 연결하세요.",
                )
            })?,
        ),
        "publickey" => RemoteAuth::PublicKey {
            path: key_path.ok_or_else(|| AppError::new("키 파일 경로가 필요합니다."))?,
            // A passphrase, unlike a password, is legitimately absent (an
            // unencrypted key), so `None` is a real answer here.
            passphrase: secret(passphrase, saved()),
        },
        "agent" => RemoteAuth::Agent,
        _ => return Err(AppError::new("알 수 없는 인증 방식입니다.")),
    };
    let cwcd = cwcd
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "cwcd".to_string());
    let socket = socket.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let cfg = HostConfig {
        host_id,
        label,
        host,
        port,
        username,
        auth,
        cwcd,
        socket,
        known_hosts: known_hosts_path(&app)?,
        timeouts: core_lib::remote::LinkTimeouts::default(),
    };
    let sink = Arc::new(TauriSink { app: app.clone() });
    Ok(remote.registry.attach(cfg, sink))
}

/// Stop observing a host. The remote daemon and every agent it owns keep
/// running — that is the whole point of the daemon owning them.
#[tauri::command]
pub fn remote_disconnect(remote: State<'_, RemoteState>, host_id: String) -> bool {
    remote.registry.detach(&host_id)
}

/// Every attached host: connection state, what the daemon said, its sessions,
/// and the notices the user must see.
#[tauri::command]
pub fn remote_hosts(remote: State<'_, RemoteState>) -> Vec<HostSnapshot> {
    remote.registry.snapshots()
}

/// Every attached host's timelines **as they stand now**.
///
/// The timeline arrives as events, and events only reach a listener that was
/// already there. A panel that is closed and reopened — a sidebar tab switched
/// away from and back — has missed all of them, and a session that has stopped
/// producing events (a finished one, most of all) would then show a permanently
/// blank screen. This is the seed for that case: the same payloads the events
/// carry, read out of the bridge's own state.
#[tauri::command]
pub fn remote_timelines(remote: State<'_, RemoteState>) -> Vec<RemoteTimelinePayload> {
    remote.registry.live_payloads()
}

/// One remote session's timeline, fetched on demand.
///
/// This is the address a finished session's `body_omitted` points at: the
/// daemon leaves a finished session's items out of every snapshot, and this is
/// how they come back. The `"<epoch>:k<n>"` address is composed here from the
/// stream's own epoch — a bare key would be refused, and worse, a bare key
/// after a daemon restart would name somebody else's session.
#[derive(Serialize)]
pub struct RemoteTimeline {
    pub session_id: String,
    pub total: usize,
    pub items: Vec<core_lib::TimelineItem>,
    pub turns: Vec<(u64, String)>,
    pub model: Option<String>,
    pub last_usage: Option<core_lib::TokenUsage>,
}

#[tauri::command]
pub fn remote_timeline(
    remote: State<'_, RemoteState>,
    host_id: String,
    id: u64,
) -> Result<RemoteTimeline, AppError> {
    let addr = remote.registry.addr_of(&host_id, id).ok_or_else(|| {
        AppError::new("이 세션의 원격 주소를 알 수 없습니다 — 연결이 끊겼거나 데몬이 다시 시작되었습니다.")
    })?;
    let out = remote
        .registry
        .call(&host_id, &["timeline", &addr])
        .map_err(AppError::new)?;
    let slice: TimelineSliceReply = decode_response(&out).map_err(AppError::new)?;
    Ok(RemoteTimeline {
        session_id: slice.session_id,
        total: slice.total,
        items: slice.items,
        turns: slice.turns.into_iter().collect(),
        model: slice.model,
        last_usage: slice.last_usage,
    })
}

/// The host's own session list, asked directly rather than derived from the
/// stream — the way to tell "the workbench is behind" from "the host is idle".
#[tauri::command]
pub fn remote_sessions(
    remote: State<'_, RemoteState>,
    host_id: String,
) -> Result<usize, AppError> {
    let out = remote
        .registry
        .call(&host_id, &["list"])
        .map_err(AppError::new)?;
    let reply: SessionsReply = decode_response(&out).map_err(AppError::new)?;
    Ok(reply.sessions.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A missing secret must be **nothing**, never an empty string.
    ///
    /// While it defaulted to `""`, a saved connection whose keychain entry was
    /// gone (the panel never sends a password) offered an empty password to the
    /// remote `sshd` on every reconnect — every ≤15s, forever. That is what
    /// `MaxAuthTries` and fail2ban exist to punish, and the address they block
    /// is the user's own.
    #[test]
    fn a_missing_secret_is_none_not_an_empty_password() {
        assert_eq!(secret(None, None), None, "no secret anywhere");
        assert_eq!(secret(Some(String::new()), None), None, "an empty string is not a secret");
        assert_eq!(secret(None, Some(String::new())), None, "…and neither is an empty entry");
        assert_eq!(secret(Some("\r\n".into()), None), None, "nor a keychain entry of newlines");
        // …but whitespace *inside* a secret is part of it, so only the line
        // ending a keychain read can add is stripped.
        assert_eq!(secret(None, Some(" p w ".into())), Some(" p w ".into()));
        // A supplied secret wins over the saved one; the saved one is the
        // fallback (the same rule `ssh_create` follows).
        assert_eq!(secret(Some("typed".into()), Some("saved".into())), Some("typed".into()));
        assert_eq!(secret(None, Some("saved".into())), Some("saved".into()));
        // A trailing newline from the keychain is not part of the secret.
        assert_eq!(secret(None, Some("saved\n".into())), Some("saved".into()));
    }
}
