// ---- SSH (remote terminal via russh) ----
//
// SSH sessions ride the SAME `SessionManager` and `terminal-output` relay as
// local PTYs (write/resize/snapshot/close are id-dispatched in core), so the only
// SSH-specific glue here is `ssh_create` (assemble config + relay status/host-key
// streams) and `ssh_hostkey_decision` (feed the user's TOFU answer back to the
// connecting thread). Host-key challenges come from core over a channel — core
// stays tauri-free; this layer turns them into events.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;

use core_lib::SessionManager;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use super::{scrollback_dir, spawn_scrollback_flush, AppError, TerminalOutput};

/// Pending host-key decisions, keyed by session id. The prompt relay inserts the
/// reply sender on a challenge; `ssh_hostkey_decision` takes it out and answers.
#[derive(Default)]
pub struct SshState {
    pending: Arc<Mutex<HashMap<u64, core_lib::ssh::HostKeyReply>>>,
}

/// `ssh-status` payload: connection lifecycle for the panel.
#[derive(Clone, Serialize)]
struct SshStatusPayload {
    id: u64,
    phase: String,
    reason: Option<String>,
}

/// `ssh-hostkey-prompt` payload: shown to the user for a first-seen host (TOFU).
#[derive(Clone, Serialize)]
struct HostKeyPromptPayload {
    id: u64,
    host: String,
    port: u16,
    fingerprint: String,
}

/// App-private known_hosts path (the global `~/.ssh/known_hosts` is never touched
/// — review F7). Ensures the parent dir exists so `learn` can write.
fn ssh_known_hosts_path(app: &AppHandle) -> Result<PathBuf, AppError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| AppError::new("Cannot resolve app data directory"))?;
    let _ = std::fs::create_dir_all(&dir);
    Ok(dir.join("known_hosts"))
}

/// Open a remote SSH session. Returns the session id **immediately**; connect /
/// auth / host-key happen on the session thread and surface via `ssh-status` (and
/// `ssh-hostkey-prompt` for unknown hosts). Output streams through the shared
/// `terminal-output` relay, so the panel renders it exactly like a local PTY.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn ssh_create(
    app: AppHandle,
    mgr: State<'_, SessionManager>,
    ssh: State<'_, SshState>,
    host: String,
    port: u16,
    username: String,
    auth_kind: String,
    password: Option<String>,
    key_path: Option<String>,
    passphrase: Option<String>,
    connection_id: Option<String>,
    persist_key: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<u64, AppError> {
    use core_lib::ssh::{AuthMethod, HostKeyChallenge, SshConfig, SshStatus};

    // A directly supplied arg (new, unsaved connection) takes precedence; only
    // when it's absent do we hit the keychain for a saved connection's secret —
    // so a fresh connection or agent auth never triggers a keychain unlock
    // (review P2-R1). The secret never round-trips through the UI.
    let auth = match auth_kind.as_str() {
        "password" => AuthMethod::Password(
            password
                .or_else(|| connection_id.as_deref().and_then(ssh_get_secret))
                .unwrap_or_default(),
        ),
        "publickey" => AuthMethod::PublicKey {
            path: key_path.ok_or_else(|| AppError::new("a key path is required"))?,
            passphrase: passphrase.or_else(|| connection_id.as_deref().and_then(ssh_get_secret)),
        },
        "agent" => AuthMethod::Agent,
        _ => return Err(AppError::new("unknown authentication method")),
    };
    let config = SshConfig {
        host,
        port,
        username,
        auth,
    };
    let known_hosts = ssh_known_hosts_path(&app)?;
    let seed = persist_key
        .as_ref()
        .and_then(|k| scrollback_dir(&app).and_then(|d| core_lib::scrollback_store::load(&d, k)));
    let (id, channels) = mgr.create_ssh(config, known_hosts, cols, rows, seed);

    // (a) Output relay -> `terminal-output`, identical to `terminal_create`.
    let rx = mgr.subscribe(id).map_err(AppError::new)?;
    {
        let app = app.clone();
        thread::spawn(move || {
            while let Ok(chunk) = rx.recv() {
                let _ = app.emit(
                    "terminal-output",
                    TerminalOutput {
                        session_id: id,
                        seq: chunk.seq,
                        data: chunk.bytes,
                    },
                );
            }
        });
    }

    // (b) Status relay -> `ssh-status`.
    {
        let app = app.clone();
        let mut status_rx = channels.status_rx;
        thread::spawn(move || {
            while let Some(s) = status_rx.blocking_recv() {
                let (phase, reason) = match s {
                    SshStatus::Connecting => ("connecting", None),
                    SshStatus::Ready => ("ready", None),
                    SshStatus::Failed(r) => ("failed", Some(r)),
                    SshStatus::Closed => ("closed", None),
                };
                let _ = app.emit(
                    "ssh-status",
                    SshStatusPayload {
                        id,
                        phase: phase.into(),
                        reason,
                    },
                );
            }
        });
    }

    // (c) Host-key prompt relay -> `ssh-hostkey-prompt`; stash the reply so
    //     `ssh_hostkey_decision` can answer it.
    {
        let app = app.clone();
        let pending = Arc::clone(&ssh.pending);
        let mut prompt_rx = channels.prompt_rx;
        thread::spawn(move || {
            while let Some(challenge) = prompt_rx.blocking_recv() {
                let HostKeyChallenge {
                    host,
                    port,
                    fingerprint,
                    reply,
                } = challenge;
                if let Ok(mut p) = pending.lock() {
                    p.insert(id, reply);
                }
                let _ = app.emit(
                    "ssh-hostkey-prompt",
                    HostKeyPromptPayload {
                        id,
                        host,
                        port,
                        fingerprint,
                    },
                );
            }
        });
    }

    if let Some(key) = persist_key {
        spawn_scrollback_flush(app, id, key);
    }

    Ok(id)
}

