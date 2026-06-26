// ---- Git panel (G1) — thin wrappers over core_lib::git (system `git` CLI) ----

use super::AppError;

/// Working-tree status for `cwd` (infallible — non-repo yields `is_repo: false`).
#[tauri::command]
pub fn git_status(cwd: String) -> core_lib::git::GitStatus {
    core_lib::git::status(&cwd)
}

/// Local branches + current.
#[tauri::command]
pub fn git_branches(cwd: String) -> Result<core_lib::git::Branches, AppError> {
    core_lib::git::branches(&cwd).map_err(AppError::new)
}

/// Switch to an existing branch.
#[tauri::command]
pub fn git_checkout(cwd: String, branch: String) -> Result<(), AppError> {
    core_lib::git::checkout(&cwd, &branch).map(|_| ()).map_err(AppError::new)
}

/// Create and switch to a new branch.
#[tauri::command]
pub fn git_create_branch(cwd: String, name: String) -> Result<(), AppError> {
    core_lib::git::create_branch(&cwd, &name).map(|_| ()).map_err(AppError::new)
}

/// Stage one path.
#[tauri::command]
pub fn git_stage(cwd: String, path: String) -> Result<(), AppError> {
    core_lib::git::stage(&cwd, &path).map(|_| ()).map_err(AppError::new)
}

/// Stage all changes.
#[tauri::command]
pub fn git_stage_all(cwd: String) -> Result<(), AppError> {
    core_lib::git::stage_all(&cwd).map(|_| ()).map_err(AppError::new)
}

/// Unstage one path.
#[tauri::command]
pub fn git_unstage(cwd: String, path: String) -> Result<(), AppError> {
    core_lib::git::unstage(&cwd, &path).map(|_| ()).map_err(AppError::new)
}

/// Commit staged changes with `message`. Returns git's stdout for feedback.
#[tauri::command]
pub fn git_commit(cwd: String, message: String) -> Result<String, AppError> {
    core_lib::git::commit(&cwd, &message).map_err(AppError::new)
}

/// Push the current branch (sets upstream on `origin` if none). Explicit user
/// action only — never called automatically.
#[tauri::command]
pub fn git_push(cwd: String) -> Result<String, AppError> {
    core_lib::git::push(&cwd).map_err(AppError::new)
}

/// Recent commits across all refs (newest first) for the history graph.
#[tauri::command]
pub fn git_log(
    cwd: String,
    limit: Option<u32>,
    order: Option<String>,
    git_ref: Option<String>,
) -> Result<Vec<core_lib::git::Commit>, AppError> {
    core_lib::git::log(
        &cwd,
        limit.unwrap_or(200),
        order.as_deref().unwrap_or("date"),
        git_ref.as_deref(),
    )
    .map_err(AppError::new)
}

// ---- Git GP3 (actions) + GP4 (worktrees) ----

#[tauri::command]
pub fn git_merge(cwd: String, branch: String) -> Result<String, AppError> {
    core_lib::git::merge(&cwd, &branch).map_err(AppError::new)
}

#[tauri::command]
pub fn git_fetch(cwd: String) -> Result<String, AppError> {
    core_lib::git::fetch(&cwd).map_err(AppError::new)
}

#[tauri::command]
pub fn git_pull(cwd: String) -> Result<String, AppError> {
    core_lib::git::pull(&cwd).map_err(AppError::new)
}

#[tauri::command]
pub fn git_discard(cwd: String, path: String) -> Result<(), AppError> {
    core_lib::git::discard(&cwd, &path).map(|_| ()).map_err(AppError::new)
}

#[tauri::command]
pub fn git_delete_branch(cwd: String, name: String, force: bool) -> Result<String, AppError> {
    core_lib::git::delete_branch(&cwd, &name, force).map_err(AppError::new)
}

#[tauri::command]
pub fn git_rename_branch(cwd: String, old: String, new: String) -> Result<String, AppError> {
    core_lib::git::rename_branch(&cwd, &old, &new).map_err(AppError::new)
}

/// Revert a commit (new undo commit). UI confirms first.
#[tauri::command]
pub fn git_revert(cwd: String, hash: String) -> Result<String, AppError> {
    core_lib::git::revert(&cwd, &hash).map_err(AppError::new)
}

/// Abort an in-progress revert.
#[tauri::command]
pub fn git_revert_abort(cwd: String) -> Result<String, AppError> {
    core_lib::git::revert_abort(&cwd).map_err(AppError::new)
}

/// Conclude a revert after conflicts are resolved + staged.
#[tauri::command]
pub fn git_revert_continue(cwd: String) -> Result<String, AppError> {
    core_lib::git::revert_continue(&cwd).map_err(AppError::new)
}

/// The HEAD commit's full message — prefills the reword editor.
#[tauri::command]
pub fn git_head_message(cwd: String) -> Result<String, AppError> {
    core_lib::git::head_message(&cwd).map_err(AppError::new)
}

/// A specific commit's full message — prefills the past-commit reword editor.
#[tauri::command]
pub fn git_commit_message(cwd: String, hash: String) -> Result<String, AppError> {
    core_lib::git::commit_message(&cwd, &hash).map_err(AppError::new)
}

/// Reword HEAD with a full multi-line message (editor path). UI confirms first.
#[tauri::command]
pub fn git_reword(cwd: String, hash: String, message: String) -> Result<String, AppError> {
    core_lib::git::reword(&cwd, &hash, &message).map_err(AppError::new)
}

