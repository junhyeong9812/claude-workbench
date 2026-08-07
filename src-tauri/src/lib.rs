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
        .plugin(tauri_plugin_notification::init())
        .manage(core_lib::SessionManager::new())
        .manage(commands::claude::runtime::ClaudeState::default())
        .manage(commands::ssh::SshState::default())
        .manage(commands::ScrollbackState::default())
        .manage(commands::codex::CodexState::default())
        .invoke_handler(tauri::generate_handler![
            commands::files::read_dir,
            commands::files::detect_project_types,
            commands::files::detect_run_targets,
            commands::files::mirror_test_path,
            commands::files::search_files,
            commands::files::search_content,
            commands::files::save_state,
            commands::files::load_state,
            commands::terminal::terminal_create,
            commands::terminal::terminal_write,
            commands::terminal::terminal_resize,
            commands::terminal::terminal_snapshot,
            commands::terminal::terminal_close,
            // codex 세션은 스폰만 전용이고 write/resize/snapshot/close는 위의
            // terminal_* 를 그대로 쓴다 (순수 터미널 탭 — claude 커맨드 표면과
            // 접점 없음).
            commands::codex::codex_create,
            // 읽기 전용 rollout 타임라인 (작업③). 프론트가 주기 조회한다 —
            // claude의 tail 스레드·라이브 이벤트 계약과 접점 없음.
            commands::codex::codex_timeline_snapshot,
            commands::ssh::ssh_create,
            commands::ssh::ssh_hostkey_decision,
            commands::ssh::ssh_store_secret,
            commands::ssh::ssh_delete_secret,
            commands::terminal::scrollback_set_enabled,
            commands::claude::runtime::claude_open_or_attach,
            commands::claude::runtime::claude_write,
            commands::claude::runtime::claude_resize,
            commands::claude::runtime::claude_set_driver,
            commands::claude::runtime::claude_detach,
            commands::claude::runtime::claude_live_uuids,
            commands::claude::runtime::claude_session_cwds,
            commands::claude::runtime::claude_close,
            commands::claude::store::claude_sessions,
            commands::claude::store::claude_external_sessions,
            commands::claude::store::claude_item_detail,
            commands::claude::store::claude_session_snapshot,
            commands::memo::memo_read,
            commands::memo::memo_write,
            commands::refine::prompt_refine_workdir,
            commands::refine::refine_memo_delete,
            commands::refine::refine_memo_read,
            commands::refine::refine_memo_write,
            commands::refine::run_codex_check,
            commands::archive::archive_session,
            commands::archive::archive_list,
            commands::archive::archive_open_path,
            commands::archive::archive_status,
            commands::archive::archive_in_flight,
            commands::graph::graph_generate,
            commands::graph::graph_list,
            commands::graph::graph_marked_folders,
            commands::graph::graph_open_path,
            commands::claude::store::claude_rename,
            commands::claude::store::claude_delete,
            commands::files::acp_read_file,
            commands::files::write_file,
            commands::files::delete_path,
            commands::files::create_file,
            commands::files::create_dir,
            commands::files::rename_path,
            commands::files::copy_path,
            commands::files::import_paths,
            commands::git::git_status,
            commands::git::git_branches,
            commands::git::git_checkout,
            commands::git::git_create_branch,
            commands::git::git_stage,
            commands::git::git_stage_all,
            commands::git::git_unstage,
            commands::git::git_commit,
            commands::git::git_push,
            commands::git::git_log,
            commands::git::git_merge,
            commands::git::git_fetch,
            commands::git::git_pull,
            commands::git::git_discard,
            commands::git::git_delete_branch,
            commands::git::git_rename_branch,
            commands::git::git_revert,
            commands::git::git_revert_abort,
            commands::git::git_revert_continue,
            commands::git::git_head_message,
            commands::git::git_commit_message,
            commands::git::git_reword,
            commands::git::git_uncommit,
            commands::git::git_reset_to,
            commands::git::git_reword_past,
            commands::git::git_stash_list,
            commands::git::git_stash_save,
            commands::git::git_stash_pop,
            commands::git::git_worktrees,
            commands::git::git_worktree_add,
            commands::git::git_worktree_remove,
            commands::git::git_diff,
            commands::git::git_roots,
            commands::git::git_show,
            commands::git::git_commit_files,
            commands::git::git_commit_file_diff,
            commands::git::git_commit_file_content,
            commands::git::git_tags,
            commands::git::git_create_tag,
            commands::git::git_delete_tag,
            commands::git::git_merge_abort,
            commands::git::git_merge_continue,
            commands::git::git_resolve_ours,
            commands::git::git_resolve_theirs,
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
