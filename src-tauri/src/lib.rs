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
            commands::claude_start,
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
            commands::git_stash_list,
            commands::git_stash_save,
            commands::git_stash_pop,
            commands::git_worktrees,
            commands::git_worktree_add,
            commands::git_worktree_remove,
            commands::git_diff,
            commands::git_show,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