/// Undo the last commit, keeping changes staged (reset --soft). `hash` is the
/// clicked commit; the backend verifies it is HEAD. UI confirms first.
#[tauri::command]
pub fn git_uncommit(cwd: String, hash: String) -> Result<String, AppError> {
    core_lib::git::uncommit(&cwd, &hash).map_err(AppError::new)
}

/// Reset the current branch to `hash` (soft|mixed|hard). Creates a backup ref first
/// (returned for recovery). `hard` is destructive — UI strong-confirms first.
#[tauri::command]
pub fn git_reset_to(
    cwd: String,
    hash: String,
    mode: String,
) -> Result<core_lib::git::ResetResult, AppError> {
    core_lib::git::reset_to(&cwd, &hash, &mode).map_err(AppError::new)
}

/// Reword a PAST (non-HEAD) commit's message via commit-tree replay + CAS — never
/// touches the working tree. Creates a backup ref first (returned for recovery).
/// History rewrite — UI strong-confirms first. `message` is the full new message.
#[tauri::command]
pub fn git_reword_past(
    cwd: String,
    hash: String,
    message: String,
) -> Result<core_lib::git::RewordResult, AppError> {
    core_lib::git::reword_past(&cwd, &hash, &message).map_err(AppError::new)
}

#[tauri::command]
pub fn git_stash_list(cwd: String) -> Result<Vec<String>, AppError> {
    core_lib::git::stash_list(&cwd).map_err(AppError::new)
}

#[tauri::command]
pub fn git_stash_save(cwd: String, message: String) -> Result<String, AppError> {
    core_lib::git::stash_save(&cwd, &message).map_err(AppError::new)
}

#[tauri::command]
pub fn git_stash_pop(cwd: String) -> Result<String, AppError> {
    core_lib::git::stash_pop(&cwd).map_err(AppError::new)
}

#[tauri::command]
pub fn git_worktrees(cwd: String) -> Result<Vec<core_lib::git::Worktree>, AppError> {
    core_lib::git::worktrees(&cwd).map_err(AppError::new)
}

#[tauri::command]
pub fn git_worktree_add(cwd: String, path: String, branch: String) -> Result<String, AppError> {
    core_lib::git::worktree_add(&cwd, &path, &branch).map_err(AppError::new)
}

#[tauri::command]
pub fn git_worktree_remove(cwd: String, path: String) -> Result<String, AppError> {
    core_lib::git::worktree_remove(&cwd, &path).map_err(AppError::new)
}

#[tauri::command]
pub fn git_diff(cwd: String, path: String, staged: bool) -> Result<String, AppError> {
    core_lib::git::diff(&cwd, &path, staged).map_err(AppError::new)
}

/// Discover git roots under `cwd` (enclosing repo + nested repos) for the GitPanel
/// root selector. Never fails — an unreadable/non-repo tree yields an empty list.
#[tauri::command]
pub fn git_roots(cwd: String) -> Vec<core_lib::git::GitRoot> {
    core_lib::git::git_roots(&cwd)
}

#[tauri::command]
pub fn git_show(cwd: String, hash: String) -> Result<String, AppError> {
    core_lib::git::show(&cwd, &hash).map_err(AppError::new)
}

/// Files a commit changed (path + status) — the git history viewer's file list.
#[tauri::command]
pub fn git_commit_files(cwd: String, hash: String) -> Result<Vec<core_lib::git::CommitFile>, AppError> {
    core_lib::git::commit_files(&cwd, &hash).map_err(AppError::new)
}

/// Unified diff for one file in one commit — the history viewer's per-file view.
#[tauri::command]
pub fn git_commit_file_diff(cwd: String, hash: String, path: String) -> Result<String, AppError> {
    core_lib::git::commit_file_diff(&cwd, &hash, &path).map_err(AppError::new)
}

/// A file's full content at a commit — the history viewer's "원본 보기" toggle.
#[tauri::command]
pub fn git_commit_file_content(cwd: String, hash: String, path: String) -> Result<String, AppError> {
    core_lib::git::commit_file_content(&cwd, &hash, &path).map_err(AppError::new)
}

#[tauri::command]
pub fn git_tags(cwd: String) -> Result<Vec<String>, AppError> {
    core_lib::git::tags(&cwd).map_err(AppError::new)
}

#[tauri::command]
pub fn git_create_tag(cwd: String, name: String, message: String) -> Result<String, AppError> {
    core_lib::git::create_tag(&cwd, &name, &message).map_err(AppError::new)
}

#[tauri::command]
pub fn git_delete_tag(cwd: String, name: String) -> Result<String, AppError> {
    core_lib::git::delete_tag(&cwd, &name).map_err(AppError::new)
}

#[tauri::command]
pub fn git_merge_abort(cwd: String) -> Result<String, AppError> {
    core_lib::git::merge_abort(&cwd).map_err(AppError::new)
}

#[tauri::command]
pub fn git_merge_continue(cwd: String) -> Result<String, AppError> {
    core_lib::git::merge_continue(&cwd).map_err(AppError::new)
}

#[tauri::command]
pub fn git_resolve_ours(cwd: String, path: String) -> Result<String, AppError> {
    core_lib::git::resolve_ours(&cwd, &path).map_err(AppError::new)
}

#[tauri::command]
pub fn git_resolve_theirs(cwd: String, path: String) -> Result<String, AppError> {
    core_lib::git::resolve_theirs(&cwd, &path).map_err(AppError::new)
}