/// Answer a host-key prompt (TOFU). `accept=true` trusts and persists the key;
/// `false` rejects (the connect then fails). A missing entry (already answered or
/// the session was cancelled) is a no-op (review C2).
#[tauri::command]
pub fn ssh_hostkey_decision(ssh: State<'_, SshState>, id: u64, accept: bool) -> Result<(), AppError> {
    use core_lib::ssh::HostKeyDecision;
    let reply = ssh
        .pending
        .lock()
        .map_err(|_| AppError::new("ssh state unavailable"))?
        .remove(&id);
    if let Some(tx) = reply {
        let decision = if accept {
            HostKeyDecision::Accept
        } else {
            HostKeyDecision::Reject
        };
        // Send can fail if the connecting thread was cancelled meanwhile — that's
        // a normal closed prompt, not an error (review C2).
        let _ = tx.send(decision);
    }
    Ok(())
}

// ---- SSH secrets (OS keychain) ----
//
// Passwords and key passphrases live in the OS keychain keyed by the saved
// connection's id — never in `workspace.json` (review F8). There is **no
// plaintext fallback**: if the keychain is unavailable, storing fails and the UI
// falls back to a session-only (re-prompt each time) connection (review F9).

const SSH_KEYRING_SERVICE: &str = "claude-workbench-ssh";

/// Best-effort secret read for a connection id — `None` on any miss/error (the
/// connect path then proceeds without a stored secret).
fn ssh_get_secret(id: &str) -> Option<String> {
    keyring::Entry::new(SSH_KEYRING_SERVICE, id)
        .ok()?
        .get_password()
        .ok()
}

/// Store a connection's secret (password or key passphrase) in the OS keychain.
#[tauri::command]
pub fn ssh_store_secret(id: String, secret: String) -> Result<(), AppError> {
    let entry = keyring::Entry::new(SSH_KEYRING_SERVICE, &id)
        .map_err(|_| AppError::new("OS keychain is unavailable"))?;
    entry
        .set_password(&secret)
        .map_err(|_| AppError::new("could not save to the OS keychain (is a keyring service running?)"))
}

/// Delete a connection's stored secret. A missing entry is a no-op (so deleting a
/// connection without a stored secret still succeeds — review F9).
#[tauri::command]
pub fn ssh_delete_secret(id: String) -> Result<(), AppError> {
    let entry = keyring::Entry::new(SSH_KEYRING_SERVICE, &id)
        .map_err(|_| AppError::new("OS keychain is unavailable"))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err(AppError::new("could not delete the keychain secret")),
    }
}
