mod commands;

/// On Linux, align `GTK_IM_MODULE` with the input-method daemon that is actually
/// running before GTK initializes.
///
/// Why: a common desktop misconfiguration leaves `GTK_IM_MODULE=fcitx` in the
/// environment while `ibus` is the daemon actually running (or vice-versa).
/// WebKitGTK then loads an IM module that can't connect to any daemon, so CJK
/// (e.g. Hangul) composition silently fails in the webview even though it works
/// elsewhere. We detect the running daemon and override the IM env to match.
/// This only mutates *our* process environment, so the rest of the desktop is
/// untouched. Must run before any GTK init (GTK reads `GTK_IM_MODULE` once).
#[cfg(target_os = "linux")]
fn align_ime_module() {
    use std::fs;

    // Find the running IM daemon by scanning `/proc/<pid>/comm`.
    let mut daemon: Option<&str> = None;
    if let Ok(entries) = fs::read_dir("/proc") {
        for entry in entries.flatten() {
            if let Ok(comm) = fs::read_to_string(entry.path().join("comm")) {
                match comm.trim() {
                    "ibus-daemon" => {
                        daemon = Some("ibus");
                        break;
                    }
                    "fcitx5" | "fcitx" => {
                        daemon = Some("fcitx");
                        break;
                    }
                    _ => {}
                }
            }
        }
    }

    // Only override when the configured module disagrees with reality.
    if let Some(module) = daemon {
        let current = std::env::var("GTK_IM_MODULE").unwrap_or_default();
        if current != module {
            eprintln!("[ime] running daemon is {module}; GTK_IM_MODULE was '{current}' -> '{module}'");
            std::env::set_var("GTK_IM_MODULE", module);
            std::env::set_var("QT_IM_MODULE", module);
            std::env::set_var("XMODIFIERS", format!("@im={module}"));
        }
    }
}

/// Strip the Claude Code "nested session" environment markers so that every
/// `claude` we spawn in a PTY runs as a **fresh top-level session** — writing its
/// own `~/.claude/projects/<slug>/<uuid>.jsonl` transcript that the timeline tail
/// can follow.
///
/// Why: if this app is launched from inside a Claude session (e.g. while
/// dogfooding), the process inherits `CLAUDECODE=1`,
/// `CLAUDE_CODE_CHILD_SESSION=1`, and the parent's `CLAUDE_CODE_SESSION_ID`.
/// A `claude` spawned with those set behaves as a *child* of that session and
/// does **not** create a normal project transcript — so `find_session_jsonl`
/// finds nothing and the change timeline stays empty. The app orchestrates
/// Claude sessions; it must never present itself as a Claude child. Mutating our
/// own process env here is safe (children inherit the cleaned env); a normally
/// launched app has none of these set, so this is a no-op there.
fn strip_nested_claude_env() {
    for key in [
        "CLAUDECODE",
        "CLAUDE_CODE_CHILD_SESSION",
        "CLAUDE_CODE_SESSION_ID",
        "CLAUDE_CODE_ENTRYPOINT",
    ] {
        std::env::remove_var(key);
    }
}

/// Build and run the Tauri application.
///
/// Registers the dialog plugin (folder picker) and the shell + terminal + ACP
/// commands, all thin wrappers over the `core`/`core-acp` crates.
// Ensures the main-window close backstop arms its force-quit timer only once,
// however many times the (wedged, still-visible) window's close is requested.
static CLOSE_BACKSTOP_ARMED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Required for Korean/CJK composition in the webview (confirmed: without it
    // Hangul doesn't compose at all). The input *duplication* is handled at the
    // xterm/onData layer in ClaudeTermPanel, not here.
    #[cfg(target_os = "linux")]
    align_ime_module();
    strip_nested_claude_env();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(core_lib::SessionManager::new())
        .manage(commands::ClaudeState::default())
        .manage(commands::SshState::default())
        .manage(commands::ScrollbackState::default())
        .invoke_handler(tauri::generate_handler![
            commands::read_dir,
            commands::detect_project_types,
            commands::save_state,
            commands::load_state,
            commands::terminal_create,
            commands::terminal_write,
            commands::terminal_resize,
            commands::terminal_snapshot,
            commands::terminal_close,
            commands::ssh_create,
            commands::ssh_hostkey_decision,
            commands::ssh_store_secret,
            commands::ssh_delete_secret,
            commands::scrollback_set_enabled,
            commands::claude_open_or_attach,
            commands::claude_write,
            commands::claude_resize,
            commands::claude_set_driver,
            commands::claude_detach,
            commands::claude_live_uuids,
            commands::claude_session_cwds,
            commands::claude_close,
            commands::claude_sessions,
            commands::claude_session_snapshot,
            commands::claude_session_chain,
            commands::generate_task_summary,
            commands::save_task_summary,
            commands::claude_set_task_meta,
            commands::claude_rename,
            commands::claude_delete,
            commands::acp_read_file,
            commands::write_file,
            commands::delete_path,
            commands::git_status,
            commands::git_branches,
            commands::git_checkout,
            commands::git_create_branch,
            commands::git_stage,
            commands::git_stage_all,
            commands::git_unstage,
            commands::git_commit,
            commands::git_push,
            commands::git_log,
            commands::git_merge,
            commands::git_fetch,
            commands::git_pull,
            commands::git_discard,
            commands::git_delete_branch,
            commands::git_rename_branch,
            commands::git_revert,
            commands::git_revert_abort,
            commands::git_revert_continue,
            commands::git_head_message,
            commands::git_reword,
            commands::git_uncommit,
            commands::git_stash_list,
            commands::git_stash_save,
            commands::git_stash_pop,
            commands::git_worktrees,
            commands::git_worktree_add,
            commands::git_worktree_remove,
            commands::git_diff,
            commands::git_roots,
            commands::git_show,
            commands::git_commit_files,
            commands::git_commit_file_diff,
            commands::git_commit_file_content,
            commands::git_tags,
            commands::git_create_tag,
            commands::git_delete_tag,
            commands::git_merge_abort,
            commands::git_merge_continue,
            commands::git_resolve_ours,
            commands::git_resolve_theirs,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            use tauri::Manager;
            match event {
                // Normal quit (last window closed / OS quit): kill every PTY child
                // so no orphaned `claude`/shell process lingers after exit. The
                // window-close itself is driven by the frontend (`win.destroy()`);
                // this only guarantees clean child teardown on the way out.
                tauri::RunEvent::ExitRequested { .. } => {
                    app_handle.state::<core_lib::SessionManager>().kill_all();
                }
                // Main window gone = the app should quit — even if a popout
                // teardown stalled and left other windows alive. Without this,
                // `ExitRequested` only fires when the *last* window closes, so a
                // hung shutdown that force-destroys only the main window would
                // leave the process (and popouts) running. exit(0) force-quits
                // everything; kill_all() reaps children first.
                tauri::RunEvent::WindowEvent {
                    label,
                    event: tauri::WindowEvent::Destroyed,
                    ..
                } if label == "main" => {
                    app_handle.state::<core_lib::SessionManager>().kill_all();
                    app_handle.exit(0);
                }
                // Hard backstop for the X button: the frontend intercepts the close
                // (preventDefault) to tear sessions down, then `destroy()`s the
                // window — which fires `Destroyed` above and exits. But if the
                // WebView's JS loop freezes mid-teardown, neither `destroy()` nor its
                // watchdog timer runs and the window can never close. So once the
                // main window's close is requested, force-quit after a grace period
                // regardless of the WebView's state. The graceful path normally wins
                // first (the process is already gone before this fires); this only
                // bites when the frontend is wedged. `kill_all` reaps PTY children.
                tauri::RunEvent::WindowEvent {
                    label,
                    event: tauri::WindowEvent::CloseRequested { .. },
                    ..
                } if label == "main" => {
                    // Arm exactly once: repeated X clicks (the window is still up
                    // while wedged) must not pile up timers.
                    if !CLOSE_BACKSTOP_ARMED.swap(true, std::sync::atomic::Ordering::SeqCst) {
                        let h = app_handle.clone();
                        std::thread::spawn(move || {
                            std::thread::sleep(std::time::Duration::from_secs(5));
                            // kill_all is non-blocking (signals children, no join,
                            // poison-tolerant) so it can't wedge this thread; it
                            // reaps PTY children so none are orphaned.
                            h.state::<core_lib::SessionManager>().kill_all();
                            // process::exit, NOT AppHandle::exit: the latter routes
                            // through the (possibly wedged) event loop — the very
                            // thing we're escaping. This terminates at the OS level
                            // immediately and can't hang.
                            std::process::exit(0);
                        });
                    }
                }
                _ => {}
            }
        });
}
